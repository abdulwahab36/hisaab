'use strict';
/* =========================================================
   Hisaab — personal money, people, recoverables
   Storage: IndexedDB (state + receipt images), offline-first
   ========================================================= */

// ---------------- Utilities ----------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function today() { return ymd(new Date()); }
function addDays(s, n) { const [y, m, d] = s.split('-').map(Number); const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n); return ymd(dt); }
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1 + n, 1);
  const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  dt.setDate(Math.min(d, last));
  return ymd(dt);
}
function daysBetween(a, b) {
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}
function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtShort(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}
function money(n, sign = false) {
  const v = r2(n);
  const s = Math.abs(v).toLocaleString('en-PK', { maximumFractionDigits: 2 });
  return (v < 0 ? '-' : (sign && v > 0 ? '+' : '')) + 'Rs ' + s;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Safe arithmetic for the amount field: "1200+350+80", "3*450"
function evalAmount(str) {
  const s = String(str ?? '').replace(/,/g, '').replace(/\s+/g, '').replace(/[x×]/gi, '*').replace(/÷/g, '/');
  if (!s || !/^[0-9+\-*/.()]+$/.test(s)) return NaN;
  let i = 0;
  const peek = () => s[i];
  function num() {
    const st = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    if (st === i) throw 0;
    const t = s.slice(st, i);
    if ((t.match(/\./g) || []).length > 1) throw 0;
    return parseFloat(t);
  }
  function factor() {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') { i++; const v = expr(); if (peek() !== ')') throw 0; i++; return v; }
    return num();
  }
  function term() { let v = factor(); while (peek() === '*' || peek() === '/') { const op = s[i++]; const f = factor(); v = op === '*' ? v * f : v / f; } return v; }
  function expr() { let v = term(); while (peek() === '+' || peek() === '-') { const op = s[i++]; const t = term(); v = op === '+' ? v + t : v - t; } return v; }
  try { const v = expr(); if (i !== s.length || !isFinite(v)) return NaN; return r2(v); } catch (e) { return NaN; }
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------------- Storage (IndexedDB with fallback) ----------------
const DB = {
  db: null, ok: false,
  open() {
    return new Promise(res => {
      if (!('indexedDB' in window)) return res(false);
      let rq;
      try { rq = indexedDB.open('hisaab', 1); } catch (e) { return res(false); }
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('img')) d.createObjectStore('img');
      };
      rq.onsuccess = () => { DB.db = rq.result; DB.ok = true; res(true); };
      rq.onerror = () => res(false);
      rq.onblocked = () => res(false);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = DB.db.transaction(store, mode);
      const r = fn(t.objectStore(store));
      let out;
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  async get(store, key) {
    if (!DB.ok) { const v = localStorage.getItem('hisaab_' + store + '_' + key); return v ? JSON.parse(v) : undefined; }
    return DB.tx(store, 'readonly', st => st.get(key));
  },
  async put(store, key, val) {
    if (!DB.ok) { localStorage.setItem('hisaab_' + store + '_' + key, JSON.stringify(val)); return; }
    return DB.tx(store, 'readwrite', st => st.put(val, key));
  },
  async del(store, key) {
    if (!DB.ok) { localStorage.removeItem('hisaab_' + store + '_' + key); return; }
    return DB.tx(store, 'readwrite', st => st.delete(key));
  },
  async keys(store) {
    if (!DB.ok) { const p = 'hisaab_' + store + '_'; return Object.keys(localStorage).filter(k => k.startsWith(p)).map(k => k.slice(p.length)); }
    return DB.tx(store, 'readonly', st => st.getAllKeys());
  },
  async clear(store) {
    if (!DB.ok) { for (const k of await DB.keys(store)) localStorage.removeItem('hisaab_' + store + '_' + k); return; }
    return DB.tx(store, 'readwrite', st => st.clear());
  }
};

// ---------------- State ----------------
let S = null;

function defaultState() {
  const mk = (name, extra = {}) => ({ id: uid(), name, ...extra });
  return {
    v: 1,
    accounts: ['Cash', 'Bank', 'Easypaisa', 'JazzCash'].map(n => mk(n, { opening: 0 })),
    books: ['Home', 'Office', 'Personal', 'Car'].map(n => mk(n)),
    categories: [
      ...['Food & grocery', 'Fuel', 'Repair & maintenance', 'Utilities', 'Transport', 'Medical', 'Shopping', 'Court / legal', 'Education', 'Other'].map(n => mk(n, { kind: 'out' })),
      ...['Salary', 'TA / allowance', 'Online income', 'Other income'].map(n => mk(n, { kind: 'in' }))
    ],
    people: [],
    works: [],
    entries: [],
    templates: [],
    settings: { pinHash: '', pinSalt: '', lastBackup: null, alertDays: 60, lockAfter: 60, last: {}, googleClientId: '', driveDirty: false, drive: defaultDrive() }
  };
}
function defaultDrive() {
  return { connected: false, auto: true, email: '', folderId: '', imgFolderId: '', lastBackup: null, lastFile: null, imgs: {}, needsReconnect: false, lastAttempt: 0 };
}

function normalizeState(st) {
  const d = defaultState();
  const out = { ...d, ...st };
  for (const k of ['accounts', 'books', 'categories', 'people', 'works', 'entries', 'templates']) if (!Array.isArray(out[k])) out[k] = d[k];
  out.settings = { ...d.settings, ...(st.settings || {}) };
  if (!out.settings.last) out.settings.last = {};
  out.settings.drive = { ...defaultDrive(), ...((st.settings && st.settings.drive) || {}) };
  if (!out.settings.drive.imgs) out.settings.drive.imgs = {};
  return out;
}

async function load() {
  await DB.open();
  const st = await DB.get('kv', 'state');
  S = st ? normalizeState(st) : defaultState();
  if (!st) await save();
}

let dirtySeq = 0;
async function save() {
  S.settings.driveDirty = true;
  dirtySeq++;
  try { await DB.put('kv', 'state', S); }
  catch (e) { toast('Save failed: storage full or blocked'); throw e; }
  if (S.settings.drive.connected) maybeAutoSync();
}
// Save without marking data as changed (used for backup bookkeeping)
async function saveRaw() {
  try { await DB.put('kv', 'state', S); } catch (e) { /* ignore */ }
}

// ---------------- Lookups ----------------
const byId = (arr, id) => (id ? arr.find(x => x.id === id) : null);
const acc = id => byId(S.accounts, id);
const book = id => byId(S.books, id);
const cat = id => byId(S.categories, id);
const person = id => byId(S.people, id);
const work = id => byId(S.works, id);
const live = () => S.entries.filter(e => !e.draft);

const TYPES = {
  expense:     { label: 'Expense',     hint: 'My own spending', f: ['paidFrom', 'book', 'cat', 'work', 'note', 'receipt'] },
  recoverable: { label: 'Recoverable', hint: 'Spent now, to get back later (office, company, someone)', f: ['paidFrom', 'book', 'cat', 'work', 'recoverFrom', 'note', 'receipt'] },
  income:      { label: 'Income',      hint: 'Salary, TA, online income…', f: ['account', 'catIn', 'note', 'receipt'] },
  lent:        { label: 'Lent',        hint: 'I gave money, they will return it', f: ['person*', 'account', 'work', 'due', 'note'] },
  borrowed:    { label: 'Borrowed',    hint: 'I took money, I will return it', f: ['person*', 'account', 'due', 'note'] },
  received:    { label: 'Got back',    hint: 'A person returned money (loan or unused advance)', f: ['person*', 'account', 'due', 'note'] },
  repaid:      { label: 'Paid back',   hint: 'I returned money to a person', f: ['person*', 'account', 'note'] },
  advance:     { label: 'Advance',     hint: 'Given to staff for work; they report spending later', f: ['person*', 'account', 'work', 'note'] },
  transfer:    { label: 'Transfer',    hint: 'Move money between my accounts', f: ['account', 'toAccount', 'note'] },
  expected:    { label: 'Expected',    hint: 'Money due in future: TA, arrears, payouts, bills', f: ['catAny', 'personOpt', 'repeat', 'note'], dateLabel: 'Due on' }
};
const TYPE_ORDER = ['expense', 'recoverable', 'income', 'lent', 'borrowed', 'received', 'repaid', 'advance', 'transfer', 'expected'];
const SYS_LABEL = { recovery: 'Recovery', adjustment: 'Balance adjustment' };
const typeLabel = t => (TYPES[t] ? TYPES[t].label : SYS_LABEL[t] || t);
const PERSON_KINDS = { friend: 'Friend / relative', staff: 'Office staff', family: 'Family', org: 'Office / company', other: 'Other' };

// ---------------- Calculations ----------------
function allocMap() {
  const m = {};
  for (const e of live()) if (e.type === 'recovery') for (const a of e.allocations || []) m[a.id] = r2((m[a.id] || 0) + a.amount);
  return m;
}
function recInfo(e, am = allocMap()) {
  const recovered = am[e.id] || 0;
  const writtenOff = e.writtenOff ? e.writtenOff.amount : 0;
  const remaining = Math.max(0, r2(e.amount - recovered - writtenOff));
  let status = 'pending';
  if (remaining <= 0) status = writtenOff > 0 && recovered < e.amount ? 'written-off' : 'recovered';
  else if (recovered > 0 || writtenOff > 0) status = 'partial';
  return { recovered, writtenOff, remaining, status };
}
function expectedInfo(x) {
  const got = r2(live().filter(e => e.linkExpected === x.id).reduce((s, e) => s + e.amount, 0));
  const rem = Math.max(0, r2(x.amount - got));
  return { got, rem, closed: !!x.closed || rem <= 0 };
}
function accountBalances() {
  const b = {};
  S.accounts.forEach(a => { b[a.id] = Number(a.opening) || 0; });
  const add = (id, v) => { if (id && b[id] !== undefined) b[id] = r2(b[id] + v); };
  for (const e of live()) {
    const a = e.amount;
    switch (e.type) {
      case 'income': case 'borrowed': case 'received': case 'recovery': add(e.accountId, a); break;
      case 'expense': case 'recoverable': if (!e.viaPersonId) add(e.accountId, -a); break;
      case 'lent': case 'advance': case 'repaid': add(e.accountId, -a); break;
      case 'transfer': add(e.accountId, -a); add(e.toAccountId, a); break;
      case 'adjustment': add(e.accountId, a); break;
    }
  }
  return b;
}
// Positive = they owe me. Negative = I owe them.
function personBalances() {
  const am = allocMap(), b = {};
  S.people.forEach(p => { b[p.id] = 0; });
  const add = (id, v) => { if (id && b[id] !== undefined) b[id] = r2(b[id] + v); };
  for (const e of live()) {
    const a = e.amount;
    switch (e.type) {
      case 'lent': case 'advance': case 'repaid': add(e.personId, a); break;
      case 'borrowed': case 'received': add(e.personId, -a); break;
      case 'expense': if (e.viaPersonId) add(e.viaPersonId, -a); break;
      case 'recoverable':
        if (e.viaPersonId) add(e.viaPersonId, -a);
        if (e.personId) add(e.personId, recInfo(e, am).remaining);
        break;
    }
  }
  return b;
}
function personLines(pid) {
  const lines = [];
  const recById = {};
  live().forEach(e => { if (e.type === 'recoverable') recById[e.id] = e; });
  const push = (date, e, label, v) => lines.push({ date, e, label, v, c: e.createdAt || '' });
  for (const e of live()) {
    const a = e.amount;
    switch (e.type) {
      case 'lent': if (e.personId === pid) push(e.date, e, 'You gave', a); break;
      case 'advance': if (e.personId === pid) push(e.date, e, 'Advance given', a); break;
      case 'repaid': if (e.personId === pid) push(e.date, e, 'You paid them', a); break;
      case 'borrowed': if (e.personId === pid) push(e.date, e, 'They gave you', -a); break;
      case 'received': if (e.personId === pid) push(e.date, e, 'They paid you', -a); break;
      case 'expense': if (e.viaPersonId === pid) push(e.date, e, 'Spent for me', -a); break;
      case 'recoverable':
        if (e.viaPersonId === pid) push(e.date, e, 'Spent for me', -a);
        if (e.personId === pid) {
          push(e.date, e, 'Recoverable', a);
          if (e.writtenOff) push(e.writtenOff.date, e, 'Written off', -e.writtenOff.amount);
        }
        break;
      case 'recovery':
        for (const al of e.allocations || []) {
          const r = recById[al.id];
          if (r && r.personId === pid) push(e.date, e, 'Recovered: ' + entryTitle(r), -al.amount);
        }
        break;
    }
  }
  lines.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.c < y.c ? -1 : x.c > y.c ? 1 : 0));
  let bal = 0;
  lines.forEach(l => { bal = r2(bal + l.v); l.bal = bal; });
  return lines;
}
function ownSpending(from, to) {
  const byBook = {}, byCat = {};
  let total = 0;
  const add = (bk, ct, v) => { total = r2(total + v); byBook[bk] = r2((byBook[bk] || 0) + v); byCat[ct] = r2((byCat[ct] || 0) + v); };
  for (const e of live()) {
    if (e.type === 'expense' && e.date >= from && e.date <= to) add(e.bookId || '_none', e.categoryId || '_none', e.amount);
    if (e.type === 'recoverable' && e.writtenOff && e.writtenOff.date >= from && e.writtenOff.date <= to) add(e.bookId || '_none', e.categoryId || '_none', e.writtenOff.amount);
    if (e.type === 'adjustment' && e.amount < 0 && e.date >= from && e.date <= to) add('_unrec', '_unrec', -e.amount);
  }
  return { total, byBook, byCat };
}
function monthBounds(ym) { return [ym + '-01', ym + '-31']; }
function summary() {
  const pb = personBalances(), am = allocMap();
  let owedToMe = 0, iOwe = 0;
  Object.values(pb).forEach(v => { if (v > 0) owedToMe = r2(owedToMe + v); else iOwe = r2(iOwe - v); });
  let recNoPerson = 0;
  for (const e of live()) if (e.type === 'recoverable' && !e.personId) recNoPerson = r2(recNoPerson + recInfo(e, am).remaining);
  owedToMe = r2(owedToMe + recNoPerson);
  const t = today(), lim = addDays(t, 30);
  let expIn = 0, expOut = 0;
  for (const e of live()) if (e.type === 'expected') {
    const xi = expectedInfo(e);
    if (!xi.closed && e.date <= lim) { if (e.direction === 'out') expOut = r2(expOut + xi.rem); else expIn = r2(expIn + xi.rem); }
  }
  const ab = accountBalances();
  const cash = r2(Object.values(ab).reduce((s, v) => s + v, 0));
  const [f, to] = monthBounds(t.slice(0, 7));
  return { owedToMe, iOwe, expIn, expOut, cash, spent: ownSpending(f, to) };
}

function entryTitle(e) {
  if (e.note) return e.note;
  const c = cat(e.categoryId);
  if (c) return c.name;
  if (e.type === 'transfer') return (acc(e.accountId)?.name || '?') + ' → ' + (acc(e.toAccountId)?.name || '?');
  const p = person(e.personId);
  if (p && ['lent', 'borrowed', 'received', 'repaid', 'advance'].includes(e.type)) return typeLabel(e.type) + ' · ' + p.name;
  return typeLabel(e.type);
}
function entryFlow(e) {
  if (e.draft) return 'neutral';
  switch (e.type) {
    case 'income': case 'borrowed': case 'received': case 'recovery': return 'in';
    case 'expense': case 'recoverable': return e.viaPersonId ? 'neutral' : 'out';
    case 'lent': case 'advance': case 'repaid': return 'out';
    case 'adjustment': return e.amount < 0 ? 'out' : 'in';
    default: return 'neutral';
  }
}
function entrySub(e) {
  const parts = [typeLabel(e.type)];
  if (e.draft) parts[0] = 'Incomplete';
  const bk = book(e.bookId); if (bk) parts.push(bk.name);
  const p = person(e.type === 'recoverable' ? e.personId : e.personId); if (p && e.type !== 'expense') parts.push((e.type === 'recoverable' ? 'from ' : '') + p.name);
  const vp = person(e.viaPersonId); if (vp) parts.push('paid by ' + vp.name);
  const w = work(e.workId); if (w) parts.push(w.name);
  if (e.accountId && !e.viaPersonId && e.type !== 'transfer') { const a = acc(e.accountId); if (a) parts.push(a.name); }
  if (e.oldEntry) parts.push('before app');
  return parts.join(' · ');
}
function entryItem(e, opts = {}) {
  const fl = entryFlow(e);
  const amt = e.type === 'adjustment' ? e.amount : e.amount;
  const sign = fl === 'in' ? '+' : fl === 'out' ? '-' : '';
  let extra = '';
  if (e.type === 'recoverable') { const ri = recInfo(e); extra = `<div class="li-sub"><span class="badge ${ri.status}">${ri.status}</span></div>`; }
  if (e.type === 'expected') { const xi = expectedInfo(e); const od = !xi.closed && e.date < today(); extra = `<div class="li-sub"><span class="badge ${xi.closed ? 'recovered' : od ? 'overdue' : 'pending'}">${xi.closed ? 'done' : od ? 'overdue' : e.direction === 'out' ? 'to pay' : 'to receive'}</span></div>`; }
  return `<button class="list-item" data-act="openEntry" data-id="${e.id}">
    <div class="li-main"><div class="li-title">${esc(entryTitle(e))}${e.receipt ? ' <span class="muted small">📎</span>' : ''}</div>
    <div class="li-sub">${opts.noDate ? '' : fmtShort(e.date) + ' · '}${esc(entrySub(e))}</div></div>
    <div class="li-amt ${fl === 'in' ? 'in' : fl === 'out' ? 'out' : 'muted'}">${sign}${money(Math.abs(amt)).replace('-', '')}${extra}</div>
  </button>`;
}

// ---------------- Navigation ----------------
let tab = 'home';
let stack = []; // sub-views: {v, p}
let cur = { v: 'home', p: null };
let ui = { pendingSeg: 'rec', recFilter: 'open', recPerson: '', sel: new Set(), expShowClosed: false, entryFilter: null, peopleQ: '' };

function setTab(t) {
  if (t === 'add' && cur.v !== 'add') resetForm();
  tab = t; stack = []; cur = { v: t, p: null };
  render();
  window.scrollTo(0, 0);
}
function go(v, p = null) {
  stack.push(cur);
  cur = { v, p };
  history.pushState({ h: 1 }, '');
  render();
  window.scrollTo(0, 0);
}
function back() {
  if (sheetOpen) { closeSheet(); return; }
  if (stack.length) { cur = stack.pop(); render(); window.scrollTo(0, 0); }
  else if (cur.v !== 'home') setTab('home');
}
window.addEventListener('popstate', () => {
  if (sheetOpen) { closeSheet(); history.pushState({ h: 1 }, ''); return; }
  if (stack.length) { cur = stack.pop(); render(); }
});

const TITLES = {
  home: 'Hisaab', people: 'People', add: 'Add entry', pending: 'Pending', more: 'More',
  person: 'Person', accounts: 'Accounts', books: 'Books', cats: 'Categories', works: 'Works / sites', work: 'Work',
  templates: 'Quick templates', entries: 'All entries', backup: 'Backup & restore', security: 'App lock', help: 'How it works'
};

function render() {
  $$('.nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#backBtn').hidden = stack.length === 0;
  $('#lockBtn').hidden = !S.settings.pinHash;
  let title = TITLES[cur.v] || 'Hisaab';
  if (cur.v === 'person') title = person(cur.p)?.name || 'Person';
  if (cur.v === 'work') title = work(cur.p)?.name || 'Work';
  if (cur.v === 'add' && form.editingId) title = form.draftId ? 'Complete entry' : 'Edit entry';
  $('#title').textContent = title;
  const fn = VIEWS[cur.v] || VIEWS.home;
  $('#view').innerHTML = fn(cur.p);
  if (cur.v === 'add') afterAddRender();
}

// ---------------- Views ----------------
const VIEWS = {};

VIEWS.home = () => {
  const s = summary();
  const t = today();
  const am = allocMap();
  const alerts = [];
  const old = live().filter(e => e.type === 'recoverable' && recInfo(e, am).remaining > 0 && daysBetween(e.date, t) > S.settings.alertDays);
  if (old.length) alerts.push(`<button class="alert" data-act="goPending" data-seg="rec"><span class="grow"><b>${old.length} recoverable${old.length > 1 ? 's' : ''}</b> older than ${S.settings.alertDays} days · ${money(old.reduce((a, e) => a + recInfo(e, am).remaining, 0))}</span>›</button>`);
  const od = live().filter(e => e.type === 'expected' && !expectedInfo(e).closed && e.date < t);
  if (od.length) alerts.push(`<button class="alert" data-act="goPending" data-seg="exp"><span class="grow"><b>${od.length} expected item${od.length > 1 ? 's' : ''}</b> overdue</span>›</button>`);
  const drafts = S.entries.filter(e => e.draft);
  const pbAll = personBalances();
  const dueP = S.people.filter(p => p.dueDate && pbAll[p.id] && p.dueDate <= t).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  if (dueP.length === 1) { const p = dueP[0], b = pbAll[p.id]; alerts.push(`<button class="alert" data-act="go" data-v="person" data-p="${p.id}"><span class="grow"><b>${esc(p.name)}</b> · ${b > 0 ? money(b) + ' was promised to you' : 'you promised to pay ' + money(-b)} by ${fmtShort(p.dueDate)}</span>›</button>`); }
  else if (dueP.length > 1) alerts.push(`<button class="alert" data-act="tab" data-tab="people"><span class="grow"><b>${dueP.length} people</b> past a promised payment date</span>›</button>`);
  if (drafts.length) alerts.push(`<button class="alert info" data-act="goEntries" data-filter="draft"><span class="grow"><b>${drafts.length} incomplete</b> receipt${drafts.length > 1 ? 's' : ''} to fill in</span>›</button>`);
  const dv = S.settings.drive;
  if (dv.connected && dv.needsReconnect) {
    alerts.push(`<button class="alert" data-act="driveReconnect"><span class="grow"><b>Google Drive backup paused</b> · tap to reconnect</span>›</button>`);
  } else {
    const lb = latestBackup();
    if (live().length >= 5 && (!lb || daysBetween(lb.slice(0, 10), t) > 7)) alerts.push(`<button class="alert" data-act="go" data-v="backup"><span class="grow"><b>Backup due</b> · ${lb ? 'last ' + fmtDate(lb.slice(0, 10)) : 'never backed up'}${dv.connected ? '' : ' · set up auto backup'}</span>›</button>`);
  }
  if (!live().length && S.accounts.every(a => !Number(a.opening))) alerts.push(`<button class="alert info" data-act="go" data-v="accounts"><span class="grow"><b>Start here:</b> set opening balances of your accounts</span>›</button>`);

  // spending by book
  const sb = Object.entries(s.spent.byBook).sort((a, b) => b[1] - a[1]);
  const maxB = Math.max(1, ...sb.map(x => x[1]));
  const bookBars = sb.length ? sb.map(([id, v]) => {
    const name = id === '_unrec' ? 'Unrecorded (balance check)' : id === '_none' ? 'No book' : (book(id)?.name || 'Deleted');
    return `<div class="bar-row"><div class="bar-top"><span>${esc(name)}</span><b>${money(v)}</b></div><div class="bar"><i style="width:${(v / maxB) * 100}%"></i></div></div>`;
  }).join('') : '<div class="muted small">No own spending this month yet.</div>';

  // pending by age
  const buckets = [['0–30 days', 0, 30, ''], ['31–60 days', 31, 60, ''], ['61–90 days', 61, 90, 'w'], ['Over 90 days', 91, 1e9, 'd']].map(b => ({ label: b[0], min: b[1], max: b[2], cls: b[3], v: 0 }));
  for (const e of live()) if (e.type === 'recoverable') {
    const rem = recInfo(e, am).remaining; if (rem <= 0) continue;
    const age = daysBetween(e.date, t);
    const bk = buckets.find(b => age >= b.min && age <= b.max) || buckets[0];
    bk.v = r2(bk.v + rem);
  }
  const maxA = Math.max(1, ...buckets.map(b => b.v));
  const anyPending = buckets.some(b => b.v > 0);
  const ageBars = anyPending ? buckets.map(b => `<div class="bar-row"><div class="bar-top"><span>${b.label}</span><b>${money(b.v)}</b></div><div class="bar ${b.cls}"><i style="width:${(b.v / maxA) * 100}%"></i></div></div>`).join('') : '<div class="muted small">Nothing pending to recover.</div>';

  const recent = [...S.entries].filter(e => !e.draft && e.type !== 'expected').sort(sortDesc).slice(0, 8);
  const expNet = r2(s.expIn - s.expOut);

  return `
  <div class="tiles">
    <button class="tile" data-act="goEntries" data-filter="spent"><div class="lbl">Spent this month</div><div class="val out">${money(s.spent.total)}</div><div class="sub">own money only</div></button>
    <button class="tile" data-act="tab" data-tab="people"><div class="lbl">Owed to me</div><div class="val in">${money(s.owedToMe)}</div><div class="sub">loans, advances, recoverables</div></button>
    <button class="tile" data-act="tab" data-tab="people"><div class="lbl">I owe</div><div class="val ${s.iOwe ? 'out' : ''}">${money(s.iOwe)}</div><div class="sub">to people</div></button>
    <button class="tile" data-act="goPending" data-seg="exp"><div class="lbl">Expected · 30 days</div><div class="val ${expNet >= 0 ? 'in' : 'out'}">${money(expNet, true)}</div><div class="sub">in ${money(s.expIn)} · out ${money(s.expOut)}</div></button>
  </div>
  <div class="cashline"><span>Cash & bank total</span><b>${money(s.cash)}</b></div>
  ${alerts.join('')}
  <div class="sec-title">Quick add</div>
  <div class="chips">
    <button class="chip ghost" data-act="snap">📷 Snap receipt</button>
    ${S.templates.map(tp => `<button class="chip" data-act="useTpl" data-id="${tp.id}">${esc(tp.name)}</button>`).join('')}
    ${S.templates.length ? '' : '<span class="muted small" style="align-self:center">Save frequent entries as templates from the Add screen</span>'}
  </div>
  <div class="sec-title">Own spending · ${monthLabel(t.slice(0, 7))}</div>
  <div class="card">${bookBars}</div>
  <div class="sec-title">Pending to recover · by age</div>
  <div class="card">${ageBars}</div>
  <div class="sec-title">Recent <button data-act="goEntries" data-filter="">All entries</button></div>
  <div class="card flush">${recent.length ? recent.map(e => entryItem(e)).join('') : '<div class="empty">No entries yet. Tap + to add one.</div>'}</div>`;
};

function dueTag(p, bal) {
  if (!p.dueDate || !bal) return '';
  const d = daysBetween(today(), p.dueDate);
  const who = bal > 0 ? 'Promised by' : 'I promised by';
  if (d < 0) return `<span class="danger">${who} ${fmtShort(p.dueDate)} · ${-d}d late</span>`;
  if (d === 0) return `<span class="warn">${who} today</span>`;
  return `<span class="muted">${who} ${fmtShort(p.dueDate)}</span>`;
}
function sortDesc(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1;
}

VIEWS.people = () => {
  const pb = personBalances();
  const q = ui.peopleQ.trim().toLowerCase();
  const list = S.people.filter(p => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => Math.abs(pb[b.id]) - Math.abs(pb[a.id]) || a.name.localeCompare(b.name));
  let owed = 0, owe = 0;
  Object.values(pb).forEach(v => { if (v > 0) owed = r2(owed + v); else owe = r2(owe - v); });
  return `
  <div class="tiles">
    <div class="tile"><div class="lbl">People owe me</div><div class="val in">${money(owed)}</div></div>
    <div class="tile"><div class="lbl">I owe people</div><div class="val ${owe ? 'out' : ''}">${money(owe)}</div></div>
  </div>
  <div class="row" style="margin-bottom:10px">
    <input class="inp grow" placeholder="Search people" value="${esc(ui.peopleQ)}" data-ui="peopleQ">
    <button class="btn primary" data-act="editPerson">+ Person</button>
  </div>
  <div class="card flush">${list.length ? list.map(p => {
    const v = pb[p.id] || 0;
    const st = v > 0 ? `<span class="in">owes you</span>` : v < 0 ? `<span class="out">you owe</span>` : '<span class="muted">settled</span>';
    return `<button class="list-item" data-act="go" data-v="person" data-p="${p.id}">
      <div class="li-main"><div class="li-title">${esc(p.name)}</div><div class="li-sub">${dueTag(p, v) || esc(PERSON_KINDS[p.kind] || '') + (p.phone ? ' · ' + esc(p.phone) : '')}</div></div>
      <div class="li-amt">${money(Math.abs(v))}<div class="li-sub">${st}</div></div></button>`;
  }).join('') : `<div class="empty">${q ? 'No match.' : 'No people yet. Add friends, staff, or your office/company as a person.'}</div>`}</div>`;
};

VIEWS.person = (pid) => {
  const p = person(pid);
  if (!p) return '<div class="empty">Person not found.</div>';
  const bal = personBalances()[pid] || 0;
  const lines = personLines(pid);
  const am = allocMap();
  const openRec = live().filter(e => e.type === 'recoverable' && e.personId === pid && recInfo(e, am).remaining > 0);
  const balTxt = bal > 0 ? `${esc(p.name)} owes you` : bal < 0 ? `You owe ${esc(p.name)}` : 'All settled';
  return `
  <div class="card ph">
    <div class="muted small">${esc(PERSON_KINDS[p.kind] || '')}${p.phone ? ' · ' + esc(p.phone) : ''}</div>
    <div class="bal ${bal > 0 ? 'in' : bal < 0 ? 'out' : ''}">${money(Math.abs(bal))}</div>
    <div class="muted">${balTxt}</div>
    ${dueTag(p, bal) ? `<div class="small mt">${dueTag(p, bal)} <button class="link small" data-act="editPerson" data-id="${pid}">change</button></div>` : ''}
  </div>
  <div class="qa">
    <button data-act="quickType" data-type="lent" data-p="${pid}">I gave</button>
    <button data-act="quickType" data-type="received" data-p="${pid}">I received</button>
    <button data-act="quickType" data-type="spentBy" data-p="${pid}">They spent for me</button>
  </div>
  <div class="btn-row">
    <button class="btn sm" data-act="shareWA" data-p="${pid}">WhatsApp statement</button>
    <button class="btn sm" data-act="printPerson" data-p="${pid}">PDF / print</button>
    <button class="btn sm" data-act="editPerson" data-id="${pid}">Edit</button>
  </div>
  ${openRec.length ? `<div class="sec-title">Pending recoverables from ${esc(p.name)} <button data-act="recoverForPerson" data-p="${pid}">Record recovery</button></div>
  <div class="card flush">${openRec.sort(sortDesc).map(e => entryItem(e)).join('')}</div>` : ''}
  <div class="sec-title">Statement (${lines.length})</div>
  <div class="card flush">${lines.length ? `<table class="ledger">${[...lines].reverse().map(l => `
    <tr data-act="openEntry" data-id="${l.e.id}"><td><div>${esc(l.label)}</div><div class="muted small">${fmtShort(l.date)}${l.e.note && !l.label.startsWith('Recovered') ? ' · ' + esc(l.e.note) : ''}${l.e.workId && work(l.e.workId) ? ' · ' + esc(work(l.e.workId).name) : ''}</div></td>
    <td class="num ${l.v > 0 ? 'in' : 'out'}">${money(l.v, true)}</td>
    <td class="num muted">${money(l.bal)}</td></tr>`).join('')}</table>` : '<div class="empty">No entries with this person yet.</div>'}</div>
  <p class="muted small mt">+ means they owe you more, − means less. Last column is the running balance.</p>`;
};

// ---------------- Add / edit form ----------------
let form = {};
// ---- Simple choices on screen, detailed types inside ----
// Money out: For me (expense) | Gets paid back (recoverable) | Give to a person (lent/advance/paid back)
// Money in:  Income | From a person (got back / borrowed)
// "Not yet" tick turns For me / Income into an upcoming (expected) item.
const UI_OF = { expense: ['out', 'me'], recoverable: ['out', 'back'], lent: ['out', 'person'], advance: ['out', 'person'], repaid: ['out', 'person'], income: ['in', 'income'], received: ['in', 'person'], borrowed: ['in', 'person'], transfer: ['move', ''] };
function uiFromType(t, direction) {
  if (t === 'expected') return { dir: direction === 'out' ? 'out' : 'in', kind: direction === 'out' ? 'me' : 'income', later: true };
  const [dir, kind] = UI_OF[t] || ['out', 'me'];
  return { dir, kind, later: false };
}
function deriveType() {
  const f = form;
  if (f.dir === 'move') f.type = 'transfer';
  else if (f.dir === 'out') f.type = f.kind === 'back' ? 'recoverable' : f.kind === 'person' ? 'lent' : (f.later ? 'expected' : 'expense');
  else f.type = f.kind === 'person' ? 'received' : (f.later ? 'expected' : 'income');
  if (f.type === 'expected') f.direction = f.dir === 'out' ? 'out' : 'in';
  if (!['me', 'income'].includes(f.kind)) f.later = false;
  const wantKind = (f.type === 'expense' || f.type === 'recoverable' || (f.type === 'expected' && f.direction === 'out')) ? 'out' : 'in';
  if (cat(f.categoryId) && cat(f.categoryId).kind !== wantKind) f.categoryId = '';
}
function formLocked() {
  if (!form.editingId) return false;
  const e = S.entries.find(x => x.id === form.editingId);
  return !!(e && e.type === 'recoverable' && !e.draft && recInfo(e).recovered > 0);
}
const UI_HINT = {
  'out:me': 'Your own spending. Counts in "Spent this month".',
  'out:me:later': 'Not paid yet. Shows under Pending → Upcoming until you tap Pay.',
  'out:back': 'You paid, but office, company or someone will repay you. Not your spending; stays in Pending until recovered.',
  'out:person': 'Cash handed to someone: a loan, a staff advance, or paying back what you owe. The app works out which from their balance.',
  'in:income': 'Salary, TA, online income…',
  'in:income:later': 'Not received yet (TA claim, arrears, payout). Shows under Pending → Upcoming until you tap Receive.',
  'in:person': 'Money from someone: they return what they owe you, or they lend you money.',
  'move:': 'Move money between your own accounts.'
};
function resetForm(over = {}) {
  const L = S.settings.last || {};
  const u = uiFromType(over.type || 'expense', over.direction);
  form = {
    type: 'expense', amount: '', date: today(), paidFrom: L.paidFrom || (S.accounts[0] ? 'a:' + S.accounts[0].id : ''),
    accountId: L.accountId || (S.accounts[0]?.id || ''), toAccountId: '', bookId: L.bookId || '', categoryId: '', workId: '',
    personId: '', recoverFrom: '', dueDate: '', direction: 'in', repeat: '', note: '',
    receipt: '', receiptData: '', saveTpl: false, tplName: '',
    editingId: null, draftId: null, linkExpected: null, returnTo: null, fromQuick: false, ...u, ...over
  };
  deriveType();
}
function setFormTypeForTest(t, direction) { const keep = form.amount; Object.assign(form, uiFromType(t, direction)); form.amount = keep; deriveType(); render(); }

function opt(list, val, empty) {
  return (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') + list.map(x => `<option value="${x.id}" ${x.id === val ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
}

VIEWS.add = () => {
  const f = form, T = TYPES[f.type] || TYPES.expense, has = k => T.f.includes(k);
  const ab = accountBalances(), pb = personBalances();
  const accOpts = S.accounts.map(a => ({ id: a.id, name: `${a.name} (${money(ab[a.id] || 0)})` }));
  const parts = [];

  if (!f.editingId) {
    parts.push(S.templates.length ? `<div class="chips" style="margin-bottom:12px">${S.templates.map(tp => `<button class="chip" data-act="useTpl" data-id="${tp.id}">${esc(tp.name)}</button>`).join('')}</div>` : '');
  }
  const lock = formLocked();
  const segBtn = (v, label) => `<button type="button" class="${f.dir === v ? 'on' : ''}" data-act="setDir" data-v="${v}" ${lock ? 'disabled' : ''}>${label}</button>`;
  parts.push(`<div class="seg">${segBtn('out', 'Money out')}${segBtn('in', 'Money in')}${segBtn('move', 'Transfer')}</div>`);
  const kinds = f.dir === 'out' ? [['me', 'For me'], ['back', 'Gets paid back'], ['person', 'Give to a person']]
    : f.dir === 'in' ? [['income', 'Income'], ['person', 'From a person']] : [];
  if (kinds.length) parts.push(`<div class="chips" style="margin-bottom:8px">${kinds.map(([k, l]) => `<button class="chip ${f.kind === k ? 'on' : ''}" data-act="setKind" data-v="${k}" ${lock ? 'disabled' : ''}>${l}</button>`).join('')}${f.dir === 'in' && !f.editingId ? '<button class="chip ghost" data-act="goPending" data-seg="rec">Office / someone repaid me ›</button>' : ''}</div>`);
  parts.push(`<div class="type-hint">${esc(UI_HINT[f.dir + ':' + (f.kind || '') + (f.later ? ':later' : '')] || '')}</div>`);
  if (['me', 'income'].includes(f.kind) && !f.linkExpected && !(f.editingId && !f.later && S.entries.find(x => x.id === f.editingId)?.linkExpected)) {
    parts.push(`<label class="inline-check" style="margin-top:-4px"><input type="checkbox" class="check" data-act="toggleLater" ${f.later ? 'checked' : ''} ${lock ? 'disabled' : ''}> ${f.dir === 'out' ? 'Not paid yet (due later)' : 'Not received yet (expected later)'}</label>`);
  }
  parts.push(`<div class="card">
    <div class="amount-box"><span>Rs</span><input id="amt" data-f="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(f.amount)}"><button type="button" class="calc" data-act="amtOp" data-op="+" aria-label="Add another amount">+</button></div>
    <div class="amount-preview" id="amtPreview"></div>`);



  if (has('paidFrom')) {
    const people = S.people.map(p => `<option value="p:${p.id}" ${f.paidFrom === 'p:' + p.id ? 'selected' : ''}>${esc(p.name)} (${pb[p.id] > 0 ? 'advance ' + money(pb[p.id]) : pb[p.id] < 0 ? 'I owe ' + money(-pb[p.id]) : 'no balance'})</option>`).join('');
    parts.push(`<div class="field"><label>Paid from</label><select data-f="paidFrom">
      <option value="">Select</option>
      <optgroup label="My accounts">${accOpts.map(a => `<option value="a:${a.id}" ${f.paidFrom === 'a:' + a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</optgroup>
      ${f.type === 'recoverable' ? `<optgroup label="Old pending amount"><option value="old" ${f.paidFrom === 'old' ? 'selected' : ''}>Before I started the app (no account)</option></optgroup>` : ''}
      ${S.people.length ? `<optgroup label="Paid by a person (from their advance, or I owe them)">${people}</optgroup>` : ''}
    </select></div>`);
  }
  if (has('person*')) parts.push(`<div class="field"><label>Person</label><div class="row"><select class="inp grow" data-f="personId">${opt(S.people, f.personId, 'Select person')}</select><button type="button" class="btn sm" data-act="editPerson" data-fromform="personId">+ New</button></div></div>`);
  if (has('account')) parts.push(`<div class="field"><label>${f.type === 'transfer' ? 'From account' : ['income', 'borrowed', 'received'].includes(f.type) ? 'Into account' : 'From account'}</label><select data-f="accountId">${opt(accOpts, f.accountId, 'Select account')}${['lent', 'borrowed', 'advance', 'received', 'repaid'].includes(f.type) ? `<option value="__old" ${f.accountId === '__old' ? 'selected' : ''}>Before I started the app (no account)</option>` : ''}</select></div>`);
  if ((has('paidFrom') && f.paidFrom === 'old') || (has('account') && f.accountId === '__old')) parts.push(`<div class="type-hint">Old amount: updates who owes whom, but does not change any account balance.</div>`);
  if (has('toAccount')) parts.push(`<div class="field"><label>To account</label><select data-f="toAccountId">${opt(accOpts, f.toAccountId, 'Select account')}</select></div>`);

  const dateLbl = T.dateLabel || 'Date';
  const showBook = has('book'), showCat = has('cat') || has('catIn') || has('catAny');
  const catKind = has('cat') ? 'out' : has('catIn') ? 'in' : (f.direction === 'out' ? 'out' : 'in');
  const cats = S.categories.filter(c => c.kind === catKind);
  parts.push(`<div class="two">
    <div class="field"><label>${dateLbl}</label><input type="date" data-f="date" value="${esc(f.date)}"></div>
    ${showBook ? `<div class="field"><label>Book</label><select data-f="bookId">${opt(S.books, f.bookId, 'None')}</select></div>`
      : showCat ? `<div class="field"><label>Category</label><select data-f="categoryId">${opt(cats, f.categoryId, 'None')}</select></div>`
      : has('due') ? `<div class="field"><label>${f.type === 'received' ? 'Rest promised by' : 'Return by'} (optional)</label><input type="date" data-f="dueDate" value="${esc(f.dueDate)}"></div>` : '<div></div>'}
  </div>`);
  if (showBook && showCat) parts.push(`<div class="field"><label>Category</label><select data-f="categoryId">${opt(cats, f.categoryId, 'None')}</select></div>`);
  if (has('recoverFrom')) parts.push(`<div class="field"><label>Recover from (optional)</label><div class="row"><select class="inp grow" data-f="recoverFrom">${opt(S.people, f.recoverFrom, 'Not decided yet')}</select><button type="button" class="btn sm" data-act="editPerson" data-fromform="recoverFrom">+ New</button></div></div>`);
  if (has('personOpt')) parts.push(`<div class="field"><label>From / to (optional)</label><select data-f="personId">${opt(S.people, f.personId, 'None')}</select></div>`);
  if (has('work') && (f.type !== 'lent' || f.workId || person(f.personId)?.kind === 'staff')) parts.push(`<div class="field"><label>Work / site (optional)</label><div class="row"><select class="inp grow" data-f="workId">${opt(S.works.filter(w => !w.closed || w.id === f.workId), f.workId, 'None')}</select><button type="button" class="btn sm" data-act="editWork" data-fromform="1">+ New</button></div></div>`);
  if (has('repeat')) parts.push(`<div class="field"><label>Repeat</label><select data-f="repeat"><option value="">Once</option><option value="monthly" ${f.repeat === 'monthly' ? 'selected' : ''}>Every month</option></select></div>`);
  parts.push(`<div class="field"><label>Note</label><input data-f="note" value="${esc(f.note)}" placeholder="What was it for?" maxlength="200"></div>`);
  if (has('receipt')) {
    const src = f.receiptData || (f.receipt ? imgCache[f.receipt] : '');
    parts.push(`<div class="field"><label>Receipt</label>${(f.receiptData || f.receipt)
      ? `<div class="receipt-thumb"><img id="rcptImg" src="${src || ''}" alt="Receipt"><button type="button" data-act="removeReceipt">×</button></div>`
      : `<button type="button" class="btn sm" data-act="pickReceipt">📎 Attach photo</button>`}</div>`);
  }
  parts.push(`</div>`);
  if (!f.editingId || f.draftId) parts.push(`<label class="inline-check"><input type="checkbox" class="check" data-f="saveTpl" ${f.saveTpl ? 'checked' : ''}> Save as quick template</label>
    ${f.saveTpl ? `<div class="field"><input data-f="tplName" value="${esc(f.tplName)}" placeholder="Template name, e.g. Govt vehicle fuel"></div>` : ''}`);
  if (f.editingId && !f.draftId) parts.push(`<button class="btn primary block" data-act="saveForm">Update</button>`);
  else parts.push(`<div class="btn-row"><button class="btn" data-act="saveNext">Save &amp; add next</button><button class="btn primary" data-act="saveForm">Save</button></div>`);
  if (f.editingId || f.linkExpected) parts.push(`<button class="btn block mt" data-act="cancelForm">Cancel</button>`);
  return parts.join('');
};

const imgCache = {};
async function loadImg(id) {
  if (!id) return '';
  if (imgCache[id]) return imgCache[id];
  const v = await DB.get('img', id);
  if (v) imgCache[id] = v;
  return v || '';
}
function afterAddRender() {
  updateAmtPreview();
  if (form.receipt && !form.receiptData && !imgCache[form.receipt]) loadImg(form.receipt).then(src => { const im = $('#rcptImg'); if (im) im.src = src; });
}
function updateAmtPreview() {
  const el = $('#amtPreview'); if (!el) return;
  const raw = String(form.amount || '');
  if (!raw.trim()) { el.textContent = 'Tap + to add several amounts, e.g. 1200 + 350'; return; }
  const v = evalAmount(raw);
  if (isNaN(v)) { el.innerHTML = '<span class="danger">Not a valid amount</span>'; return; }
  el.textContent = /[+\-*/x×]/.test(raw.replace(/^-/, '')) ? '= ' + money(v) : money(v);
}

function formToEntry() {
  const f = form, T = TYPES[f.type], has = k => T.f.includes(k);
  const amount = evalAmount(f.amount);
  if (!(amount > 0)) { toast('Enter a valid amount'); return null; }
  if (!f.date) { toast('Select a date'); return null; }
  const e = { type: f.type, amount, date: f.date, note: (f.note || '').trim() };
  if (has('paidFrom')) {
    if (!f.paidFrom) { toast('Select where the money came from'); return null; }
    const [k, id] = f.paidFrom.split(':');
    if (f.paidFrom === 'old') { if (f.type !== 'recoverable') { toast('Select where the money came from'); return null; } e.oldEntry = true; }
    else if (k === 'a') e.accountId = id; else e.viaPersonId = id;
  }
  if (has('account')) {
    if (!f.accountId) { toast('Select an account'); return null; }
    if (f.accountId === '__old') { if (!['lent', 'borrowed', 'advance', 'received', 'repaid'].includes(f.type)) { toast('Select an account'); return null; } e.oldEntry = true; }
    else e.accountId = f.accountId;
  }
  if (has('toAccount')) {
    if (!f.toAccountId) { toast('Select the destination account'); return null; }
    if (f.toAccountId === f.accountId) { toast('Choose two different accounts'); return null; }
    e.toAccountId = f.toAccountId;
  }
  if (has('book')) e.bookId = f.bookId || '';
  if (has('cat') || has('catIn') || has('catAny')) e.categoryId = f.categoryId || '';
  if (has('work')) e.workId = f.workId || '';
  if (has('recoverFrom')) {
    e.personId = f.recoverFrom || '';
    if (e.personId && e.personId === e.viaPersonId) { toast('Paid-by and recover-from cannot be the same person'); return null; }
  }
  if (has('person*')) { if (!f.personId) { toast('Select a person'); return null; } e.personId = f.personId; }
  if (has('personOpt')) e.personId = f.personId || '';
  if (has('due')) e.dueDate = f.dueDate || '';
  if (e.type === 'expected') e.direction = f.direction === 'out' ? 'out' : 'in';
  if (has('repeat')) e.repeat = f.repeat === 'monthly' ? 'monthly' : '';
  if (f.linkExpected) e.linkExpected = f.linkExpected;
  if (e.type === 'lent' || e.type === 'received') {
    const old = f.editingId ? S.entries.find(x => x.id === f.editingId) : null;
    const grp = e.type === 'lent' ? ['lent', 'advance', 'repaid'] : ['received', 'borrowed'];
    if (old && !old.draft && grp.includes(old.type) && old.personId === e.personId) e.type = old.type;
    else {
      const bal = personBalances()[e.personId] || 0, p = person(e.personId);
      e.type = e.type === 'lent' ? (bal < 0 ? 'repaid' : (p && p.kind === 'staff') ? 'advance' : 'lent') : (bal > 0 ? 'received' : 'borrowed');
    }
    if (e.type === 'advance' || e.type === 'repaid') delete e.dueDate;
  }
  return e;
}

const DIFF_KEYS = ['type', 'amount', 'date', 'oldEntry', 'accountId', 'toAccountId', 'viaPersonId', 'bookId', 'categoryId', 'workId', 'personId', 'dueDate', 'direction', 'repeat', 'note', 'receipt'];
function diffEntry(a, b) {
  const ch = {};
  for (const k of DIFF_KEYS) { const x = a[k] ?? '', y = b[k] ?? ''; if (x !== y) ch[k] = [x, y]; }
  return ch;
}

async function persistReceipt(oldId) {
  if (form.receiptData) {
    const id = 'img_' + uid();
    await DB.put('img', id, form.receiptData);
    imgCache[id] = form.receiptData;
    if (oldId) await DB.del('img', oldId);
    return id;
  }
  if (!form.receipt && oldId) { await DB.del('img', oldId); return ''; }
  return form.receipt || '';
}

async function saveForm(again = false) {
  const e = formToEntry();
  if (!e) return;
  const f = form;
  const nowIso = new Date().toISOString();
  let savedId;

  if (f.editingId) {
    const idx = S.entries.findIndex(x => x.id === f.editingId);
    if (idx < 0) { toast('Entry no longer exists'); return; }
    const old = S.entries[idx];
    if (old.type === 'recoverable') {
      const ri = recInfo(old), used = r2(ri.recovered + ri.writtenOff);
      if (used > 0 && e.type !== 'recoverable') { toast('Remove its recoveries / write-off first'); return; }
      if (e.amount < used) { toast(`Amount can't be below ${money(used)} already recovered/written off`); return; }
    }
    e.receipt = TYPES[e.type].f.includes('receipt') ? await persistReceipt(old.receipt) : (old.receipt ? (await DB.del('img', old.receipt), '') : '');
    const changes = diffEntry(old, e);
    const upd = { id: old.id, createdAt: old.createdAt || nowIso, history: old.history || [], ...e };
    if (e.type === 'recoverable' && old.writtenOff) upd.writtenOff = old.writtenOff;
    if (e.type === 'expected') { upd.closed = old.closed || false; upd.spawned = old.spawned || false; }
    if (old.draft) { upd.createdAt = nowIso; }
    else if (Object.keys(changes).length) upd.history = [...upd.history, { at: nowIso, changes }];
    S.entries[idx] = upd;
    savedId = upd.id;
  } else {
    const dup = live().find(x => x.type === e.type && x.amount === e.amount && x.date === e.date && (x.accountId || '') === (e.accountId || '') && (x.personId || '') === (e.personId || '') && (x.viaPersonId || '') === (e.viaPersonId || ''));
    if (dup && !(await confirmBox('Possible duplicate', `An entry of ${money(e.amount)} on ${fmtDate(e.date)} already exists ("${esc(entryTitle(dup))}"). Save anyway?`, 'Save anyway'))) return;
    e.receipt = TYPES[e.type].f.includes('receipt') ? await persistReceipt('') : '';
    e.id = uid(); e.createdAt = nowIso; e.history = [];
    S.entries.push(e);
    savedId = e.id;
  }

  if (e.linkExpected) afterExpectedPayment(e.linkExpected);
  if (e.dueDate && e.personId && person(e.personId)) person(e.personId).dueDate = e.dueDate;

  if (f.saveTpl) {
    const name = (f.tplName || '').trim() || entryTitle(e);
    S.templates.push({ id: uid(), name, data: { type: e.type, amount: f.amount && !/[+\-*/]/.test(f.amount) ? String(e.amount) : '', paidFrom: f.paidFrom, accountId: f.accountId, toAccountId: f.toAccountId, bookId: e.bookId || '', categoryId: e.categoryId || '', workId: e.workId || '', personId: f.personId, recoverFrom: f.recoverFrom, note: e.note, direction: f.direction } });
  }
  S.settings.last = { ...S.settings.last, paidFrom: (f.paidFrom && f.paidFrom !== 'old') ? f.paidFrom : S.settings.last.paidFrom, accountId: (f.accountId && f.accountId !== '__old') ? f.accountId : S.settings.last.accountId, bookId: f.bookId || S.settings.last.bookId };

  await save();
  const ret = f.returnTo;
  const wasEdit = !!f.editingId && !f.draftId;
  if (again && !wasEdit) {
    const keep = { type: f.type, direction: f.direction, dir: f.dir, kind: f.kind, later: f.later, date: f.date, paidFrom: f.paidFrom, accountId: f.accountId, bookId: f.bookId, personId: f.personId, workId: f.workId, recoverFrom: f.recoverFrom };
    resetForm(keep);
    tab = 'add'; stack = []; cur = { v: 'add', p: null };
    render(); window.scrollTo(0, 0);
    toast('Saved. Add the next one');
    setTimeout(() => $('#amt')?.focus(), 60);
    return;
  }
  resetForm();
  toast(wasEdit ? 'Updated' : 'Saved');
  if (ret) { tab = ret.tab; stack = ret.stack; cur = ret.cur; render(); }
  else setTab('home');
}

function cancelForm() {
  const ret = form.returnTo;
  resetForm();
  if (ret) { tab = ret.tab; stack = ret.stack; cur = ret.cur; render(); } else setTab('home');
}

function snapshotReturn() { return { tab, stack: [...stack], cur: { ...cur } }; }

function openFormWith(over) {
  resetForm({ ...over, returnTo: over.returnTo === undefined ? snapshotReturn() : over.returnTo, fromQuick: true });
  tab = 'add'; stack = []; cur = { v: 'add', p: null };
  render();
  window.scrollTo(0, 0);
  setTimeout(() => { const a = $('#amt'); if (a && !form.amount) a.focus(); }, 60);
}

function editEntry(id) {
  const e = S.entries.find(x => x.id === id);
  if (!e) return;
  if (!TYPES[e.type]) { toast('This entry type can only be deleted, not edited'); return; }
  const over = {
    type: e.type, amount: e.draft && !e.amount ? '' : String(e.amount), date: e.date, note: e.note || '',
    paidFrom: e.oldEntry ? 'old' : e.viaPersonId ? 'p:' + e.viaPersonId : (e.accountId ? 'a:' + e.accountId : ''),
    accountId: e.oldEntry ? '__old' : (e.accountId || ''), toAccountId: e.toAccountId || '', bookId: e.bookId || '', categoryId: e.categoryId || '',
    workId: e.workId || '', personId: e.type === 'recoverable' ? '' : (e.personId || ''), recoverFrom: e.type === 'recoverable' ? (e.personId || '') : '',
    dueDate: e.dueDate || '', direction: e.direction || 'in', repeat: e.repeat || '', receipt: e.receipt || '',
    editingId: e.id, draftId: e.draft ? e.id : null, linkExpected: e.linkExpected || null
  };
  if (!over.paidFrom) over.paidFrom = (S.settings.last.paidFrom || (S.accounts[0] ? 'a:' + S.accounts[0].id : ''));
  if (!over.accountId) over.accountId = S.settings.last.accountId || S.accounts[0]?.id || '';
  closeSheet();
  openFormWith(over);
}

// ---------------- Expected handling ----------------
function afterExpectedPayment(xid) {
  const x = S.entries.find(e => e.id === xid);
  if (!x) return;
  const xi = expectedInfo(x);
  if (xi.rem <= 0 && !x.closed) closeExpected(x);
}
function closeExpected(x) {
  x.closed = true;
  if (x.repeat === 'monthly' && !x.spawned) {
    x.spawned = true;
    S.entries.push({
      id: uid(), type: 'expected', amount: x.amount, date: addMonths(x.date, 1), note: x.note || '', categoryId: x.categoryId || '',
      personId: x.personId || '', direction: x.direction, repeat: 'monthly', closed: false, spawned: false,
      createdAt: new Date().toISOString(), history: []
    });
  }
}

// ---------------- Pending view ----------------
VIEWS.pending = () => {
  const seg = ui.pendingSeg;
  const head = `<div class="seg"><button class="${seg === 'rec' ? 'on' : ''}" data-act="seg" data-seg="rec">To get back</button><button class="${seg === 'exp' ? 'on' : ''}" data-act="seg" data-seg="exp">Upcoming</button></div>`;
  return head + (seg === 'rec' ? pendingRec() : pendingExp());
};

function pendingRec() {
  const am = allocMap(), t = today();
  let list = live().filter(e => e.type === 'recoverable');
  const all = list.map(e => ({ e, ri: recInfo(e, am) }));
  const openAll = all.filter(x => x.ri.remaining > 0);
  const totalOpen = r2(openAll.reduce((s, x) => s + x.ri.remaining, 0));
  const oldN = openAll.filter(x => daysBetween(x.e.date, t) > S.settings.alertDays).length;
  let rows = all.filter(x => ui.recFilter === 'open' ? x.ri.remaining > 0 : ui.recFilter === 'closed' ? x.ri.remaining <= 0 : true);
  if (ui.recPerson === '_none') rows = rows.filter(x => !x.e.personId);
  else if (ui.recPerson) rows = rows.filter(x => x.e.personId === ui.recPerson);
  rows.sort((a, b) => (a.e.date !== b.e.date ? (a.e.date < b.e.date ? -1 : 1) : ((a.e.createdAt || '') < (b.e.createdAt || '') ? -1 : 1)));
  for (const id of [...ui.sel]) if (!openAll.find(x => x.e.id === id)) ui.sel.delete(id);
  const selTotal = r2(openAll.filter(x => ui.sel.has(x.e.id)).reduce((s, x) => s + x.ri.remaining, 0));
  return `
  <div class="tiles">
    <div class="tile"><div class="lbl">Pending to recover</div><div class="val in">${money(totalOpen)}</div><div class="sub">${openAll.length} item${openAll.length !== 1 ? 's' : ''}</div></div>
    <div class="tile"><div class="lbl">Older than ${S.settings.alertDays} days</div><div class="val ${oldN ? 'warn' : ''}">${oldN}</div><div class="sub">follow these up</div></div>
  </div>
  <div class="two">
    <div class="field"><select data-ui="recFilter"><option value="open" ${ui.recFilter === 'open' ? 'selected' : ''}>Open</option><option value="closed" ${ui.recFilter === 'closed' ? 'selected' : ''}>Closed</option><option value="all" ${ui.recFilter === 'all' ? 'selected' : ''}>All</option></select></div>
    <div class="field"><select data-ui="recPerson"><option value="">Anyone</option><option value="_none" ${ui.recPerson === '_none' ? 'selected' : ''}>Not assigned</option>${S.people.map(p => `<option value="${p.id}" ${ui.recPerson === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
  </div>
  <div class="card flush">${rows.length ? rows.map(({ e, ri }) => {
    const age = daysBetween(e.date, t);
    const open = ri.remaining > 0;
    return `<div class="list-item">
      ${open ? `<input type="checkbox" class="check" data-act="toggleSel" data-id="${e.id}" ${ui.sel.has(e.id) ? 'checked' : ''}>` : ''}
      <button class="li-main" style="text-align:left" data-act="openEntry" data-id="${e.id}">
        <div class="li-title">${esc(entryTitle(e))}</div>
        <div class="li-sub">${fmtShort(e.date)} · ${age}d${person(e.personId) ? ' · from ' + esc(person(e.personId).name) : ''}${work(e.workId) ? ' · ' + esc(work(e.workId).name) : ''}</div>
      </button>
      <div class="li-amt">${money(open ? ri.remaining : e.amount)}<div class="li-sub"><span class="badge ${ri.status}">${ri.status}</span>${open && ri.remaining !== e.amount ? ' of ' + money(e.amount) : ''}</div></div>
    </div>`;
  }).join('') : '<div class="empty">Nothing here.</div>'}</div>
  ${ui.sel.size ? `<div style="height:64px"></div><div class="sticky-bar"><button class="btn primary block" data-act="recordRecovery">Record recovery · ${ui.sel.size} selected · ${money(selTotal)}</button></div>` : '<p class="muted small mt">Tick items, then record the money you got back against them.</p>'}`;
}

function pendingExp() {
  const t = today();
  let list = live().filter(e => e.type === 'expected').map(e => ({ e, xi: expectedInfo(e) }));
  const open = list.filter(x => !x.xi.closed).sort((a, b) => (a.e.date < b.e.date ? -1 : 1));
  const closed = list.filter(x => x.xi.closed).sort((a, b) => (a.e.date < b.e.date ? 1 : -1));
  const inSum = r2(open.filter(x => x.e.direction !== 'out').reduce((s, x) => s + x.xi.rem, 0));
  const outSum = r2(open.filter(x => x.e.direction === 'out').reduce((s, x) => s + x.xi.rem, 0));
  const row = ({ e, xi }) => {
    const od = !xi.closed && e.date < t;
    return `<div class="list-item">
      <button class="li-main" style="text-align:left" data-act="openEntry" data-id="${e.id}">
        <div class="li-title">${esc(entryTitle(e))}</div>
        <div class="li-sub ${od ? 'danger' : ''}">${fmtDate(e.date)}${od ? ' · overdue' : ''}${e.repeat ? ' · monthly' : ''}${person(e.personId) ? ' · ' + esc(person(e.personId).name) : ''}</div>
      </button>
      <div class="li-amt ${e.direction === 'out' ? 'out' : 'in'}">${e.direction === 'out' ? '-' : '+'}${money(xi.closed ? e.amount : xi.rem)}
      ${!xi.closed ? `<div><button class="btn sm" data-act="payExpected" data-id="${e.id}">${e.direction === 'out' ? 'Pay' : 'Receive'}</button></div>` : '<div class="li-sub">done</div>'}</div>
    </div>`;
  };
  return `
  <div class="tiles">
    <div class="tile"><div class="lbl">To receive</div><div class="val in">${money(inSum)}</div></div>
    <div class="tile"><div class="lbl">To pay</div><div class="val out">${money(outSum)}</div></div>
  </div>
  <button class="btn block" data-act="quickType" data-type="expected">+ Add upcoming payment or income</button>
  <div class="sec-title">Open</div>
  <div class="card flush">${open.length ? open.map(row).join('') : '<div class="empty">No open items. Add TA claims, arrears, payouts, or upcoming bills.</div>'}</div>
  <div class="sec-title">Done <button data-act="toggleExpClosed">${ui.expShowClosed ? 'Hide' : 'Show'}</button></div>
  ${ui.expShowClosed ? `<div class="card flush">${closed.length ? closed.map(row).join('') : '<div class="empty">None.</div>'}</div>` : ''}`;
}

// ---------------- More & sub-views ----------------
VIEWS.more = () => {
  const lb = S.settings.lastBackup;
  const item = (v, t, s) => `<button class="list-item" data-act="go" data-v="${v}"><div class="li-main"><div class="li-title">${t}</div><div class="li-sub">${s}</div></div>›</button>`;
  const ab = accountBalances();
  return `<div class="card flush">
    ${item('accounts', 'Accounts & balance check', `${S.accounts.length} accounts · total ${money(Object.values(ab).reduce((a, b) => a + b, 0))}`)}
    <button class="list-item" data-act="goEntries" data-filter=""><div class="li-main"><div class="li-title">All entries</div><div class="li-sub">${live().length} entries · search and filter</div></div>›</button>
    ${item('works', 'Works / sites', `${S.works.length} · spending per work, shareable report`)}
    ${item('templates', 'Quick templates', `${S.templates.length} saved`)}
    ${item('books', 'Books', S.books.map(b => b.name).join(', ') || 'None')}
    ${item('cats', 'Categories', `${S.categories.length} categories`)}
  </div>
  <div class="card flush">
    ${item('backup', 'Backup & restore', S.settings.drive.connected ? (S.settings.drive.needsReconnect ? 'Google Drive: reconnect needed' : 'Google Drive auto backup on' + (S.settings.drive.lastBackup ? ' · ' + fmtDate(S.settings.drive.lastBackup.slice(0, 10)) : '')) : lb ? 'Last backup ' + fmtDate(lb.slice(0, 10)) : 'Never backed up')}
    ${item('security', 'App lock', S.settings.pinHash ? 'PIN is on' : 'Off')}
    ${item('help', 'How it works', 'What each entry type does')}
  </div>
  <p class="muted small mt">Data is stored only on this device${DB.ok ? '' : ' (limited storage mode)'}. Back up regularly.</p>`;
};

VIEWS.accounts = () => {
  const ab = accountBalances();
  return `<div class="btn-row" style="margin-bottom:12px">
    <button class="btn" data-act="editAccount">+ Account</button>
    <button class="btn" data-act="quickType" data-type="transfer">Transfer</button>
  </div>
  <div class="card flush">${S.accounts.map(a => `<div class="list-item">
    <div class="li-main"><div class="li-title">${esc(a.name)}</div><div class="li-sub">Opening ${money(a.opening || 0)}</div></div>
    <div class="li-amt ${(ab[a.id] || 0) < 0 ? 'danger' : ''}">${money(ab[a.id] || 0)}
      <div><button class="btn sm" data-act="balanceCheck" data-id="${a.id}">Check</button> <button class="btn sm" data-act="editAccount" data-id="${a.id}">Edit</button></div></div>
  </div>`).join('') || '<div class="empty">No accounts.</div>'}</div>
  <p class="muted small mt"><b>Check</b>: enter what is actually in the wallet/bank. If it differs, one adjustment entry fixes the balance. Do this monthly.</p>`;
};

function simpleList(kind, items, sub) {
  return `<button class="btn block" style="margin-bottom:12px" data-act="editSimple" data-kind="${kind}">+ Add</button>
  <div class="card flush">${items.map(x => `<button class="list-item" data-act="editSimple" data-kind="${kind}" data-id="${x.id}">
    <div class="li-main"><div class="li-title">${esc(x.name)}</div>${sub ? `<div class="li-sub">${sub(x)}</div>` : ''}</div>›</button>`).join('') || '<div class="empty">None yet.</div>'}</div>`;
}
VIEWS.books = () => simpleList('book', S.books, b => `${live().filter(e => e.bookId === b.id).length} entries`);
VIEWS.cats = () => `<div class="sec-title">Spending</div>${simpleList('catout', S.categories.filter(c => c.kind === 'out'))}<div class="sec-title">Income</div>${simpleList('catin', S.categories.filter(c => c.kind === 'in'))}`;

function workStats(wid) {
  const am = allocMap();
  let own = 0, rec = 0, recPending = 0, adv = 0, viaStaff = 0;
  const entries = live().filter(e => e.workId === wid);
  for (const e of entries) {
    if (e.type === 'expense') { own = r2(own + e.amount); if (e.viaPersonId) viaStaff = r2(viaStaff + e.amount); }
    if (e.type === 'recoverable') { rec = r2(rec + e.amount); recPending = r2(recPending + recInfo(e, am).remaining); if (e.viaPersonId) viaStaff = r2(viaStaff + e.amount); }
    if (e.type === 'advance') adv = r2(adv + e.amount);
  }
  return { own, rec, recPending, adv, viaStaff, total: r2(own + rec), entries };
}
VIEWS.works = () => `<button class="btn block" style="margin-bottom:12px" data-act="editWork">+ Work / site</button>
  <div class="card flush">${S.works.map(w => { const st = workStats(w.id); return `<button class="list-item" data-act="go" data-v="work" data-p="${w.id}">
    <div class="li-main"><div class="li-title">${esc(w.name)}${w.closed ? ' <span class="badge">closed</span>' : ''}</div><div class="li-sub">${w.ref ? esc(w.ref) + ' · ' : ''}${st.entries.length} entries</div></div>
    <div class="li-amt">${money(st.total)}<div class="li-sub">${st.recPending ? 'pending ' + money(st.recPending) : ''}</div></div></button>`; }).join('') || '<div class="empty">No works yet. Add a site, project or estimate to group its spending.</div>'}</div>`;

VIEWS.work = (wid) => {
  const w = work(wid);
  if (!w) return '<div class="empty">Not found.</div>';
  const st = workStats(wid);
  return `<div class="tiles">
    <div class="tile"><div class="lbl">Total spent on work</div><div class="val">${money(st.total)}</div><div class="sub">own ${money(st.own)} · recoverable ${money(st.rec)}</div></div>
    <div class="tile"><div class="lbl">Pending to recover</div><div class="val in">${money(st.recPending)}</div><div class="sub">advances given ${money(st.adv)}</div></div>
  </div>
  <div class="btn-row" style="margin-bottom:12px">
    <button class="btn sm" data-act="shareWork" data-p="${wid}">WhatsApp summary</button>
    <button class="btn sm" data-act="printWork" data-p="${wid}">PDF / print</button>
    <button class="btn sm" data-act="editWork" data-id="${wid}">Edit</button>
  </div>
  ${w.ref ? `<p class="muted small" style="margin-bottom:8px">Ref: ${esc(w.ref)}</p>` : ''}
  <div class="card flush">${st.entries.length ? [...st.entries].sort(sortDesc).map(e => entryItem(e)).join('') : '<div class="empty">No entries linked to this work.</div>'}</div>`;
};

VIEWS.templates = () => `<div class="card flush">${S.templates.map(t => `<div class="list-item">
  <div class="li-main"><div class="li-title">${esc(t.name)}</div><div class="li-sub">${typeLabel(t.data.type)}${t.data.amount ? ' · ' + money(t.data.amount) : ''}</div></div>
  <button class="btn sm" data-act="renameTpl" data-id="${t.id}">Rename</button> <button class="btn sm danger" data-act="delTpl" data-id="${t.id}">Delete</button></div>`).join('') || '<div class="empty">No templates. On the Add screen, tick "Save as quick template".</div>'}</div>`;

VIEWS.entries = () => {
  const F = ui.entryFilter || (ui.entryFilter = { month: today().slice(0, 7), type: '', book: '', person: '', work: '', q: '', drafts: false, spentOnly: false });
  let list = S.entries.filter(e => F.drafts ? e.draft : !e.draft);
  if (!F.drafts) {
    if (F.month) list = list.filter(e => e.date.slice(0, 7) === F.month || (F.spentOnly && e.writtenOff && e.writtenOff.date.slice(0, 7) === F.month));
    if (F.spentOnly) list = list.filter(e => e.type === 'expense' || (e.type === 'recoverable' && e.writtenOff && (!F.month || e.writtenOff.date.slice(0, 7) === F.month)) || (e.type === 'adjustment' && e.amount < 0));
    if (F.type) list = list.filter(e => e.type === F.type);
    if (F.book) list = list.filter(e => e.bookId === F.book);
    if (F.person) list = list.filter(e => e.personId === F.person || e.viaPersonId === F.person);
    if (F.work) list = list.filter(e => e.workId === F.work);
  }
  if (F.q) { const q = F.q.toLowerCase(); list = list.filter(e => (entryTitle(e) + ' ' + entrySub(e) + ' ' + e.amount).toLowerCase().includes(q)); }
  list.sort(sortDesc);
  const types = [...TYPE_ORDER, 'recovery', 'adjustment'];
  return `<input class="inp" placeholder="Search note, person, amount…" value="${esc(F.q)}" data-ef="q" style="margin-bottom:10px">
  ${F.drafts ? `<div class="alert info"><span class="grow">Showing incomplete receipts</span><button class="link" data-act="clearEF">Show all</button></div>` : F.spentOnly ? `<div class="alert info"><span class="grow">Showing own spending only</span><button class="link" data-act="clearEF">Show all</button></div>` : ''}
  ${F.drafts ? '' : `<div class="two">
    <div class="field"><input type="month" value="${esc(F.month)}" data-ef="month"></div>
    <div class="field"><select data-ef="type"><option value="">All types</option>${types.map(t => `<option value="${t}" ${F.type === t ? 'selected' : ''}>${typeLabel(t)}</option>`).join('')}</select></div>
    <div class="field"><select data-ef="book"><option value="">All books</option>${S.books.map(b => `<option value="${b.id}" ${F.book === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
    <div class="field"><select data-ef="person"><option value="">All people</option>${S.people.map(p => `<option value="${p.id}" ${F.person === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
  </div>`}
  <div class="muted small" style="margin:0 2px 6px">${list.length} entr${list.length === 1 ? 'y' : 'ies'}${F.month && !F.drafts ? ' · ' + monthLabel(F.month) : ''}</div>
  <div class="card flush">${list.length ? list.map(e => entryItem(e)).join('') : '<div class="empty">No entries match.</div>'}</div>`;
};

VIEWS.backup = () => {
  const lb = S.settings.lastBackup;
  const d = S.settings.drive, cid = driveClientId();
  const fromConfig = !!(window.HISAAB_CONFIG && window.HISAAB_CONFIG.googleClientId);
  let drive;
  if (!cid) {
    drive = `<p style="margin-bottom:10px">Automatic backup to your own Google Drive needs a free Google Client ID (one-time setup). Put it in <b>config.js</b> on GitHub (recommended, works on any phone) or paste it here.</p>
      <div class="field"><input id="cidInp" placeholder="xxxx.apps.googleusercontent.com" autocomplete="off"></div>
      <button class="btn primary block" data-act="saveCid">Save Client ID</button>`;
  } else if (!d.connected) {
    drive = `<p style="margin-bottom:12px">Back up automatically to your own Google Drive, folder <b>Hisaab Backups</b>. The last ${KEEP_DAILY} days are kept.</p>
      <button class="btn primary block" data-act="driveConnect">Connect Google Drive</button>
      <button class="btn block mt" data-act="driveRestore">Restore from Google Drive</button>
      ${fromConfig ? '' : '<button class="link mt" data-act="clearCid">Change Client ID</button>'}`;
  } else {
    const status = d.needsReconnect ? '<span class="danger">Paused, reconnect needed</span>'
      : S.settings.driveDirty ? '<span class="warn">Changes waiting to back up</span>' : '<span class="in">Up to date</span>';
    drive = `<div class="dl"><span>Account</span><span>${esc(d.email || 'Connected')}</span></div>
      <div class="dl"><span>Last Drive backup</span><span>${d.lastBackup ? new Date(d.lastBackup).toLocaleString('en-GB') : 'not yet'}</span></div>
      <div class="dl"><span>Status</span><span>${status}</span></div>
      ${d.needsReconnect ? '<button class="btn primary block mt" data-act="driveReconnect">Reconnect Google Drive</button>' : ''}
      <label class="inline-check mt"><input type="checkbox" class="check" data-act="driveAutoToggle" ${d.auto ? 'checked' : ''}> Back up automatically</label>
      <div class="btn-row"><button class="btn primary" data-act="driveNow">Back up now</button><button class="btn" data-act="driveRestore">Restore</button></div>
      <button class="btn block mt" data-act="driveDisconnect">Disconnect</button>`;
  }
  return `<div class="sec-title">Google Drive</div>
  <div class="card">${drive}</div>
  <div class="sec-title">Backup file</div>
  <div class="card">
    <p style="margin-bottom:10px">A single file you can keep anywhere (WhatsApp to yourself, USB, email). Includes receipts.</p>
    <p class="muted small" style="margin-bottom:12px">Last file backup: <b>${lb ? new Date(lb).toLocaleString('en-GB') : 'never'}</b></p>
    <button class="btn block" data-act="exportBackup">Save backup file</button>
  </div>
  <div class="card">
    <p style="margin-bottom:10px">Restore replaces everything on this device with the backup file.</p>
    <button class="btn block" data-act="pickRestore">Restore from backup file</button>
  </div>
  <div class="card">
    <button class="btn danger block" data-act="eraseAll">Erase all data on this device</button>
  </div>`;
};

VIEWS.security = () => `<div class="card">
  ${S.settings.pinHash ? `<p style="margin-bottom:12px">PIN lock is <b>on</b>. The app locks on open and after ${S.settings.lockAfter} seconds in the background.</p>
    <div class="btn-row"><button class="btn" data-act="setPin">Change PIN</button><button class="btn danger" data-act="removePin">Turn off</button></div>`
  : `<p style="margin-bottom:12px">Set a 4–8 digit PIN to lock the app. If you forget it, the only way back in is erasing data and restoring a backup.</p>
    <button class="btn primary block" data-act="setPin">Set PIN</button>`}
  </div>`;

VIEWS.help = () => `<div class="card small">
  <p><b>Money out → For me</b>: your own spending. Only this counts in "Spent this month". Tick "Not paid yet" for a bill due later.</p><br>
  <p><b>Money out → Gets paid back</b>: you paid, office/company/someone repays you. Stays in Pending → To get back until you record the recovery or write it off.</p><br>
  <p><b>Money out → Give to a person</b>: loan, staff advance, or paying back what you owe. One button; the app labels it from the person's balance.</p><br>
  <p><b>Money in → Income</b>: salary, TA, online income. Tick "Not received yet" for a claim or payout still pending.</p><br>
  <p><b>Money in → From a person</b>: they return money, or lend you money.</p><br>
  <p><b>Paid by a person</b>: under "Paid from", pick a staff member when they spent from your advance (or paid for you).</p><br>
  <p><b>Before I started the app</b>: for old loans or recoverables, choose this instead of an account. The person's balance updates, your account balances don't (that money already left or arrived before you set your opening balances).</p><br>
  <p><b>Balance check</b>: in Accounts, enter the real wallet/bank amount; the difference is saved as an adjustment so totals stay true.</p>
</div>`;

// ---------------- Sheet (modal) ----------------
let sheetOpen = false;
function openSheet(html) {
  $('#sheet').innerHTML = html;
  $('#sheetWrap').hidden = false;
  sheetOpen = true;
}
function closeSheet() {
  $('#sheetWrap').hidden = true;
  $('#sheet').innerHTML = '';
  sheetOpen = false;
  if (confirmBox._res) { const r = confirmBox._res; confirmBox._res = null; r(false); }
}
function sheetHead(t) { return `<h3><span>${t}</span><button class="close" data-act="closeSheet" aria-label="Close">×</button></h3>`; }

function confirmBox(title, msgHtml, okText = 'Confirm', danger = false) {
  return new Promise(res => {
    openSheet(`${sheetHead(esc(title))}<p style="margin-bottom:16px">${msgHtml}</p>
      <div class="btn-row"><button class="btn" data-act="closeSheet">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-act="confirmOk">${esc(okText)}</button></div>`);
    confirmBox._res = res;
  });
}

// Entry detail
async function openEntry(id) {
  const e = S.entries.find(x => x.id === id);
  if (!e) return;
  const rows = [];
  const dl = (k, v) => { if (v !== '' && v != null) rows.push(`<div class="dl"><span>${k}</span><span>${v}</span></div>`); };
  dl('Type', esc(e.draft ? 'Incomplete (draft)' : typeLabel(e.type)));
  dl('Amount', `<b>${money(e.amount)}</b>`);
  dl(e.type === 'expected' ? 'Expected on' : 'Date', fmtDate(e.date));
  if (e.type === 'expected') dl('Direction', e.direction === 'out' ? 'I will pay' : 'I will receive');
  if (e.accountId) dl(e.type === 'transfer' ? 'From' : 'Account', esc(acc(e.accountId)?.name || '—'));
  if (e.toAccountId) dl('To', esc(acc(e.toAccountId)?.name || '—'));
  if (e.viaPersonId) dl('Paid by', esc(person(e.viaPersonId)?.name || '—'));
  if (e.personId) dl(e.type === 'recoverable' ? 'Recover from' : 'Person', esc(person(e.personId)?.name || '—'));
  if (e.bookId) dl('Book', esc(book(e.bookId)?.name || '—'));
  if (e.categoryId) dl('Category', esc(cat(e.categoryId)?.name || '—'));
  if (e.workId) dl('Work', esc(work(e.workId)?.name || '—'));
  if (e.dueDate) dl('Return by', fmtDate(e.dueDate));
  if (e.repeat) dl('Repeat', 'Monthly');
  if (e.note) dl('Note', esc(e.note));
  const actions = [];
  let extra = '';
  if (e.type === 'recoverable' && !e.draft) {
    const ri = recInfo(e);
    dl('Status', `<span class="badge ${ri.status}">${ri.status}</span>`);
    dl('Recovered', money(ri.recovered));
    if (ri.writtenOff) dl('Written off', `${money(ri.writtenOff)} on ${fmtDate(e.writtenOff.date)}`);
    dl('Remaining', `<b>${money(ri.remaining)}</b>`);
    const recs = live().filter(x => x.type === 'recovery' && (x.allocations || []).some(a => a.id === e.id));
    if (recs.length) extra += `<div class="sec-title">Recoveries</div><div class="card flush">${recs.map(r => { const a = r.allocations.find(a => a.id === e.id); return `<button class="list-item" data-act="openEntry" data-id="${r.id}"><div class="li-main"><div class="li-title">${fmtDate(r.date)}</div><div class="li-sub">${esc(acc(r.accountId)?.name || '')}</div></div><div class="li-amt in">${money(a.amount)}</div></button>`; }).join('')}</div>`;
    if (ri.remaining > 0) { actions.push(`<button class="btn primary" data-act="recoverOne" data-id="${e.id}">Record recovery</button>`); actions.push(`<button class="btn" data-act="writeOff" data-id="${e.id}">Write off</button>`); }
    if (e.writtenOff) actions.push(`<button class="btn" data-act="undoWriteOff" data-id="${e.id}">Undo write-off</button>`);
  }
  if (e.type === 'recovery') {
    extra += `<div class="sec-title">Applied to</div><div class="card flush">${(e.allocations || []).map(a => { const r = S.entries.find(x => x.id === a.id); return `<div class="list-item"><div class="li-main"><div class="li-title">${r ? esc(entryTitle(r)) : 'Deleted item'}</div><div class="li-sub">${r ? fmtDate(r.date) : ''}</div></div><div class="li-amt">${money(a.amount)}</div></div>`; }).join('') || '<div class="empty">None</div>'}</div>`;
  }
  if (e.type === 'expected' && !e.draft) {
    const xi = expectedInfo(e);
    dl('Settled so far', money(xi.got));
    dl('Remaining', money(xi.rem));
    if (!xi.closed) { actions.push(`<button class="btn primary" data-act="payExpected" data-id="${e.id}">${e.direction === 'out' ? 'Pay' : 'Receive'}</button>`); actions.push(`<button class="btn" data-act="closeExp" data-id="${e.id}">Mark done</button>`); }
    else if (e.closed) actions.push(`<button class="btn" data-act="reopenExp" data-id="${e.id}">Reopen</button>`);
  }
  if (e.linkExpected) { const x = S.entries.find(y => y.id === e.linkExpected); if (x) dl('For expected', esc(entryTitle(x))); }
  if (TYPES[e.type]) actions.push(`<button class="btn ${e.draft ? 'primary' : ''}" data-act="editEntry" data-id="${e.id}">${e.draft ? 'Complete' : 'Edit'}</button>`);
  actions.push(`<button class="btn danger" data-act="deleteEntry" data-id="${e.id}">Delete</button>`);
  if (e.history && e.history.length) {
    extra += `<div class="sec-title">Edit history</div><div class="card small">${e.history.map(h => `<div style="margin-bottom:6px"><b>${new Date(h.at).toLocaleString('en-GB')}</b><br>${Object.entries(h.changes).map(([k, [a, b]]) => `${esc(k)}: ${esc(fmtHist(k, a))} → ${esc(fmtHist(k, b))}`).join('<br>')}</div>`).join('')}</div>`;
  }
  openSheet(`${sheetHead(esc(entryTitle(e)))}<div class="card">${rows.join('')}</div>
    ${e.receipt ? `<div class="card"><img class="full" id="detailImg" alt="Receipt"></div>` : ''}
    ${extra}<div class="btn-row mt">${actions.join('')}</div>`);
  if (e.receipt) { const src = await loadImg(e.receipt); const im = $('#detailImg'); if (im) im.src = src; }
}
function fmtHist(k, v) {
  if (v === '' || v == null) return '—';
  if (k === 'amount') return money(v);
  if (k === 'accountId' || k === 'toAccountId') return acc(v)?.name || v;
  if (k === 'personId' || k === 'viaPersonId') return person(v)?.name || v;
  if (k === 'bookId') return book(v)?.name || v;
  if (k === 'categoryId') return cat(v)?.name || v;
  if (k === 'workId') return work(v)?.name || v;
  if (k === 'type') return typeLabel(v);
  if (k === 'receipt') return 'photo';
  return String(v);
}

async function deleteEntry(id) {
  const e = S.entries.find(x => x.id === id);
  if (!e) return;
  if (e.type === 'recoverable') {
    const recs = live().filter(x => x.type === 'recovery' && (x.allocations || []).some(a => a.id === id));
    if (recs.length) { toast('Delete its recovery entries first'); return; }
  }
  const linked = e.type === 'expected' ? live().filter(x => x.linkExpected === id).length : 0;
  const ok = await confirmBox('Delete entry', `Delete "${esc(entryTitle(e))}" of ${money(e.amount)}?${linked ? ' Linked payments will be kept.' : ''} This cannot be undone.`, 'Delete', true);
  if (!ok) return;
  if (e.receipt) { await DB.del('img', e.receipt); delete imgCache[e.receipt]; }
  S.entries = S.entries.filter(x => x.id !== id);
  if (linked) S.entries.forEach(x => { if (x.linkExpected === id) delete x.linkExpected; });
  if (e.linkExpected) { const x = S.entries.find(y => y.id === e.linkExpected); if (x && x.closed && expectedInfo(x).rem > 0) x.closed = false; }
  await save();
  closeSheet();
  toast('Deleted');
  render();
}

// Recovery allocation
function openRecovery(ids) {
  const am = allocMap();
  const items = ids.map(id => S.entries.find(e => e.id === id)).filter(Boolean)
    .map(e => ({ e, rem: recInfo(e, am).remaining })).filter(x => x.rem > 0)
    .sort((a, b) => (a.e.date !== b.e.date ? (a.e.date < b.e.date ? -1 : 1) : ((a.e.createdAt || '') < (b.e.createdAt || '') ? -1 : 1)));
  if (!items.length) { toast('Select pending items first'); return; }
  const total = r2(items.reduce((s, x) => s + x.rem, 0));
  const pids = [...new Set(items.map(x => x.e.personId || ''))];
  const pid = pids.length === 1 ? pids[0] : '';
  recState = { items: items.map(x => ({ id: x.e.id, rem: x.rem, alloc: x.rem })) };
  const ab = accountBalances();
  openSheet(`${sheetHead('Record recovery')}
    <div class="field"><label>Amount received</label><input id="rcAmt" inputmode="decimal" value="${total}" data-rc="amt"></div>
    <div class="two">
      <div class="field"><label>Into account</label><select id="rcAcc">${opt(S.accounts.map(a => ({ id: a.id, name: `${a.name} (${money(ab[a.id] || 0)})` })), S.settings.last.accountId || S.accounts[0]?.id)}</select></div>
      <div class="field"><label>Date</label><input type="date" id="rcDate" value="${today()}"></div>
    </div>
    <div class="field"><label>Received from (optional)</label><select id="rcPerson">${opt(S.people, pid, 'Not specified')}</select></div>
    <div class="field"><label>Note / reference</label><input id="rcNote" placeholder="e.g. Estimate no., cheque no."></div>
    <div class="sec-title">Applied to (oldest first)</div>
    <div class="card flush" id="rcList">${items.map((x, i) => `<div class="list-item">
      <div class="li-main"><div class="li-title">${esc(entryTitle(x.e))}</div><div class="li-sub">${fmtShort(x.e.date)} · pending ${money(x.rem)}</div></div>
      <input class="inp" style="width:110px;text-align:right" inputmode="decimal" data-rc="alloc" data-i="${i}" value="${x.rem}"></div>`).join('')}</div>
    <div id="rcMsg" class="small mt"></div>
    <button class="btn primary block mt" data-act="saveRecovery">Save recovery</button>`);
  updateRecMsg();
}
let recState = null;
function autoDistribute() {
  const amt = evalAmount($('#rcAmt').value);
  let left = isNaN(amt) ? 0 : amt;
  recState.items.forEach((it, i) => {
    const a = Math.max(0, Math.min(it.rem, r2(left)));
    it.alloc = a; left = r2(left - a);
    const inp = $(`[data-rc="alloc"][data-i="${i}"]`); if (inp) inp.value = a;
  });
  updateRecMsg();
}
function updateRecMsg() {
  const amt = evalAmount($('#rcAmt')?.value);
  const allocated = r2(recState.items.reduce((s, it) => s + (Number(it.alloc) || 0), 0));
  const el = $('#rcMsg'); if (!el) return;
  if (isNaN(amt) || amt <= 0) { el.innerHTML = '<span class="danger">Enter the amount received</span>'; return; }
  const over = recState.items.find(it => it.alloc > it.rem + 0.004);
  if (over) { el.innerHTML = '<span class="danger">An item is allocated more than its pending amount</span>'; return; }
  const diff = r2(amt - allocated);
  if (diff < 0) el.innerHTML = `<span class="danger">Allocated ${money(allocated)} is more than received ${money(amt)}</span>`;
  else if (diff > 0) el.innerHTML = `<span class="warn">${money(diff)} not matched to any item — it will be saved as income.</span>`;
  else el.innerHTML = `<span class="in">Fully matched: ${money(allocated)}</span>`;
}
async function saveRecovery() {
  const amt = evalAmount($('#rcAmt').value);
  if (!(amt > 0)) { toast('Enter the amount received'); return; }
  const accountId = $('#rcAcc').value, date = $('#rcDate').value, personId = $('#rcPerson').value, note = $('#rcNote').value.trim();
  if (!accountId) { toast('Select an account'); return; }
  if (!date) { toast('Select a date'); return; }
  const allocs = recState.items.map(it => ({ id: it.id, amount: r2(Number(it.alloc) || 0) })).filter(a => a.amount > 0);
  if (recState.items.some(it => it.alloc > it.rem + 0.004)) { toast('An item is over-allocated'); return; }
  const allocated = r2(allocs.reduce((s, a) => s + a.amount, 0));
  if (allocated > amt + 0.004) { toast('Allocated more than received'); return; }
  if (!allocs.length) { toast('Allocate the amount to at least one item'); return; }
  const now = new Date().toISOString();
  S.entries.push({ id: uid(), type: 'recovery', amount: allocated, date, accountId, personId, note, allocations: allocs, createdAt: now, history: [] });
  const extra = r2(amt - allocated);
  if (extra > 0) S.entries.push({ id: uid(), type: 'income', amount: extra, date, accountId, note: 'Extra with recovery' + (note ? ': ' + note : ''), categoryId: '', createdAt: now, history: [] });
  S.settings.last.accountId = accountId;
  ui.sel.clear();
  await save();
  closeSheet();
  toast('Recovery saved');
  render();
}

// Write-off
function openWriteOff(id) {
  const e = S.entries.find(x => x.id === id); if (!e) return;
  const ri = recInfo(e);
  openSheet(`${sheetHead('Write off')}
    <p style="margin-bottom:12px">Write off ${money(ri.remaining)} of "${esc(entryTitle(e))}"? It stops being pending and becomes your own spending on the date below.</p>
    <div class="field"><label>Date</label><input type="date" id="woDate" value="${today()}"></div>
    <div class="btn-row"><button class="btn" data-act="closeSheet">Cancel</button><button class="btn danger" data-act="saveWriteOff" data-id="${id}">Write off</button></div>`);
}
async function saveWriteOff(id) {
  const e = S.entries.find(x => x.id === id); if (!e) return;
  const ri = recInfo(e);
  const d = $('#woDate').value || today();
  e.writtenOff = { amount: r2(ri.remaining + ri.writtenOff), date: d };
  e.history = [...(e.history || []), { at: new Date().toISOString(), changes: { writtenOff: ['', money(e.writtenOff.amount)] } }];
  await save(); closeSheet(); toast('Written off'); render();
}

// Balance check
function openBalanceCheck(id) {
  const a = acc(id); if (!a) return;
  const bal = accountBalances()[id] || 0;
  openSheet(`${sheetHead('Balance check · ' + esc(a.name))}
    <div class="dl"><span>App balance</span><span><b>${money(bal)}</b></span></div>
    <div class="field mt"><label>Actual amount in ${esc(a.name)} now</label><input id="bcAmt" inputmode="decimal" data-bc="1" placeholder="${bal}"></div>
    <div id="bcMsg" class="small" style="margin-bottom:12px"></div>
    <button class="btn primary block" data-act="saveBalanceCheck" data-id="${id}">Save adjustment</button>`);
}
async function saveBalanceCheck(id) {
  const v = evalAmount($('#bcAmt').value);
  if (isNaN(v)) { toast('Enter the actual amount'); return; }
  const bal = accountBalances()[id] || 0;
  const diff = r2(v - bal);
  if (diff === 0) { toast('Balance already matches'); closeSheet(); return; }
  S.entries.push({ id: uid(), type: 'adjustment', amount: diff, date: today(), accountId: id, note: diff < 0 ? 'Unrecorded spending (balance check)' : 'Unrecorded income (balance check)', createdAt: new Date().toISOString(), history: [] });
  await save(); closeSheet(); toast('Adjusted by ' + money(diff, true)); render();
}

// Person / account / work / simple editors
let editorReturnField = null;
function openPersonEditor(id, fromField) {
  const p = id ? person(id) : null;
  editorReturnField = fromField || null;
  openSheet(`${sheetHead(p ? 'Edit person' : 'New person')}
    <div class="field"><label>Name</label><input id="pName" value="${esc(p?.name || '')}" placeholder="Name, or office/company"></div>
    <div class="field"><label>Type</label><select id="pKind">${Object.entries(PERSON_KINDS).map(([k, v]) => `<option value="${k}" ${(p?.kind || 'friend') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label>WhatsApp / phone (optional)</label><input id="pPhone" type="tel" value="${esc(p?.phone || '')}" placeholder="03xx xxxxxxx"></div>
    ${p ? `<div class="field"><label>Payment promised by (optional, clear to remove)</label><input id="pDue" type="date" value="${esc(p.dueDate || '')}"></div>` : ''}
    <div class="btn-row">${p ? `<button class="btn danger" data-act="deletePerson" data-id="${p.id}">Delete</button>` : ''}<button class="btn primary" data-act="savePerson" data-id="${p?.id || ''}">Save</button></div>`);
  setTimeout(() => $('#pName')?.focus(), 50);
}
async function savePerson(id) {
  const name = $('#pName').value.trim();
  if (!name) { toast('Enter a name'); return; }
  if (S.people.some(p => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) { toast('A person with this name exists'); return; }
  const data = { name, kind: $('#pKind').value, phone: $('#pPhone').value.trim() };
  if ($('#pDue')) data.dueDate = $('#pDue').value || '';
  let pid = id;
  if (id) Object.assign(person(id), data);
  else { pid = uid(); S.people.push({ id: pid, ...data }); }
  await save();
  closeSheet();
  if (editorReturnField && cur.v === 'add') { form[editorReturnField] = pid; }
  editorReturnField = null;
  toast('Saved');
  render();
}
async function deletePerson(id) {
  const used = S.entries.filter(e => e.personId === id || e.viaPersonId === id).length;
  if (used) { toast(`Used in ${used} entries — cannot delete`); return; }
  if (!(await confirmBox('Delete person', 'Delete this person?', 'Delete', true))) return;
  S.people = S.people.filter(p => p.id !== id);
  await save(); toast('Deleted');
  if (cur.v === 'person') back(); else render();
}
function openAccountEditor(id) {
  const a = id ? acc(id) : null;
  openSheet(`${sheetHead(a ? 'Edit account' : 'New account')}
    <div class="field"><label>Name</label><input id="aName" value="${esc(a?.name || '')}" placeholder="e.g. Meezan Bank"></div>
    <div class="field"><label>Opening balance (when you started using the app)</label><input id="aOpen" inputmode="decimal" value="${a ? a.opening || 0 : ''}" placeholder="0"></div>
    <div class="btn-row">${a ? `<button class="btn danger" data-act="deleteAccount" data-id="${a.id}">Delete</button>` : ''}<button class="btn primary" data-act="saveAccount" data-id="${a?.id || ''}">Save</button></div>`);
}
async function saveAccount(id) {
  const name = $('#aName').value.trim();
  if (!name) { toast('Enter a name'); return; }
  const raw = $('#aOpen').value.trim();
  const opening = raw === '' ? 0 : evalAmount(raw);
  if (isNaN(opening)) { toast('Opening balance is not a valid number'); return; }
  if (id) Object.assign(acc(id), { name, opening });
  else S.accounts.push({ id: uid(), name, opening });
  await save(); closeSheet(); toast('Saved'); render();
}
async function deleteAccount(id) {
  const used = S.entries.filter(e => e.accountId === id || e.toAccountId === id).length;
  if (used) { toast(`Used in ${used} entries — cannot delete`); return; }
  if (S.accounts.length <= 1) { toast('Keep at least one account'); return; }
  if (!(await confirmBox('Delete account', 'Delete this account?', 'Delete', true))) return;
  S.accounts = S.accounts.filter(a => a.id !== id);
  await save(); toast('Deleted'); render();
}
function openWorkEditor(id, fromForm) {
  const w = id ? work(id) : null;
  editorReturnField = fromForm ? 'workId' : null;
  openSheet(`${sheetHead(w ? 'Edit work / site' : 'New work / site')}
    <div class="field"><label>Name</label><input id="wName" value="${esc(w?.name || '')}" placeholder="e.g. Office repair, Site name"></div>
    <div class="field"><label>Reference (optional)</label><input id="wRef" value="${esc(w?.ref || '')}" placeholder="Estimate / project no."></div>
    ${w ? `<label class="inline-check"><input type="checkbox" class="check" id="wClosed" ${w.closed ? 'checked' : ''}> Closed (hide from Add screen)</label>` : ''}
    <div class="btn-row">${w ? `<button class="btn danger" data-act="deleteWork" data-id="${w.id}">Delete</button>` : ''}<button class="btn primary" data-act="saveWork" data-id="${w?.id || ''}">Save</button></div>`);
  setTimeout(() => $('#wName')?.focus(), 50);
}
async function saveWork(id) {
  const name = $('#wName').value.trim();
  if (!name) { toast('Enter a name'); return; }
  const data = { name, ref: $('#wRef').value.trim() };
  if ($('#wClosed')) data.closed = $('#wClosed').checked;
  let wid = id;
  if (id) Object.assign(work(id), data);
  else { wid = uid(); S.works.push({ id: wid, closed: false, ...data }); }
  await save(); closeSheet();
  if (editorReturnField && cur.v === 'add') form.workId = wid;
  editorReturnField = null;
  toast('Saved'); render();
}
async function deleteWork(id) {
  const used = S.entries.filter(e => e.workId === id).length;
  if (used) { toast(`Used in ${used} entries — mark it closed instead`); return; }
  if (!(await confirmBox('Delete work', 'Delete this work?', 'Delete', true))) return;
  S.works = S.works.filter(w => w.id !== id);
  await save(); toast('Deleted');
  if (cur.v === 'work') back(); else render();
}
function openSimpleEditor(kind, id) {
  const arr = kind === 'book' ? S.books : S.categories;
  const x = id ? arr.find(i => i.id === id) : null;
  const what = kind === 'book' ? 'book' : 'category';
  openSheet(`${sheetHead((x ? 'Edit ' : 'New ') + what)}
    <div class="field"><label>Name</label><input id="sName" value="${esc(x?.name || '')}"></div>
    <div class="btn-row">${x ? `<button class="btn danger" data-act="deleteSimple" data-kind="${kind}" data-id="${x.id}">Delete</button>` : ''}<button class="btn primary" data-act="saveSimple" data-kind="${kind}" data-id="${x?.id || ''}">Save</button></div>`);
  setTimeout(() => $('#sName')?.focus(), 50);
}
async function saveSimple(kind, id) {
  const name = $('#sName').value.trim();
  if (!name) { toast('Enter a name'); return; }
  if (kind === 'book') { if (id) book(id).name = name; else S.books.push({ id: uid(), name }); }
  else { if (id) cat(id).name = name; else S.categories.push({ id: uid(), name, kind: kind === 'catin' ? 'in' : 'out' }); }
  await save(); closeSheet(); toast('Saved'); render();
}
async function deleteSimple(kind, id) {
  const key = kind === 'book' ? 'bookId' : 'categoryId';
  const used = S.entries.filter(e => e[key] === id).length + S.templates.filter(t => t.data[key] === id).length;
  if (used) { toast(`In use (${used}) — rename instead`); return; }
  if (!(await confirmBox('Delete', 'Delete this item?', 'Delete', true))) return;
  if (kind === 'book') S.books = S.books.filter(b => b.id !== id); else S.categories = S.categories.filter(c => c.id !== id);
  await save(); toast('Deleted'); render();
}

// ---------------- Sharing & reports ----------------
function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '92' + d.slice(1);
  else if (d.length === 10 && d.startsWith('3')) d = '92' + d;
  return d;
}
function openWhatsApp(phone, text) {
  const n = waNumber(phone);
  const url = `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank');
}
function personStatementText(pid) {
  const p = person(pid);
  const bal = personBalances()[pid] || 0;
  const lines = personLines(pid);
  const balTxt = bal > 0 ? `Balance: you owe me ${money(bal)}` : bal < 0 ? `Balance: I owe you ${money(-bal)}` : 'Balance: settled';
  const last = lines.slice(-15);
  const say = l => ({ 'You gave': 'I gave you', 'Advance given': 'Advance to you', 'You paid them': 'I paid you', 'They gave you': 'You gave me', 'They paid you': 'You paid me', 'Spent for me': 'You spent for me', 'Recoverable': 'To be repaid to me', 'Written off': 'Waived' }[l.label] || (l.label.startsWith('Recovered') ? 'You repaid' : l.label));
  const body = last.map(l => `${fmtShort(l.date)}: ${say(l)} ${money(Math.abs(l.v))}${l.e.note && !l.label.startsWith('Recovered') ? ' (' + l.e.note + ')' : ''}`).join('\n');
  const due = p.dueDate && bal ? `\n${bal > 0 ? 'Promised by' : 'I will pay by'} ${fmtDate(p.dueDate)}` : '';
  return `Hisaab: ${p.name}\nAs of ${fmtDate(today())}\n${balTxt.replace('Balance: ', '').replace(/^./, c => c.toUpperCase())}${due}\n\n${lines.length > 15 ? 'Last 15 of ' + lines.length + ' entries:\n' : ''}${body || 'No entries'}`;
}
function printHTML(title, meta, headCols, rows, sumHtml) {
  $('#print').innerHTML = `<h1>${esc(title)}</h1><div class="meta">${meta}</div>${sumHtml ? `<div class="sum">${sumHtml}</div>` : ''}
    <table><thead><tr>${headCols.map(c => `<th class="${c.n ? 'n' : ''}">${esc(c.t)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${headCols[i].n ? 'n' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <p class="meta" style="margin-top:4mm">Generated by Hisaab on ${new Date().toLocaleString('en-GB')}</p>`;
  setTimeout(() => window.print(), 50);
}
function printPerson(pid) {
  const p = person(pid); const bal = personBalances()[pid] || 0;
  const lines = personLines(pid);
  printHTML(`Statement: ${p.name}`, `${esc(PERSON_KINDS[p.kind] || '')}${p.phone ? ' · ' + esc(p.phone) : ''} · as of ${fmtDate(today())}`,
    [{ t: 'Date' }, { t: 'Detail' }, { t: 'Amount', n: 1 }, { t: 'Balance', n: 1 }],
    lines.map(l => [fmtDate(l.date), esc(l.label) + (l.e.note && !l.label.startsWith('Recovered') ? ' — ' + esc(l.e.note) : '') + (work(l.e.workId) ? ' [' + esc(work(l.e.workId).name) + ']' : ''), money(l.v, true), money(l.bal)]),
    bal > 0 ? `${esc(p.name)} owes ${money(bal)}` : bal < 0 ? `Owed to ${esc(p.name)}: ${money(-bal)}` : 'Settled');
}
function workText(wid) {
  const w = work(wid); const st = workStats(wid);
  const lines = [...st.entries].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-20).map(e => `${fmtShort(e.date)} · ${typeLabel(e.type)} · ${entryTitle(e)} · ${money(e.amount)}`);
  return `Work: ${w.name}${w.ref ? ' (' + w.ref + ')' : ''}\nAs of ${fmtDate(today())}\nTotal spent: ${money(st.total)}\nRecoverable: ${money(st.rec)} (pending ${money(st.recPending)})\nAdvances given: ${money(st.adv)}\n\n${lines.join('\n')}`;
}
function printWork(wid) {
  const w = work(wid); const st = workStats(wid); const am = allocMap();
  printHTML(`Work report: ${w.name}`, `${w.ref ? 'Ref: ' + esc(w.ref) + ' · ' : ''}as of ${fmtDate(today())}`,
    [{ t: 'Date' }, { t: 'Type' }, { t: 'Detail' }, { t: 'Status' }, { t: 'Amount', n: 1 }],
    [...st.entries].sort((a, b) => (a.date < b.date ? -1 : 1)).map(e => [fmtDate(e.date), esc(typeLabel(e.type)), esc(entryTitle(e)) + (person(e.viaPersonId) ? ' (paid by ' + esc(person(e.viaPersonId).name) + ')' : ''), e.type === 'recoverable' ? recInfo(e, am).status : '', money(e.amount)]),
    `Total spent ${money(st.total)} · Recoverable ${money(st.rec)} · Pending ${money(st.recPending)} · Advances ${money(st.adv)}`);
}

// ---------------- Backup ----------------
async function exportBackup() {
  const imgs = {};
  for (const k of await DB.keys('img')) imgs[k] = await DB.get('img', k);
  const payload = { app: 'hisaab', version: 1, exportedAt: new Date().toISOString(), state: S, images: imgs };
  const json = JSON.stringify(payload);
  const name = `hisaab-backup-${today()}.json`;
  const blob = new Blob([json], { type: 'application/json' });
  let shared = false;
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      shared = true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  if (!shared) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  S.settings.lastBackup = new Date().toISOString();
  await save();
  toast('Backup saved');
  render();
}
async function restoreFromFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('Not a valid backup file'); return; }
  if (!data || data.app !== 'hisaab' || !data.state || !Array.isArray(data.state.entries)) { toast('Not a Hisaab backup file'); return; }
  const n = data.state.entries.length;
  if (!(await confirmBox('Restore backup', `Replace all data on this device with the backup from ${data.exportedAt ? new Date(data.exportedAt).toLocaleString('en-GB') : 'unknown date'} (${n} entries)?`, 'Restore', true))) return;
  applyRestoredState(data.state, false);
  await DB.clear('img');
  for (const k in imgCache) delete imgCache[k];
  for (const [k, v] of Object.entries(data.images || {})) await DB.put('img', k, v);
  await save();
  toast(data.driveImages ? 'Restored (receipts are on Drive: use Restore from Google Drive to get them)' : 'Restored');
  setTab('home');
}
// Replace data with a backup, but keep this device's PIN and Google connection
function applyRestoredState(st, fromDrive) {
  const keep = { pinHash: S.settings.pinHash, pinSalt: S.settings.pinSalt, pinLen: S.settings.pinLen, googleClientId: S.settings.googleClientId };
  const curDrive = { ...S.settings.drive };
  S = normalizeState(st);
  Object.assign(S.settings, keep);
  const d = S.settings.drive;
  d.connected = fromDrive ? true : curDrive.connected;
  d.email = curDrive.email || d.email;
  d.auto = curDrive.connected ? curDrive.auto : d.auto;
  d.needsReconnect = false;
  d.lastAttempt = 0;
  if (!fromDrive && !curDrive.connected) { d.folderId = curDrive.folderId; d.imgFolderId = curDrive.imgFolderId; d.imgs = curDrive.imgs || {}; d.lastFile = curDrive.lastFile; }
}
async function eraseAll() {
  if (!(await confirmBox('Erase everything', 'All entries, people, receipts and settings on this device will be deleted. Make a backup first if you need it.', 'Erase', true))) return;
  S = defaultState();
  await DB.clear('img');
  for (const k in imgCache) delete imgCache[k];
  await save();
  resetForm();
  toast('All data erased');
  setTab('home');
}

// ---------------- Receipts ----------------
function compressImage(file, max = 1280, q = 0.72) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight;
      const sc = Math.min(1, max / Math.max(w, h));
      w = Math.round(w * sc); h = Math.round(h * sc);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', q));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read image')); };
    img.src = url;
  });
}
async function snapToDraft(file) {
  try {
    const data = await compressImage(file);
    const id = 'img_' + uid();
    await DB.put('img', id, data);
    imgCache[id] = data;
    S.entries.push({ id: uid(), type: 'expense', amount: 0, date: today(), draft: true, receipt: id, note: '', createdAt: new Date().toISOString(), history: [] });
    await save();
    toast('Receipt saved — fill details later');
    render();
  } catch (e) { toast(e.message || 'Could not save photo'); }
}

// ---------------- PIN lock ----------------
async function hashPin(pin, salt) {
  const str = salt + ':' + pin;
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return 'sha256:' + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'fnv:' + (h >>> 0).toString(16);
}
let pinBuf = '', pinMode = null; // null=unlock, {step, first}
function showLock() {
  pinBuf = ''; pinMode = null;
  $('#lock h2').textContent = 'Hisaab is locked';
  $('#lock p').textContent = 'Enter your PIN';
  $('[data-act="forgotPin"]').hidden = false;
  $('#lock').hidden = false;
  drawPin();
}
function drawKeypad() {
  $('#keypad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(k => `<button data-act="pinKey" data-k="${k}">${k}</button>`).join('');
}
function drawPin() {
  const n = Math.max(4, pinBuf.length);
  $('#pinDots').innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < pinBuf.length ? 'f' : ''}"></i>`).join('');
}
async function pinKey(k) {
  if (k === 'C') pinBuf = '';
  else if (k === '⌫') pinBuf = pinBuf.slice(0, -1);
  else if (pinBuf.length < 8) pinBuf += k;
  drawPin();
  if (pinMode) return;
  const need = S.settings.pinLen || 0;
  if (pinBuf.length >= 4 && (!need || pinBuf.length === need)) {
    const tryPin = pinBuf;
    const h = await hashPin(tryPin, S.settings.pinSalt);
    if (h === S.settings.pinHash) {
      $('#lock').hidden = true; pinBuf = ''; lastHidden = 0;
      if (pendingRestore) { pendingRestore = false; openDriveRestore(); }
      else if (pendingAutoSync) { pendingAutoSync = false; maybeAutoSync(); }
    }
    else if (need || pinBuf.length === 8) failPin();
  }
}
function failPin() {
  const box = $('.lock-box');
  box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
  pinBuf = ''; drawPin();
}
function startSetPin() {
  pinMode = { step: 1, first: '' }; pinBuf = '';
  $('#lock h2').textContent = 'Set a PIN';
  $('#lock p').innerHTML = 'Type 4–8 digits, then tap OK<br><button class="btn primary sm mt" data-act="pinOk">OK</button> <button class="btn sm mt" data-act="cancelPinSet">Cancel</button>';
  $('[data-act="forgotPin"]').hidden = true;
  $('#lock').hidden = false;
  drawPin();
}
async function pinSetStep() {
  if (!pinMode) return;
  if (pinBuf.length < 4) { toast('PIN must be at least 4 digits'); return; }
  if (pinMode.step === 1) {
    pinMode = { step: 2, first: pinBuf }; pinBuf = '';
    $('#lock h2').textContent = 'Confirm PIN';
    drawPin();
  } else {
    if (pinBuf !== pinMode.first) { toast('PINs did not match, try again'); pinMode = { step: 1, first: '' }; pinBuf = ''; $('#lock h2').textContent = 'Set a PIN'; failPin(); return; }
    S.settings.pinSalt = uid();
    S.settings.pinHash = await hashPin(pinBuf, S.settings.pinSalt);
    S.settings.pinLen = pinBuf.length;
    await save();
    pinMode = null; pinBuf = '';
    $('#lock').hidden = true;
    toast('PIN set');
    render();
  }
}
let lastHidden = 0;
document.addEventListener('visibilitychange', () => {
  if (S && document.hidden && S.settings.drive.connected && S.settings.driveDirty && tokenValid()) { clearTimeout(driveTimer); driveBackup(false); }
  if (!S || !S.settings.pinHash) return;
  if (document.hidden) lastHidden = Date.now();
  else if (lastHidden && Date.now() - lastHidden > S.settings.lockAfter * 1000) showLock();
});

// ---------------- Event handling ----------------
const ACT = {
  tab: el => setTab(el.dataset.tab),
  go: el => go(el.dataset.v, el.dataset.p || null),
  back: () => { if (stack.length) history.back(); else back(); },
  goPending: el => { ui.pendingSeg = el.dataset.seg; setTab('pending'); },
  goEntries: el => {
    const f = el.dataset.filter;
    ui.entryFilter = { month: today().slice(0, 7), type: '', book: '', person: '', work: '', q: '', drafts: f === 'draft', spentOnly: f === 'spent' };
    if (f === '' || f === 'draft') ui.entryFilter.month = f === 'draft' ? '' : today().slice(0, 7);
    go('entries');
  },
  clearEF: () => { ui.entryFilter = null; render(); },
  seg: el => { ui.pendingSeg = el.dataset.seg; render(); },
  openEntry: el => openEntry(el.dataset.id),
  editEntry: el => editEntry(el.dataset.id),
  deleteEntry: el => deleteEntry(el.dataset.id),
  closeSheet: () => closeSheet(),
  confirmOk: () => { const r = confirmBox._res; confirmBox._res = null; closeSheet(); if (r) r(true); },
  setDir: el => {
    if (el.disabled || formLocked() || form.dir === el.dataset.v) return;
    form.dir = el.dataset.v; form.kind = form.dir === 'out' ? 'me' : form.dir === 'in' ? 'income' : ''; form.later = false;
    deriveType(); render();
  },
  setKind: el => {
    if (el.disabled || formLocked() || form.kind === el.dataset.v) return;
    form.kind = el.dataset.v; deriveType(); render();
  },
  toggleLater: el => { if (formLocked()) return; form.later = el.checked; deriveType(); render(); },
  setField: el => { form[el.dataset.k] = el.dataset.val; if (el.dataset.k === 'direction') form.categoryId = ''; render(); },
  saveForm: () => saveForm(),
  saveNext: () => saveForm(true),
  amtOp: el => {
    const inp = $('#amt'); if (!inp) return;
    const v = inp.value.trim();
    if (!v || /[+\-*/]$/.test(v)) { inp.focus(); return; }
    inp.value = v + el.dataset.op; form.amount = inp.value; updateAmtPreview();
    inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  },
  cancelForm: () => cancelForm(),
  pickReceipt: () => $('#fileReceipt').click(),
  removeReceipt: () => { form.receipt = ''; form.receiptData = ''; render(); },
  snap: () => $('#fileSnap').click(),
  useTpl: el => {
    const t = S.templates.find(x => x.id === el.dataset.id); if (!t) return;
    const d = t.data;
    openFormWith({ type: d.type, amount: d.amount || '', paidFrom: d.paidFrom || '', accountId: d.accountId || S.accounts[0]?.id || '', toAccountId: d.toAccountId || '', bookId: d.bookId || '', categoryId: d.categoryId || '', workId: d.workId || '', personId: d.personId || '', recoverFrom: d.recoverFrom || '', note: d.note || '', direction: d.direction || 'in', returnTo: null });
  },
  quickType: el => {
    const t = el.dataset.type, pid = el.dataset.p || '';
    if (t === 'spentBy') openFormWith({ type: 'expense', paidFrom: 'p:' + pid });
    else openFormWith({ type: t, personId: pid });
  },
  editPerson: el => openPersonEditor(el.dataset.id || null, el.dataset.fromform || null),
  savePerson: el => savePerson(el.dataset.id || null),
  deletePerson: el => deletePerson(el.dataset.id),
  editAccount: el => openAccountEditor(el.dataset.id || null),
  saveAccount: el => saveAccount(el.dataset.id || null),
  deleteAccount: el => deleteAccount(el.dataset.id),
  editWork: el => openWorkEditor(el.dataset.id || null, !!el.dataset.fromform),
  saveWork: el => saveWork(el.dataset.id || null),
  deleteWork: el => deleteWork(el.dataset.id),
  editSimple: el => openSimpleEditor(el.dataset.kind, el.dataset.id || null),
  saveSimple: el => saveSimple(el.dataset.kind, el.dataset.id || null),
  deleteSimple: el => deleteSimple(el.dataset.kind, el.dataset.id),
  balanceCheck: el => openBalanceCheck(el.dataset.id),
  saveBalanceCheck: el => saveBalanceCheck(el.dataset.id),
  toggleSel: el => { const id = el.dataset.id; if (el.checked) ui.sel.add(id); else ui.sel.delete(id); render(); },
  recordRecovery: () => openRecovery([...ui.sel]),
  recoverOne: el => openRecovery([el.dataset.id]),
  recoverForPerson: el => { const am = allocMap(); openRecovery(live().filter(e => e.type === 'recoverable' && e.personId === el.dataset.p && recInfo(e, am).remaining > 0).map(e => e.id)); },
  saveRecovery: () => saveRecovery(),
  writeOff: el => openWriteOff(el.dataset.id),
  saveWriteOff: el => saveWriteOff(el.dataset.id),
  undoWriteOff: async el => {
    const e = S.entries.find(x => x.id === el.dataset.id); if (!e || !e.writtenOff) return;
    e.history = [...(e.history || []), { at: new Date().toISOString(), changes: { writtenOff: [money(e.writtenOff.amount), ''] } }];
    delete e.writtenOff; await save(); closeSheet(); toast('Write-off removed'); render();
  },
  payExpected: el => {
    const x = S.entries.find(e => e.id === el.dataset.id); if (!x) return;
    const xi = expectedInfo(x);
    closeSheet();
    openFormWith({ type: x.direction === 'out' ? 'expense' : 'income', amount: String(xi.rem), categoryId: x.categoryId || '', note: x.note || '', linkExpected: x.id });
  },
  closeExp: async el => { const x = S.entries.find(e => e.id === el.dataset.id); if (!x) return; closeExpected(x); await save(); closeSheet(); toast('Marked done'); render(); },
  reopenExp: async el => { const x = S.entries.find(e => e.id === el.dataset.id); if (!x) return; x.closed = false; await save(); closeSheet(); render(); },
  toggleExpClosed: () => { ui.expShowClosed = !ui.expShowClosed; render(); },
  shareWA: el => { const p = person(el.dataset.p); openWhatsApp(p.phone, personStatementText(p.id)); },
  printPerson: el => printPerson(el.dataset.p),
  shareWork: el => openWhatsApp('', workText(el.dataset.p)),
  printWork: el => printWork(el.dataset.p),
  renameTpl: async el => {
    const t = S.templates.find(x => x.id === el.dataset.id); if (!t) return;
    openSheet(`${sheetHead('Rename template')}<div class="field"><input id="tplName" value="${esc(t.name)}"></div><button class="btn primary block" data-act="saveTplName" data-id="${t.id}">Save</button>`);
  },
  saveTplName: async el => { const t = S.templates.find(x => x.id === el.dataset.id); const n = $('#tplName').value.trim(); if (!n) return toast('Enter a name'); t.name = n; await save(); closeSheet(); render(); },
  delTpl: async el => { if (!(await confirmBox('Delete template', 'Delete this template?', 'Delete', true))) return; S.templates = S.templates.filter(x => x.id !== el.dataset.id); await save(); render(); },
  exportBackup: () => exportBackup(),
  pickRestore: () => $('#fileRestore').click(),
  eraseAll: () => eraseAll(),
  setPin: () => startSetPin(),
  cancelPinSet: () => { pinMode = null; pinBuf = ''; $('#lock').hidden = true; },
  removePin: async () => {
    if (!(await confirmBox('Turn off PIN', 'Anyone with your phone will be able to open the app.', 'Turn off', true))) return;
    S.settings.pinHash = ''; S.settings.pinSalt = ''; S.settings.pinLen = 0; await save(); toast('PIN turned off'); render();
  },
  lockNow: () => showLock(),
  pinKey: el => pinKey(el.dataset.k),
  pinOk: () => pinSetStep(),
  forgotPin: async () => {
    $('#lock').hidden = true;
    if (!(await confirmBox('Forgot PIN', 'The PIN cannot be recovered. You can erase all data on this device and then restore your latest backup file.', 'Erase data', true))) { showLock(); return; }
    const cidKeep = S.settings.googleClientId, emailKeep = S.settings.drive.email;
    S = defaultState(); S.settings.googleClientId = cidKeep; S.settings.drive.email = emailKeep;
    await DB.clear('img'); await saveRaw(); resetForm(); $('#lock').hidden = true; toast('Data erased. Restore from More → Backup.'); go('backup');
  },
  saveCid: async () => {
    const v = ($('#cidInp').value || '').trim();
    if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast('That does not look like a Client ID (ends with .apps.googleusercontent.com)'); return; }
    S.settings.googleClientId = v; await saveRaw(); toast('Client ID saved'); render();
  },
  clearCid: async () => { S.settings.googleClientId = ''; await saveRaw(); render(); },
  driveConnect: () => driveAuth('connect', true),
  driveReconnect: () => driveAuth('backup', true),
  driveNow: async () => { if (tokenValid()) { toast('Backing up…'); const r = await driveBackup(true); if (r === 'noauth') driveAuth('backup', true); } else driveAuth('backup', true); },
  driveRestore: () => { if (tokenValid()) openDriveRestore(); else driveAuth('restore', true); },
  driveRestorePick: el => driveRestoreFile(el.dataset.id),
  driveAutoToggle: async el => { S.settings.drive.auto = el.checked; await saveRaw(); render(); },
  driveDisconnect: async () => {
    if (!(await confirmBox('Disconnect Google Drive', 'Automatic backup will stop. Backups already in your Drive are kept.', 'Disconnect', true))) return;
    if (driveToken) { try { fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(driveToken.v), { method: 'POST', mode: 'no-cors' }); } catch (e) { /* ignore */ } }
    driveToken = null; try { sessionStorage.removeItem('hisaab_tok'); } catch (e) { /* ignore */ }
    Object.assign(S.settings.drive, { connected: false, needsReconnect: false });
    await saveRaw(); toast('Disconnected'); render();
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.closest('#lock') === null && !$('#lock').hidden && el.dataset.act !== 'forgotPin') return;
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'INPUT' && el.type === 'checkbox') { fn(el); return; }
  e.preventDefault();
  fn(el);
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.f) {
    const k = t.dataset.f;
    form[k] = t.type === 'checkbox' ? t.checked : t.value;
    if (k === 'amount') updateAmtPreview();
    if (k === 'personId' && form.type === 'lent') { render(); return; }
    if (k === 'saveTpl') render();
    return;
  }
  if (t.dataset.ui) {
    ui[t.dataset.ui] = t.value;
    if (t.dataset.ui === 'peopleQ') { const pos = t.selectionStart; render(); const n = $('[data-ui="peopleQ"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
    else render();
    return;
  }
  if (t.dataset.ef) {
    ui.entryFilter[t.dataset.ef] = t.value;
    const isText = t.dataset.ef === 'q';
    const pos = t.selectionStart;
    render();
    if (isText) { const n = $('[data-ef="q"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
    return;
  }
  if (t.dataset.rc === 'amt') { autoDistribute(); return; }
  if (t.dataset.rc === 'alloc') { const v = evalAmount(t.value); recState.items[+t.dataset.i].alloc = isNaN(v) ? 0 : v; updateRecMsg(); return; }
  if (t.dataset.bc) {
    const v = evalAmount(t.value); const id = $('[data-act="saveBalanceCheck"]').dataset.id;
    const bal = accountBalances()[id] || 0;
    $('#bcMsg').innerHTML = isNaN(v) ? '' : r2(v - bal) === 0 ? '<span class="in">Matches</span>' : `Difference: <b>${money(r2(v - bal), true)}</b> (${v < bal ? 'unrecorded spending' : 'unrecorded income'})`;
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.f && t.tagName === 'SELECT') {
    form[t.dataset.f] = t.value;
    if (t.dataset.f === 'paidFrom' || t.dataset.f === 'accountId') return;
  }
});

$('#fileReceipt').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { form.receiptData = await compressImage(f); render(); } catch (err) { toast('Could not read image'); }
});
$('#fileSnap').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) snapToDraft(f);
});
$('#fileRestore').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) restoreFromFile(f);
});
document.addEventListener('keydown', e => {
  if (!$('#lock').hidden && (pinMode || S.settings.pinHash)) {
    if (/^[0-9]$/.test(e.key)) pinKey(e.key);
    else if (e.key === 'Backspace') pinKey('⌫');
    else if (e.key === 'Enter' && pinMode) pinSetStep();
    return;
  }
  if (e.key === 'Escape' && sheetOpen) closeSheet();
  if (e.key === 'Enter' && cur.v === 'add' && e.target.dataset && e.target.dataset.f === 'amount') { e.preventDefault(); saveForm(); }
});

// ---------------- Google Drive auto-backup ----------------
// Uses Google's OAuth redirect (no popup, no library). Scope drive.file:
// the app can only see files it created itself, nothing else in your Drive.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRV = 'https://www.googleapis.com/drive/v3';
const UPL = 'https://www.googleapis.com/upload/drive/v3';
const KEEP_DAILY = 15;
let driveToken = null;          // { v, exp } kept for this session only
let driveTimer = null;
let driveRunning = false, driveAgain = false;
let pendingAutoSync = false;

function driveClientId() { return ((window.HISAAB_CONFIG && window.HISAAB_CONFIG.googleClientId) || S.settings.googleClientId || '').trim(); }
function driveRedirectUri() { return location.origin + location.pathname.replace(/[^/]*$/, ''); }
function tokenValid() { return !!(driveToken && driveToken.exp > Date.now()); }
function latestBackup() {
  const a = S.settings.lastBackup, b = S.settings.drive.connected ? S.settings.drive.lastBackup : null;
  if (!a) return b; if (!b) return a; return a > b ? a : b;
}
function loadToken() {
  try { const t = JSON.parse(sessionStorage.getItem('hisaab_tok') || 'null'); if (t && t.exp > Date.now()) driveToken = t; } catch (e) { /* ignore */ }
}

function driveAuth(after, interactive) {
  const cid = driveClientId();
  if (!cid) { toast('Add your Google Client ID first (More → Backup)'); return; }
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') { toast('Google Drive works only on the https:// link'); return; }
  if (!navigator.onLine) { toast('No internet connection'); return; }
  const st = uid();
  try {
    sessionStorage.setItem('hisaab_oauth', JSON.stringify({ state: st, after, interactive: !!interactive }));
    if (S.settings.pinHash && $('#lock').hidden) sessionStorage.setItem('hisaab_skiplock', String(Date.now()));
  } catch (e) { /* ignore */ }
  const p = new URLSearchParams({ client_id: cid, redirect_uri: driveRedirectUri(), response_type: 'token', scope: DRIVE_SCOPE, state: st, include_granted_scopes: 'true' });
  const email = S.settings.drive.email;
  if (!interactive) p.set('prompt', 'none');
  else if (!email) p.set('prompt', 'select_account');
  if (email) p.set('login_hint', email);
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
}

function readAuthReturn() {
  const hash = location.hash || '';
  if (!/(^#|&)(state|access_token|error)=/.test(hash)) return null;
  const h = new URLSearchParams(hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('hisaab_oauth') || 'null'); sessionStorage.removeItem('hisaab_oauth'); } catch (e) { /* ignore */ }
  if (!saved || saved.state !== h.get('state')) return { error: 'state_mismatch' };
  if (h.get('error') || !h.get('access_token')) return { error: h.get('error') || 'no_token', after: saved.after, interactive: saved.interactive };
  driveToken = { v: h.get('access_token'), exp: Date.now() + (Number(h.get('expires_in') || 3600) - 120) * 1000 };
  try { sessionStorage.setItem('hisaab_tok', JSON.stringify(driveToken)); } catch (e) { /* ignore */ }
  return { ok: true, after: saved.after, interactive: saved.interactive };
}

async function handleAuthReturn(ar) {
  const d = S.settings.drive;
  if (ar.ok) {
    d.connected = true; d.needsReconnect = false;
    if (!d.email) await driveWhoAmI();
    await saveRaw();
    render();
    if (ar.after === 'restore') { if ($('#lock').hidden) openDriveRestore(); else pendingRestore = true; return; }
    const r = await driveBackup(!!ar.interactive);
    if (ar.after === 'connect' && r === 'ok') toast('Google Drive connected. Auto backup is on.');
  } else {
    if (ar.error === 'state_mismatch') return;
    if (ar.interactive) toast(ar.error === 'access_denied' ? 'Google Drive permission was not given' : 'Google sign-in failed: ' + ar.error);
    else if (d.connected) { d.needsReconnect = true; await saveRaw(); }
    render();
  }
}
let pendingRestore = false;

class DriveAuthError extends Error {}
async function gapi(method, url, body, headers = {}) {
  if (!tokenValid()) throw new DriveAuthError('auth');
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + driveToken.v, ...headers }, body });
  if (r.status === 401) {
    driveToken = null; try { sessionStorage.removeItem('hisaab_tok'); } catch (e) { /* ignore */ }
    throw new DriveAuthError('auth');
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const e = new Error('Drive error ' + r.status + (t ? ': ' + t.slice(0, 140) : ''));
    e.status = r.status; throw e;
  }
  return r;
}
async function driveWhoAmI() {
  try { const r = await gapi('GET', DRV + '/about?fields=user(emailAddress)'); const j = await r.json(); S.settings.drive.email = (j.user && j.user.emailAddress) || S.settings.drive.email; } catch (e) { /* ignore */ }
}
async function driveList(q, extra = '') {
  const r = await gapi('GET', `${DRV}/files?q=${encodeURIComponent(q)}&spaces=drive&fields=${encodeURIComponent('nextPageToken,files(id,name,modifiedTime,size)')}${extra}`);
  return r.json();
}
async function findFolder(name, parent) {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parent) q += ` and '${parent}' in parents`;
  const j = await driveList(q, '&pageSize=1');
  return (j.files && j.files[0] && j.files[0].id) || '';
}
async function createFolder(name, parent) {
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parent) meta.parents = [parent];
  const r = await gapi('POST', DRV + '/files?fields=id', JSON.stringify(meta), { 'Content-Type': 'application/json' });
  return (await r.json()).id;
}
async function createFile(meta, blob) {
  const b = 'hisaab' + uid();
  const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`, blob, `\r\n--${b}--`]);
  const r = await gapi('POST', UPL + '/files?uploadType=multipart&fields=id', body, { 'Content-Type': 'multipart/related; boundary=' + b });
  return (await r.json()).id;
}
async function updateFile(id, blob) {
  await gapi('PATCH', `${UPL}/files/${id}?uploadType=media`, blob, { 'Content-Type': blob.type || 'application/octet-stream' });
}
async function ensureFolders() {
  const d = S.settings.drive;
  if (!d.folderId) { d.folderId = (await findFolder('Hisaab Backups', null)) || (await createFolder('Hisaab Backups', null)); d.imgFolderId = ''; }
  if (!d.imgFolderId) d.imgFolderId = (await findFolder('receipts', d.folderId)) || (await createFolder('receipts', d.folderId));
}
async function uploadImages() {
  const d = S.settings.drive;
  for (const k of await DB.keys('img')) {
    if (d.imgs[k]) continue;
    const data = await DB.get('img', k);
    if (!data) continue;
    const blob = await (await fetch(data)).blob();
    d.imgs[k] = await createFile({ name: k + '.jpg', parents: [d.imgFolderId] }, blob);
    await saveRaw();
  }
}
async function uploadData() {
  const d = S.settings.drive, day = today();
  const blob = new Blob([JSON.stringify({ app: 'hisaab', version: 1, exportedAt: new Date().toISOString(), driveImages: true, state: S, images: {} })], { type: 'application/json' });
  if (d.lastFile && d.lastFile.date === day && d.lastFile.id) {
    try { await updateFile(d.lastFile.id, blob); return; } catch (e) { if (e.status !== 404) throw e; }
  }
  const id = await createFile({ name: `hisaab-${day}.json`, parents: [d.folderId], mimeType: 'application/json' }, blob);
  d.lastFile = { date: day, id };
  await pruneOld();
}
async function pruneOld() {
  try {
    const d = S.settings.drive;
    const j = await driveList(`'${d.folderId}' in parents and name contains 'hisaab-' and trashed=false`, '&orderBy=' + encodeURIComponent('name desc,modifiedTime desc') + '&pageSize=100');
    for (const f of (j.files || []).slice(KEEP_DAILY)) await gapi('DELETE', `${DRV}/files/${f.id}`);
  } catch (e) { if (e instanceof DriveAuthError) throw e; }
}
async function driveBackupOnce() {
  const d = S.settings.drive, seq = dirtySeq;
  try { await ensureFolders(); await uploadImages(); await uploadData(); }
  catch (e) {
    if (e.status !== 404) throw e;
    Object.assign(d, { folderId: '', imgFolderId: '', lastFile: null, imgs: {} });
    await ensureFolders(); await uploadImages(); await uploadData();
  }
  d.lastBackup = new Date().toISOString();
  d.needsReconnect = false;
  if (dirtySeq === seq) S.settings.driveDirty = false;
  await saveRaw();
}
async function driveBackup(manual) {
  if (!tokenValid()) return 'noauth';
  if (driveRunning) { driveAgain = true; return 'queued'; }
  driveRunning = true;
  let res = 'ok';
  try {
    do { driveAgain = false; await driveBackupOnce(); } while (driveAgain && tokenValid());
    if (manual) toast('Backed up to Google Drive');
  } catch (e) {
    if (e instanceof DriveAuthError) res = 'noauth';
    else { res = 'error'; if (manual) toast(navigator.onLine ? (e.message || 'Drive backup failed') : 'Drive backup failed: offline'); }
  } finally {
    driveRunning = false;
    if (['backup', 'home', 'more'].includes(cur.v) && !sheetOpen) render();
  }
  return res;
}
function scheduleUpload() {
  clearTimeout(driveTimer);
  driveTimer = setTimeout(async () => { const r = await driveBackup(false); if (r === 'noauth') maybeAutoSync(); }, 3000);
}
// Called after every change and on app open. Uploads silently while signed in;
// when the 1-hour Google token has expired, does a quick silent sign-in redirect.
function maybeAutoSync() {
  const d = S.settings.drive;
  if (!d.connected || !d.auto || !driveClientId() || !S.settings.driveDirty) return;
  if (tokenValid()) { scheduleUpload(); return; }
  if (d.needsReconnect || !navigator.onLine) return;
  if (!$('#lock').hidden) { pendingAutoSync = true; return; }
  if (Date.now() - (d.lastAttempt || 0) < 15 * 60 * 1000) return;
  clearTimeout(maybeAutoSync._t);
  maybeAutoSync._t = setTimeout(async () => {
    if (tokenValid()) { scheduleUpload(); return; }
    const busy = sheetOpen || !$('#lock').hidden || (cur.v === 'add' && String(form.amount || '').trim());
    if (busy || !navigator.onLine) return;   // try again after the next save
    d.lastAttempt = Date.now();
    await saveRaw();
    toast('Backing up to Google Drive…');
    setTimeout(() => driveAuth('backup', false), 600);
  }, 1500);
}

async function openDriveRestore() {
  openSheet(`${sheetHead('Restore from Google Drive')}<div class="empty">Loading backups…</div>`);
  try {
    const d = S.settings.drive;
    if (!d.folderId) d.folderId = await findFolder('Hisaab Backups', null);
    const files = d.folderId ? ((await driveList(`'${d.folderId}' in parents and name contains 'hisaab-' and trashed=false`, '&orderBy=' + encodeURIComponent('name desc,modifiedTime desc') + '&pageSize=' + KEEP_DAILY)).files || []) : [];
    if (!sheetOpen) return;
    $('#sheet').innerHTML = `${sheetHead('Restore from Google Drive')}
      ${files.length ? `<p class="muted small" style="margin-bottom:10px">Pick a backup. It replaces all data on this device.</p>
      <div class="card flush">${files.map(f => `<button class="list-item" data-act="driveRestorePick" data-id="${esc(f.id)}">
        <div class="li-main"><div class="li-title">${esc(f.name.replace(/^hisaab-|\.json$/g, ''))}</div><div class="li-sub">Saved ${f.modifiedTime ? new Date(f.modifiedTime).toLocaleString('en-GB') : ''}${f.size ? ' · ' + Math.max(1, Math.round(f.size / 1024)) + ' KB' : ''}</div></div>›</button>`).join('')}</div>`
      : '<div class="empty">No backups found in this Google account.</div>'}`;
  } catch (e) {
    if (e instanceof DriveAuthError) { closeSheet(); driveAuth('restore', true); return; }
    if (sheetOpen) $('#sheet').innerHTML = `${sheetHead('Restore from Google Drive')}<div class="empty danger">${esc(e.message || 'Could not load backups')}</div>`;
  }
}
async function driveRestoreFile(id) {
  try {
    const data = await (await gapi('GET', `${DRV}/files/${encodeURIComponent(id)}?alt=media`)).json();
    if (!data || data.app !== 'hisaab' || !data.state || !Array.isArray(data.state.entries)) { toast('Not a Hisaab backup'); return; }
    const ok = await confirmBox('Restore backup', `Replace all data on this device with the backup from ${data.exportedAt ? new Date(data.exportedAt).toLocaleString('en-GB') : 'unknown date'} (${data.state.entries.length} entries)?`, 'Restore', true);
    if (!ok) return;
    toast('Restoring…');
    applyRestoredState(data.state, true);
    await DB.clear('img');
    for (const k in imgCache) delete imgCache[k];
    for (const [k, v] of Object.entries(data.images || {})) await DB.put('img', k, v);
    const d = S.settings.drive;
    const need = [...new Set(S.entries.map(e => e.receipt).filter(Boolean))];
    if (need.some(k => !d.imgs[k]) && d.imgFolderId) {
      let pageToken = '';
      do {
        const j = await driveList(`'${d.imgFolderId}' in parents and trashed=false`, '&pageSize=1000' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
        (j.files || []).forEach(f => { const k = f.name.replace(/\.jpg$/, ''); if (!d.imgs[k]) d.imgs[k] = f.id; });
        pageToken = j.nextPageToken || '';
      } while (pageToken);
    }
    let failed = 0;
    for (const k of need) {
      if (await DB.get('img', k)) continue;
      if (!d.imgs[k]) { failed++; continue; }
      try {
        const blob = await (await gapi('GET', `${DRV}/files/${encodeURIComponent(d.imgs[k])}?alt=media`)).blob();
        const url = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
        await DB.put('img', k, url);
      } catch (e) { if (e instanceof DriveAuthError) throw e; failed++; }
    }
    S.settings.driveDirty = false;
    await saveRaw();
    resetForm();
    toast(failed ? `Restored. ${failed} receipt photo(s) could not be downloaded.` : 'Restored from Google Drive');
    setTab('home');
  } catch (e) {
    if (e instanceof DriveAuthError) { driveAuth('restore', true); return; }
    toast(e.message || 'Restore failed');
  }
}

// ---------------- Init ----------------
async function init() {
  await load();
  const ar = readAuthReturn();
  loadToken();
  resetForm();
  drawKeypad();
  history.replaceState({ h: 0 }, '');
  render();
  let skip = false;
  try {
    const t = Number(sessionStorage.getItem('hisaab_skiplock') || 0);
    sessionStorage.removeItem('hisaab_skiplock');
    skip = !!ar && t > 0 && Date.now() - t < 3 * 60 * 1000;
  } catch (e) { /* ignore */ }
  if (S.settings.pinHash && !skip) showLock();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (ar) await handleAuthReturn(ar);
  else maybeAutoSync();
}
window.Hisaab = { get S() { return S; }, accountBalances, personBalances, personLines, summary, recInfo, expectedInfo, evalAmount, ownSpending, workStats };
init();
