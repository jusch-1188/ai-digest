// ═══════════════════════════════════════════════════════════
//  State
// ═══════════════════════════════════════════════════════════
const state = {
  currentDate: todayStr(),
  section: 'all',
  period: 'all',
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

// ═══════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════
function todayStr() {
  return new Date().toISOString().slice(0, 10);
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

// ═══════════════════════════════════════════════════════════
//  Manifest
// ═══════════════════════════════════════════════════════════
async function loadIndex() {
  if (availableDates !== null) return availableDates;
  try {
    const res = await fetch('/data/index.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const idx = await res.json();
    availableDates = Array.isArray(idx.dates) ? idx.dates : [];
  } catch {
    availableDates = []; // graceful degradation — fall back to trying all dates
  }
  return availableDates;
}

// ═══════════════════════════════════════════════════════════
//  Data fetching
// ═══════════════════════════════════════════════════════════
async function fetchDay(dateStr) {
  if (dateStr in dataCache) return dataCache[dateStr];
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 6000);
    const res  = await fetch(`/data/${dateStr}.json`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cards = await res.json();
    dataCache[dateStr] = cards;
    return cards;
  } catch {
    dataCache[dateStr] = [];
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
    const today  = todayStr();
    const index  = await loadIndex();

    // Build the candidate date range for the selected period
    let wantDates;
    if (state.period === 'today') {
      wantDates = [state.currentDate];
    } else if (state.period === 'all' || state.period === 'week') {
      wantDates = dateRange(addDays(today, -6), today);
    } else if (state.period === 'month') {
      wantDates = dateRange(addDays(today, -29), today);
    } else {
      wantDates = [];
    }

    // Filter to only dates confirmed in the manifest.
    // Exception: 'today' always tries even if not yet in the index
    // (the daily job may have just run but index not re-fetched yet).
    const toFetch = state.period === 'today'
      ? wantDates
      : wantDates.filter(d => index.includes(d));

    const results = await Promise.all(toFetch.map(fetchDay));
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
function cardText(c) {
  return [c.headline, c.summary, c.foryou].filter(Boolean).join(' ').toLowerCase();
}

function applyFilters(cards) {
  let out = cards;

  // Section
  if (state.section !== 'all') {
    out = out.filter(c => c.section === state.section);
  }

  // Model keyword filter
  if (state.model !== 'all') {
    const keywords = MODEL_KEYWORDS[state.model] || [];
    out = out.filter(c => {
      const text = cardText(c);
      return keywords.some(kw => text.includes(kw.toLowerCase()));
    });
  }

  // Search
  const q = state.search.trim().toLowerCase();
  if (q) {
    out = out.filter(c =>
      (c.headline || '').toLowerCase().includes(q) ||
      (c.summary  || '').toLowerCase().includes(q) ||
      (c.foryou   || '').toLowerCase().includes(q)
    );
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
  return esc(text).replace(re, '<mark>$1</mark>');
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
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
    cls = 'src-web'; label = src; icon = 'ti-world';
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
          ${c.url ? `<a href="${esc(c.url)}" class="card-link" target="_blank" rel="noopener">
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
    grid.innerHTML = `
      <div class="state-msg">
        <i class="ti ti-calendar-off"></i>
        <strong>No data for ${fmtDate(state.currentDate)}</strong>
        <p>Try a different date or check back later.</p>
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
    // Date nav arrow only relevant when browsing day-by-day
    document.querySelector('.date-nav').style.opacity = state.period === 'today' ? '1' : '.35';
    document.querySelector('.date-nav').style.pointerEvents = state.period === 'today' ? '' : 'none';
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
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value;
    renderGrid();
  }, 200);
});

// ═══════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════
// Date nav is only interactive in "Today" mode
document.querySelector('.date-nav').style.opacity = '0.35';
document.querySelector('.date-nav').style.pointerEvents = 'none';
updateDateUI();
loadCurrentView();

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
