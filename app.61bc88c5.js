// ═══════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════
const state = {
  currentDate: todayStr(),
  section: 'all',
  period: 'this-week',
  search: '',
  model: 'all',
  allCards: [],
  loading: false,
};

// Keywords matched against headline + summary + foryou (case-insensitive)
const MODEL_KEYWORDS = {
  gpt:      ['chatgpt', 'gpt-4', 'gpt-5', 'gpt4', 'gpt5', 'o1', 'o3', 'o4', 'openai'],
  claude:   ['claude', 'sonnet', 'haiku', 'opus', 'anthropic'],
  gemini:   ['gemini', 'bard', 'google deepmind'],
  llama:    ['llama', 'meta ai', 'meta llama'],
  deepseek: ['deepseek', 'deep seek'],
  grok:     ['grok', 'xai', 'x.ai'],
  mistral:  ['mistral', 'devstral', 'mixtral', 'codestral'],
};

// Cache: date string → array of cards
const dataCache = {};

// Manifest: dates that have data files (loaded once from /data/index.json)
// null = not yet fetched; [] = failed or empty
let availableDates = null;
let availableDatesFetchedAt = 0;

const INDEX_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;

// ═══════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtDate(str) {
  // "2026-05-22" → "Fri, May 22"
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Dates in [start, end] inclusive
function dateRange(start, end) {
  const dates = [];
  let cur = start;
  while (cur <= end) { dates.push(cur); cur = addDays(cur, 1); }
  return dates;
}

// ISO-week helpers (Monday = start of week)
function getMondayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = (day === 0) ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function getThisWeekRange() {
  return dateRange(getMondayOfWeek(todayStr()), todayStr());
}

function getLastWeekRange() {
  const thisMonday = getMondayOfWeek(todayStr());
  const lastSunday = addDays(thisMonday, -1);
  const lastMonday = addDays(thisMonday, -7);
  return dateRange(lastMonday, lastSunday);
}

function getThisMonthRange() {
  const today = todayStr();
  const firstOfMonth = today.slice(0, 7) + '-01';
  return dateRange(firstOfMonth, today);
}

function searchableText(c) {
  if (!c._text) {
    c._text = [c.headline, c.summary, c.foryou].filter(Boolean).join(' ').toLowerCase();
  }
  return c._text;
}

async function fetchJson(path, options = {}) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(path, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(tid);
  }
}

// ═══════════════════════════════════════════════════════════
//  Manifest
// ═══════════════════════════════════════════════════════════
async function loadIndex({ force = false } = {}) {
  const fresh = Date.now() - availableDatesFetchedAt < INDEX_TTL_MS;
  if (!force && availableDates !== null && fresh) return availableDates;
  try {
    const idx  = await fetchJson('/data/index.json', { cache: 'no-cache' });
    availableDates = Array.isArray(idx.dates) ? idx.dates : [];
    availableDatesFetchedAt = Date.now();
  } catch {
    if (availableDates === null) availableDates = []; // graceful degradation — skip manifest, try nothing
  }
  return availableDates;
}

// ═══════════════════════════════════════════════════════════
//  Data fetching
// ═══════════════════════════════════════════════════════════
async function fetchDay(dateStr, { cacheMiss = true } = {}) {
  if (dateStr in dataCache) return dataCache[dateStr];
  try {
    const cacheMode = dateStr >= todayStr() ? 'no-cache' : 'default';
    const cards = await fetchJson(`/data/${dateStr}.json`, { cache: cacheMode });
    cards.forEach(searchableText);
    dataCache[dateStr] = cards;
    return cards;
  } catch {
    if (cacheMiss) dataCache[dateStr] = [];
    return [];
  }
}

// Incremented on every load; stale async completions compare and bail out
let _loadId = 0;

async function loadCurrentView() {
  const myId = ++_loadId;
  state.loading = true;
  renderGrid();

  let cards = [];
  try {
    const index  = await loadIndex({ force: state.period === 'today' });

    // Build the candidate date range for the selected period
    let wantDates;
    if (state.period === 'today') {
      wantDates = [state.currentDate];
    } else if (state.period === 'this-week') {
      wantDates = getThisWeekRange();
    } else if (state.period === 'last-week') {
      wantDates = getLastWeekRange();
    } else if (state.period === 'this-month') {
      wantDates = getThisMonthRange();
    } else if (state.period === 'all') {
      // Use the manifest directly — no need to generate all calendar dates
      wantDates = [...index];
    } else {
      wantDates = [];
    }

    // Filter to only dates confirmed in the manifest.
    // Exception: 'today' always tries even if not yet in the index
    // (the daily job may have just run but index not re-fetched yet).
    const indexSet = new Set(index);
    const toFetch  = state.period === 'today'
      ? wantDates
      : wantDates.filter(d => indexSet.has(d));

    const results = await Promise.all(
      toFetch.map(d => fetchDay(d, { cacheMiss: state.period !== 'today' }))
    );
    cards = results.flat();
  } catch {
    cards = [];
  } finally {
    if (myId === _loadId) {
      state.allCards = cards;
      state.loading  = false;
      renderGrid();
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  Filtering
// ═══════════════════════════════════════════════════════════
function applyFilters(cards) {
  let out = cards;

  // Section
  if (state.section !== 'all') {
    out = out.filter(c => c.section === state.section);
  }

  // Model keyword filter — uses precomputed _text (lowercase, set on fetch)
  if (state.model !== 'all') {
    const keywords = MODEL_KEYWORDS[state.model] || [];
    out = out.filter(c => keywords.some(kw => searchableText(c).includes(kw)));
  }

  // Search
  const q = state.search.trim().toLowerCase();
  if (q) {
    out = out.filter(c => searchableText(c).includes(q));
  }

  return out;
}

// ═══════════════════════════════════════════════════════════
//  Highlighting
// ═══════════════════════════════════════════════════════════
function hl(text) {
  if (!text) return '';
  const q = state.search.trim();
  if (!q) return esc(text);
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
  // Run regex on raw text then escape each piece — avoids broken matches on &, <, > etc.
  return text.replace(re, '\x00$1\x01')
             .split(/[\x00\x01]/)
             .map((chunk, i) => i % 2 === 0 ? esc(chunk) : `<mark>${esc(chunk)}</mark>`)
             .join('');
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function safeUrl(u) {
  try { return ['http:', 'https:'].includes(new URL(u).protocol) ? u : '#'; }
  catch { return '#'; }
}

// ═══════════════════════════════════════════════════════════
//  Card rendering
// ═══════════════════════════════════════════════════════════
const SECTION_META = {
  models:   { label: 'Models',   accentClass: 'ca-m', badgeClass: 'badge-m', icon: 'ti-cpu' },
  industry: { label: 'Industry', accentClass: 'ca-i', badgeClass: 'badge-i', icon: 'ti-building' },
  tips:     { label: 'Tips',     accentClass: 'ca-t', badgeClass: 'badge-t', icon: 'ti-bulb' },
};

// Map raw source strings → pill class + display label
function sourcePill(src) {
  if (!src) return '';
  const s = src.toLowerCase();
  let cls, label, icon;
  if (s.includes('tldr')) {
    cls = 'src-tldr'; label = 'TLDR AI'; icon = 'ti-bolt';
  } else if (s.includes('semafor')) {
    cls = 'src-semafor'; label = 'Semafor'; icon = 'ti-news';
  } else {
    cls = 'src-web'; label = esc(src); icon = 'ti-world';
  }
  return `<span class="source-pill ${cls}"><i class="ti ${icon}"></i>${label}</span>`;
}

function renderCard(c) {
  const meta = SECTION_META[c.section] || SECTION_META['industry'];
  const showForyou = (c.section === 'models' || c.section === 'tips') && c.foryou;
  const showSpecs  = c.section === 'models' && c.specs && c.specs.length > 0;

  const foryouHtml = showForyou ? `
    <div class="card-foryou">
      <span class="foryou-label">For you</span>
      <span>${hl(c.foryou)}</span>
    </div>` : '';

  const specsHtml = showSpecs ? `
    <details class="specs">
      <summary><i class="ti ti-table"></i>&nbsp;Specs&nbsp;<i class="ti ti-chevron-down"></i></summary>
      <div class="specs-grid">
        ${c.specs.map(s => `
          <div class="spec-row">
            <span class="spec-label">${esc(s.label)}</span>
            <span class="spec-value"><em>${esc(s.value)}</em></span>
          </div>`).join('')}
      </div>
    </details>` : '';

  // Date display (use card's own date if present, else current nav date)
  const cardDate = c.date ? fmtDate(c.date) : fmtDate(state.currentDate);

  return `
    <article class="card">
      <div class="card-accent ${meta.accentClass}"></div>
      <div class="card-body">
        <span class="card-badge ${meta.badgeClass}">
          <i class="ti ${meta.icon}"></i>${meta.label}
        </span>
        <h2 class="card-headline">${hl(c.headline)}</h2>
        <p class="card-summary">${hl(c.summary)}</p>
        ${foryouHtml}
        ${specsHtml}
        <div class="card-footer">
          <span class="src-tag">${sourcePill(c.source)}<span>${cardDate}</span></span>
          ${c.url ? `<a href="${esc(safeUrl(c.url))}" class="card-link" target="_blank" rel="noopener">
            Read <i class="ti ti-external-link"></i></a>` : ''}
        </div>
      </div>
    </article>`;
}

// ═══════════════════════════════════════════════════════════
//  Render everything
// ═══════════════════════════════════════════════════════════
function renderGrid() {
  const grid = document.getElementById('cardGrid');
  const bar  = document.getElementById('resultBar');

  if (state.loading) {
    grid.innerHTML = `<div class="state-msg"><div class="spinner"></div><p>Loading…</p></div>`;
    bar.textContent = '';
    return;
  }

  const filtered = applyFilters(state.allCards);

  if (state.allCards.length === 0) {
    const emptyLabel = {
      today:        `No data for ${fmtDate(state.currentDate)}`,
      'this-week':  'No data for this week',
      'last-week':  'No data for last week',
      'this-month': 'No data for this month',
      all:          'No data available yet',
    }[state.period] ?? 'No data available';
    const emptyHint = state.period === 'today'
      ? 'Try a different date or check back later.'
      : 'Data may still be processing — check back soon.';
    grid.innerHTML = `
      <div class="state-msg">
        <i class="ti ti-calendar-off"></i>
        <strong>${emptyLabel}</strong>
        <p>${emptyHint}</p>
      </div>`;
    bar.textContent = '';
    return;
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="state-msg">
        <i class="ti ti-search-off"></i>
        <strong>No results</strong>
        <p>Try adjusting your search or filters.</p>
      </div>`;
    bar.innerHTML = '';
    return;
  }

  grid.innerHTML = filtered.map(renderCard).join('');
  bar.textContent = `${filtered.length} ${filtered.length === 1 ? 'story' : 'stories'}${state.search ? ` matching "${state.search}"` : ''}`;
}

// ═══════════════════════════════════════════════════════════
//  Date nav
// ═══════════════════════════════════════════════════════════
function updateDateUI() {
  const lbl  = document.getElementById('dateLabel');
  const prev = document.getElementById('prevDay');
  const next = document.getElementById('nextDay');

  const today = todayStr();
  lbl.textContent = state.currentDate === today ? 'Today' : fmtDate(state.currentDate);
  next.disabled = state.currentDate >= today;
}

document.getElementById('prevDay').addEventListener('click', () => {
  state.currentDate = addDays(state.currentDate, -1);
  updateDateUI();
  if (state.period === 'today') loadCurrentView();
});
document.getElementById('nextDay').addEventListener('click', () => {
  if (state.currentDate < todayStr()) {
    state.currentDate = addDays(state.currentDate, 1);
    updateDateUI();
    if (state.period === 'today') loadCurrentView();
  }
});
document.getElementById('dateLabel').addEventListener('click', () => {
  state.currentDate = todayStr();
  updateDateUI();
  if (state.period === 'today') loadCurrentView();
});

// ═══════════════════════════════════════════════════════════
//  Section filter
// ═══════════════════════════════════════════════════════════
document.querySelectorAll('.section-group .pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.section-group .pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.section = btn.dataset.section;
    renderGrid();
  });
});

// ═══════════════════════════════════════════════════════════
//  Period filter
// ═══════════════════════════════════════════════════════════
document.querySelectorAll('.filter-group.period .pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-group.period .pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.period = btn.dataset.period;
    // Switching to "Today" always snaps back to the actual current date
    if (state.period === 'today') state.currentDate = todayStr();
    const isToday = state.period === 'today';
    document.querySelector('.date-nav').style.opacity = isToday ? '1' : '.35';
    document.querySelector('.date-nav').style.pointerEvents = isToday ? '' : 'none';
    updateDateUI();
    loadCurrentView();
  });
});

// ═══════════════════════════════════════════════════════════
//  Model filter
// ═══════════════════════════════════════════════════════════
document.querySelectorAll('.model-group .pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.model-group .pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.model = btn.dataset.model;
    renderGrid();
  });
});

// ═══════════════════════════════════════════════════════════
//  Search
// ═══════════════════════════════════════════════════════════
let searchTimer;
document.getElementById('searchInput').addEventListener('input', e => {
  state.search = e.target.value;   // update state immediately so other renders see it
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderGrid, 200);  // debounce only the DOM update
});

// ═══════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════
// Date nav is only interactive in "Today" mode
document.querySelector('.date-nav').style.opacity = '0.35';
document.querySelector('.date-nav').style.pointerEvents = 'none';
updateDateUI();
loadCurrentView();

// Service worker handling — SW v4 caused fetch hangs (CSP + clone() interaction).
// sw.js is now a self-destruct stub (v5) that clears caches and unregisters itself.
// The message listener below handles the race: if v5 activates mid-load it tells
// us to reload so we get clean fetches without any SW in the way.
if ('serviceWorker' in navigator) {
  // Listen for v5 self-destruct signal — reload once to get a clean SW-free page
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data && event.data.type === 'SW_SELF_DESTRUCT') {
      window.location.reload();
    }
  });
  // Also eagerly unregister any stale registrations (belt + suspenders)
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(r => r.unregister());
  });
}
