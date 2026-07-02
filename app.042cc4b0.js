// ── Icon font — injected dynamically to avoid render-blocking ──
(function () {
  const link = document.createElement('link');
  link.rel  = 'stylesheet';
  link.href = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.9.0/dist/tabler-icons.min.css';
  document.head.appendChild(link);
}());

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
  qwen:     ['qwen', 'qwq', 'alibaba'],
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
  if (label) label.textContent = `${n} read`;
  if (btn)   btn.disabled = n === 0;
  updateHeaderUI();
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

// Date bounds the prev/next arrows may not cross for a given period filter
function getPeriodBounds(period) {
  const today = todayStr();
  if (period === 'today') return { min: today, max: today };
  const range = period === 'this-week'  ? getThisWeekRange()
              : period === 'last-week'  ? getLastWeekRange()
              : period === 'this-month' ? getThisMonthRange()
              : null;
  return range ? { min: range[0], max: range[range.length - 1] } : { min: null, max: today };
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
  state.loading = true;
  renderGrid();

  const isToday = state.currentDate === todayStr();
  let cards = [];
  try {
    cards = await fetchDay(state.currentDate, { cacheMiss: !isToday });
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
function applyFilters(cards, { skipSection = false } = {}) {
  let out = cards;
  if (!skipSection && state.section !== 'all') {
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
//  Filter badge (mobile FAB)
// ═══════════════════════════════════════════════════════════
function updateFilterBadge() {
  const badge = document.getElementById('fabBadge');
  const n = (state.section !== 'all' ? 1 : 0)
          + (state.period  !== 'all' ? 1 : 0)
          + (state.model   !== 'all' ? 1 : 0);
  badge.textContent = n || '';
  badge.classList.toggle('hidden', n === 0);
}

// ═══════════════════════════════════════════════════════════
//  Date count, section counts, read-progress bar
// ═══════════════════════════════════════════════════════════
function updateHeaderUI() {
  const total    = state.allCards.length;
  const filtered = applyFilters(state.allCards);

  document.getElementById('dateCount').textContent = total
    ? `${filtered.length} ${filtered.length === 1 ? 'story' : 'stories'}${state.search ? ` matching "${state.search}"` : ''}`
    : '';

  const base = applyFilters(state.allCards, { skipSection: true });
  const counts = { all: base.length, models: 0, industry: 0, tips: 0 };
  base.forEach(c => { if (c.section in counts) counts[c.section]++; });
  Object.keys(counts).forEach(s => {
    const el = document.getElementById(`cnt-${s}`);
    if (el) el.textContent = counts[s];
  });

  const readToday = state.allCards.filter(c => readSet.has(readCardKey(c))).length;
  document.getElementById('progressFill').style.width = total ? `${(readToday / total) * 100}%` : '0%';
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
  models:   { label: 'Models',   accentClass: 'ca-m' },
  industry: { label: 'Industry', accentClass: 'ca-i' },
  tips:     { label: 'Tips',     accentClass: 'ca-t' },
};

function sourceLabelFor(src) {
  if (!src) return '';
  const s = src.toLowerCase();
  if (s.includes('tldr'))    return 'TLDR AI';
  if (s.includes('semafor')) return 'Semafor';
  return esc(src);
}

function renderCard(c) {
  const meta       = SECTION_META[c.section] || SECTION_META['industry'];
  const showForyou = (c.section === 'models' || c.section === 'tips') && c.foryou;
  const showSpecs  = c.section === 'models' && c.specs && c.specs.length > 0;
  const isRead     = readSet.has(readCardKey(c));

  const foryouHtml = showForyou ? `
    <div class="card-foryou ${meta.accentClass}">
      <span class="fy-icon">◆</span>
      <span>For you: ${hl(c.foryou)}</span>
    </div>` : '';

  const specsHtml = showSpecs ? `
    <details class="specs">
      <summary><span class="specs-icon"></span>Specs<i class="ti ti-chevron-down"></i></summary>
      <div class="specs-grid">
        ${c.specs.map(s => `
          <div class="spec-row">
            <span class="spec-label">${esc(s.label)}</span>
            <span class="spec-value">${esc(s.value)}</span>
          </div>`).join('')}
      </div>
    </details>` : '';

  const cardDate    = c.date ? fmtDate(c.date) : fmtDate(state.currentDate);
  const sourceLabel = sourceLabelFor(c.source);

  return `
    <article class="card" data-rk="${esc(readCardKey(c))}">
      <div class="cat-row ${meta.accentClass}">
        <span class="cat-dot"></span>
        <span class="cat-label">${meta.label}</span>
        ${isRead ? '' : '<span class="unread-dot"></span>'}
      </div>
      <h2 class="card-title">${hl(c.headline)}</h2>
      <p class="card-summary">${hl(c.summary)}</p>
      ${foryouHtml}
      ${specsHtml}
      <div class="card-footer">
        <span class="src-tag">${sourceLabel ? `${sourceLabel} · ` : ''}${cardDate}</span>
        ${c.url ? `<a href="${esc(safeUrl(c.url))}" class="card-link" target="_blank" rel="noopener">
          Read <i class="ti ti-external-link"></i></a>` : ''}
      </div>
    </article>`;
}

// ═══════════════════════════════════════════════════════════
//  Render grid
// ═══════════════════════════════════════════════════════════
function renderGrid() {
  const grid = document.getElementById('cardGrid');

  if (state.loading) {
    grid.innerHTML = `<div class="state-msg"><div class="spinner"></div><p>Loading…</p></div>`;
    updateHeaderUI();
    return;
  }

  const filtered = applyFilters(state.allCards);

  if (state.allCards.length === 0) {
    const emptyLabel = {
      today:        `No data for ${fmtDate(state.currentDate)}`,
      'this-week':  'No data for this week',
      'last-week':  'No data for last week',
      'this-month': 'No data for this month',
      all:          `No data for ${fmtDate(state.currentDate)}`,
    }[state.period] ?? 'No data available';
    grid.innerHTML = `
      <div class="state-msg">
        <i class="ti ti-calendar-off"></i>
        <strong>${emptyLabel}</strong>
        <p>Try navigating to a different date.</p>
      </div>`;
    updateHeaderUI();
    return;
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="state-msg">
        <i class="ti ti-search-off"></i>
        <strong>No results</strong>
        <p>Try adjusting your search or filters.</p>
      </div>`;
    updateHeaderUI();
    return;
  }

  grid.innerHTML = filtered.map(renderCard).join('');
  updateHeaderUI();
}

// ═══════════════════════════════════════════════════════════
//  Date nav
// ═══════════════════════════════════════════════════════════
function updateDateUI() {
  const lbl  = document.getElementById('dateLabel');
  const prev = document.getElementById('prevDay');
  const next = document.getElementById('nextDay');
  const today = todayStr();
  const { min, max } = getPeriodBounds(state.period);
  const earliest = availableDates && availableDates.length ? [...availableDates].sort()[0] : null;
  const prevLimit = [min, earliest].filter(Boolean).sort().pop() || null;
  lbl.textContent = window.innerWidth < 768 ? fmtDate(state.currentDate) : fmtDateFull(state.currentDate);
  prev.disabled = prevLimit !== null && state.currentDate <= prevLimit;
  next.disabled = state.currentDate >= (max ?? today);
}

document.getElementById('prevDay').addEventListener('click', () => {
  state.currentDate = addDays(state.currentDate, -1);
  updateDateUI();
  loadCurrentView();
});
document.getElementById('nextDay').addEventListener('click', () => {
  state.currentDate = addDays(state.currentDate, 1);
  updateDateUI();
  loadCurrentView();
});
document.getElementById('dateLabel').addEventListener('click', () => {
  state.currentDate = todayStr();
  updateDateUI();
  loadCurrentView();
});

// ═══════════════════════════════════════════════════════════
//  Mark-read (event delegation on grid)
// ═══════════════════════════════════════════════════════════
document.getElementById('cardGrid').addEventListener('click', e => {
  // Mark card read when the Read link is clicked
  const link = e.target.closest('.card-link');
  if (link) {
    const card = link.closest('.card');
    if (card) {
      const rk = card.dataset.rk;
      if (rk && !readSet.has(rk)) {
        readSet.add(rk);
        localStorage.setItem(READ_KEY, JSON.stringify([...readSet]));
        card.querySelector('.unread-dot')?.remove();
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
//  Section filter (sidebar list + mobile chip row stay in sync)
// ═══════════════════════════════════════════════════════════
document.querySelectorAll('[data-section]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.section = btn.dataset.section;
    document.querySelectorAll('[data-section]').forEach(b => {
      b.classList.toggle('active', b.dataset.section === state.section);
    });
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
    state.currentDate = getPeriodBounds(state.period).max ?? todayStr();
    updateDateUI();
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
    updateFilterBadge();
    renderGrid();
  });
});

// ═══════════════════════════════════════════════════════════
//  Search
// ═══════════════════════════════════════════════════════════
let searchTimer;
const headerSearch = document.getElementById('headerSearch');
document.getElementById('searchInput').addEventListener('input', e => {
  state.search = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    updateFilterBadge();
    renderGrid();
  }, 200);
});

// Mobile: search icon reveals the search field; collapses again when empty
document.getElementById('mobileSearchBtn').addEventListener('click', () => {
  headerSearch.classList.add('open');
  document.getElementById('searchInput').focus();
});
document.getElementById('searchInput').addEventListener('blur', () => {
  if (!state.search.trim()) headerSearch.classList.remove('open');
});

// ═══════════════════════════════════════════════════════════
//  Mobile sidebar (bottom sheet) + floating filter button
// ═══════════════════════════════════════════════════════════
const sidebar  = document.getElementById('sidebar');
const overlay  = document.getElementById('sidebarOverlay');
const fabBtn   = document.getElementById('mobileFab');
const closeBtn = document.getElementById('sidebarClose');

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

fabBtn.addEventListener('click', openSidebar);
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
loadIndex().then(updateDateUI); // refine prev-arrow bound once earliest date is known
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
