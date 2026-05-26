// ── Icon font — injected dynamically to avoid render-blocking ──
(function () {
  const link = document.createElement('link');
  link.rel  = 'stylesheet';
  link.href = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.9.0/dist/tabler-icons.min.css';
  document.head.appendChild(link);
}());

// ═══════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════
const PAGE_SIZE = 16;

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
  visibleCount: PAGE_SIZE,
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
let availableDates = null;
let availableDatesFetchedAt = 0;

const INDEX_TTL_MS    = 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;

// ═══════════════════════════════════════════════════════════
//  Read-state (localStorage)
// ═══════════════════════════════════════════════════════════
const READ_KEY = 'ai-digest-read';

function readCardKey(c) {
  return `${c.date || ''}:${c.headline.slice(0, 60)}`;
}

let readSet = new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]'));

function updateReadCount() {
  const label = document.getElementById('readCountLabel');
  const btn   = document.getElementById('clearReadBtn');
  const n = readSet.size;
  if (label) label.textContent = n === 0 ? '0 read' : `${n} read · clear`;
  if (btn)   btn.disabled = n === 0;
}

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
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtDateFull(str) {
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + n));
  return date.toISOString().slice(0, 10);
}

function dateRange(start, end) {
  const dates = [];
  let cur = start;
  while (cur <= end) { dates.push(cur); cur = addDays(cur, 1); }
  return dates;
}

function getMondayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day  = date.getUTCDay();
  const diff = (day === 0) ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}

function getThisWeekRange()  { return dateRange(getMondayOfWeek(todayStr()), todayStr()); }
function getLastWeekRange() {
  const thisMonday = getMondayOfWeek(todayStr());
  return dateRange(addDays(thisMonday, -7), addDays(thisMonday, -1));
}
function getThisMonthRange() {
  const today = todayStr();
  return dateRange(today.slice(0, 7) + '-01', today);
}

function searchableText(c) {
  if (!c._text) {
    c._text = [c.headline, c.summary, c.foryou].filter(Boolean).join(' ').toLowerCase();
  }
  return c._text;
}

async function fetchJson(path, options = {}) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
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
    const idx = await fetchJson('/data/index.json', { cache: 'no-cache' });
    availableDates = Array.isArray(idx.dates) ? idx.dates : [];
    availableDatesFetchedAt = Date.now();
  } catch {
    if (availableDates === null) availableDates = [];
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

let _loadId = 0;

async function loadCurrentView() {
  const myId = ++_loadId;
  state.loading     = true;
  state.visibleCount = PAGE_SIZE;
  renderGrid();

  let cards = [];
  try {
    const index = await loadIndex({ force: state.period === 'today' });

    let wantDates;
    if      (state.period === 'today')      { wantDates = [state.currentDate]; }
    else if (state.period === 'this-week')  { wantDates = getThisWeekRange(); }
    else if (state.period === 'last-week')  { wantDates = getLastWeekRange(); }
    else if (state.period === 'this-month') { wantDates = getThisMonthRange(); }
    else if (state.period === 'yesterday')  { wantDates = [addDays(todayStr(), -1)]; }
    else if (state.period === 'all')        { wantDates = [...index]; }
    else                                     { wantDates = []; }

    const indexSet = new Set(index);
    const toFetch  = state.period === 'today'
      ? wantDates
      : wantDates.filter(d => indexSet.has(d));

    const results = await Promise.all(toFetch.map(d => fetchDay(d, { cacheMiss: state.period !== 'today' })));
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
  if (state.section !== 'all') {
    out = out.filter(c => c.section === state.section);
  }
  if (state.model !== 'all') {
    const keywords = MODEL_KEYWORDS[state.model] || [];
    out = out.filter(c => keywords.some(kw => searchableText(c).includes(kw)));
  }
  const q = state.search.trim().toLowerCase();
  if (q) {
    out = out.filter(c => searchableText(c).includes(q));
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
//  Filter badge (mobile)
// ═══════════════════════════════════════════════════════════
function updateFilterBadge() {
  const badge = document.getElementById('filterBadge');
  const n = (state.section !== 'all' ? 1 : 0)
          + (state.period  !== 'all' ? 1 : 0)
          + (state.model   !== 'all' ? 1 : 0)
          + (state.search.trim()     ? 1 : 0);
  badge.textContent = n || '';
  badge.classList.toggle('hidden', n === 0);
}

// ═══════════════════════════════════════════════════════════
//  Highlighting
// ═══════════════════════════════════════════════════════════
function hl(text) {
  if (!text) return '';
  const q = state.search.trim();
  if (!q) return esc(text);
  const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
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

function sourcePill(src) {
  if (!src) return '';
  const s = src.toLowerCase();
  let cls, label, icon;
  if (s.includes('tldr'))   { cls = 'src-tldr';    label = 'TLDR AI'; icon = 'ti-bolt'; }
  else if (s.includes('semafor')) { cls = 'src-semafor'; label = 'Semafor'; icon = 'ti-news'; }
  else                       { cls = 'src-web';    label = esc(src); icon = 'ti-world'; }
  return `<span class="source-pill ${cls}"><i class="ti ${icon}"></i>${label}</span>`;
}

function renderCard(c) {
  const meta       = SECTION_META[c.section] || SECTION_META['industry'];
  const showForyou = (c.section === 'models' || c.section === 'tips') && c.foryou;
  const showSpecs  = c.section === 'models' && c.specs && c.specs.length > 0;
  const isRead     = readSet.has(readCardKey(c));

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

  const cardDate = c.date ? fmtDate(c.date) : fmtDate(state.currentDate);

  return `
    <article class="card${isRead ? ' card-read' : ''}" data-rk="${esc(readCardKey(c))}">
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
//  Date group navigation
// ═══════════════════════════════════════════════════════════
function getAdjacentDate(dateStr, direction) {
  if (!availableDates || availableDates.length === 0) return null;
  const sorted = [...availableDates].sort(); // ascending
  const idx = sorted.indexOf(dateStr);
  if (idx === -1) return null;
  if (direction === 'prev') return idx > 0 ? sorted[idx - 1] : null;
  // next: don't allow navigating beyond today
  const next = idx < sorted.length - 1 ? sorted[idx + 1] : null;
  return next && next <= todayStr() ? next : null;
}

function navigateToDate(dateStr) {
  state.currentDate = dateStr;
  state.period = 'today';
  document.querySelectorAll('.filter-group.period .pill').forEach(b => {
    b.classList.toggle('active', b.dataset.period === 'today');
  });
  updateDateUI();
  updateDateNavVisibility();
  updateFilterBadge();
  loadCurrentView();
}

// ═══════════════════════════════════════════════════════════
//  Render grid (with date group headers + nav arrows)
// ═══════════════════════════════════════════════════════════
function renderGrid() {
  const grid = document.getElementById('cardGrid');
  const bar  = document.getElementById('resultBar');

  if (state.loading) {
    grid.innerHTML = `<div class="state-msg"><div class="spinner"></div><p>Loading…</p></div>`;
    bar.textContent = '';
    return;
  }

  const filtered = applyFilters(state.allCards)
    .slice()
    .sort((a, b) => {
      const da = a.date || '';
      const db = b.date || '';
      return db > da ? 1 : db < da ? -1 : 0;
    });

  if (state.allCards.length === 0) {
    const emptyLabel = {
      today:        `No data for ${fmtDate(state.currentDate)}`,
      'this-week':  'No data for this week',
      'last-week':  'No data for last week',
      'this-month': 'No data for this month',
      all:          'No data available yet',
    }[state.period] ?? 'No data available';
    const emptyHint = state.period === 'today'
      ? 'Try navigating to a different date.'
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

  const showAll = state.period === 'today';
  const visible   = showAll ? filtered : filtered.slice(0, state.visibleCount);
  const hasMore   = !showAll && filtered.length > state.visibleCount;
  const remaining = hasMore ? filtered.length - state.visibleCount : 0;

  let html = '';
  let lastDate = null;

  for (const c of visible) {
    const cardDate = c.date || state.currentDate;
    if (cardDate !== lastDate) {
      const dateCount = filtered.filter(x => (x.date || state.currentDate) === cardDate).length;
      const prev = getAdjacentDate(cardDate, 'prev');
      const next = getAdjacentDate(cardDate, 'next');
      html += `<div class="date-group-header">
        <button class="dg-nav-btn" data-action="date-nav" data-target="${prev || ''}"${!prev ? ' disabled' : ''} aria-label="Previous day">
          <i class="ti ti-chevron-left"></i>
        </button>
        <div class="date-group-center">
          <span class="date-group-label">${fmtDateFull(cardDate)}</span>
          <span class="date-group-count">${dateCount} ${dateCount === 1 ? 'story' : 'stories'}</span>
        </div>
        <button class="dg-nav-btn" data-action="date-nav" data-target="${next || ''}"${!next ? ' disabled' : ''} aria-label="Next day">
          <i class="ti ti-chevron-right"></i>
        </button>
      </div>`;
      lastDate = cardDate;
    }
    html += renderCard(c);
  }

  if (hasMore) {
    html += `
      <div class="load-more-wrap">
        <button class="load-more-btn" data-action="load-more">
          Show ${Math.min(remaining, PAGE_SIZE)} more
          <span class="load-more-count">${remaining} remaining</span>
        </button>
      </div>`;
  }

  grid.innerHTML = html;
  bar.textContent = `${visible.length} of ${filtered.length} ${filtered.length === 1 ? 'story' : 'stories'}${state.search ? ` matching "${state.search}"` : ''}`;
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

function updateDateNavVisibility() {
  const nav = document.getElementById('dateNav');
  nav.classList.toggle('hidden', state.period !== 'today');
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
//  Load more + mark-read (event delegation on grid)
// ═══════════════════════════════════════════════════════════
document.getElementById('cardGrid').addEventListener('click', e => {
  if (e.target.closest('[data-action="load-more"]')) {
    state.visibleCount += PAGE_SIZE;
    renderGrid();
    return;
  }
  const dateNavBtn = e.target.closest('[data-action="date-nav"]');
  if (dateNavBtn && dateNavBtn.dataset.target) {
    navigateToDate(dateNavBtn.dataset.target);
    return;
  }
  // Mark card read when the Read link is clicked
  const link = e.target.closest('.card-link');
  if (link) {
    const card = link.closest('.card');
    if (card) {
      const rk = card.dataset.rk;
      if (rk && !readSet.has(rk)) {
        readSet.add(rk);
        localStorage.setItem(READ_KEY, JSON.stringify([...readSet]));
        card.classList.add('card-read');
        updateReadCount();
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════
//  Clear read
// ═══════════════════════════════════════════════════════════
document.getElementById('clearReadBtn').addEventListener('click', () => {
  if (readSet.size === 0) return;
  readSet.clear();
  localStorage.setItem(READ_KEY, '[]');
  updateReadCount();
  renderGrid();
});

// ═══════════════════════════════════════════════════════════
//  Section filter
// ═══════════════════════════════════════════════════════════
document.querySelectorAll('.section-group .pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.section-group .pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.section = btn.dataset.section;
    state.visibleCount = PAGE_SIZE;
    updateFilterBadge();
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
    if (state.period === 'today') state.currentDate = todayStr();
    updateDateUI();
    updateDateNavVisibility();
    updateFilterBadge();
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
    state.visibleCount = PAGE_SIZE;
    updateFilterBadge();
    renderGrid();
  });
});

// ═══════════════════════════════════════════════════════════
//  Search
// ═══════════════════════════════════════════════════════════
let searchTimer;
document.getElementById('searchInput').addEventListener('input', e => {
  state.search = e.target.value;
  state.visibleCount = PAGE_SIZE;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    updateFilterBadge();
    renderGrid();
  }, 200);
});

// ═══════════════════════════════════════════════════════════
//  Mobile sidebar (bottom sheet)
// ═══════════════════════════════════════════════════════════
const sidebar  = document.getElementById('sidebar');
const overlay  = document.getElementById('sidebarOverlay');
const toggleBtn = document.getElementById('filterToggle');
const closeBtn  = document.getElementById('sidebarClose');

function openSidebar() {
  sidebar.classList.add('open');
  overlay.classList.add('visible');
  document.body.classList.add('sidebar-lock');
}
function closeSidebar() {
  sidebar.classList.remove('open');
  overlay.classList.remove('visible');
  document.body.classList.remove('sidebar-lock');
}

toggleBtn.addEventListener('click', openSidebar);
closeBtn.addEventListener('click', closeSidebar);
overlay.addEventListener('click', closeSidebar);

// Close sidebar after filter selection on mobile
document.querySelectorAll('.sidebar .pill').forEach(btn => {
  btn.addEventListener('click', () => {
    if (window.innerWidth < 768) closeSidebar();
  });
});

// ═══════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════
updateDateUI();
updateDateNavVisibility(); // date nav hidden (period=all at start)
updateReadCount();
loadCurrentView();

// Service worker: self-destruct stub handling
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data && event.data.type === 'SW_SELF_DESTRUCT') {
      window.location.reload();
    }
  });
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(r => r.unregister());
  });
}
