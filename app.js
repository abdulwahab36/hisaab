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
  const loc = (typeof S !== 'undefined' && S && S.settings && S.settings.numStyle === 'intl') ? 'en-US' : 'en-IN';
  const s = Math.abs(v).toLocaleString(loc, { maximumFractionDigits: 2 });
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
const MEM = {};
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return MEM[k] ?? null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { MEM[k] = v; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } delete MEM[k]; },
  keys() { try { return Object.keys(localStorage); } catch (e) { return Object.keys(MEM); } }
};
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
    if (!DB.ok) { const v = LS.get('hisaab_' + store + '_' + key); return v ? JSON.parse(v) : undefined; }
    return DB.tx(store, 'readonly', st => st.get(key));
  },
  async put(store, key, val) {
    if (!DB.ok) { LS.set('hisaab_' + store + '_' + key, JSON.stringify(val)); return; }
    return DB.tx(store, 'readwrite', st => st.put(val, key));
  },
  async del(store, key) {
    if (!DB.ok) { LS.del('hisaab_' + store + '_' + key); return; }
    return DB.tx(store, 'readwrite', st => st.delete(key));
  },
  async keys(store) {
    if (!DB.ok) { const p = 'hisaab_' + store + '_'; return LS.keys().filter(k => k.startsWith(p)).map(k => k.slice(p.length)); }
    return DB.tx(store, 'readonly', st => st.getAllKeys());
  },
  async clear(store) {
    if (!DB.ok) { for (const k of await DB.keys(store)) LS.del('hisaab_' + store + '_' + k); return; }
    return DB.tx(store, 'readwrite', st => st.clear());
  }
};

// ---------------- State ----------------
let S = null;

const PALETTE = ['#e8590c', '#2f9e44', '#1c7ed6', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5f3dc4', '#74b816', '#c92a2a', '#3b5bdb', '#868e96'];
function catColor(id) { const c = cat(id); return (c && c.color) || '#868e96'; }
function personColor(p) { let h = 0; for (const ch of (p && p.id) || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
const BILL_TYPES = [['Electricity', '#f08c00'], ['Gas', '#e8590c'], ['Water', '#1c7ed6'], ['Internet', '#5f3dc4'], ['Mobile', '#0c8599'], ['Rent', '#2f9e44'], ['Subscription', '#d6336c'], ['Other bill', '#868e96']];
function defaultState() {
  const mk = (name, extra = {}) => ({ id: uid(), name, ...extra });
  return {
    v: 1,
    accounts: ['Cash', 'Bank', 'Easypaisa', 'JazzCash'].map(n => mk(n, { opening: 0 })),
    books: ['Home', 'Office', 'Personal', 'Car'].map(n => mk(n)),
    categories: [
      ...['Food & grocery', 'Fuel', 'Repair & maintenance', 'Utilities', 'Transport', 'Medical', 'Shopping', 'Court / legal', 'Education', 'Other'].map((n, i) => mk(n, { kind: 'out', color: PALETTE[i % PALETTE.length] })),
      ...['Salary', 'TA / allowance', 'Online income', 'Other income'].map((n, i) => mk(n, { kind: 'in', color: PALETTE[(i + 1) % PALETTE.length] })),
      ...BILL_TYPES.map(([n, c]) => mk(n, { kind: 'out', bill: true, color: c }))
    ],
    people: [],
    works: [],
    entries: [],
    templates: [],
    settings: { pinHash: '', pinSalt: '', lastBackup: null, alertDays: 60, lockAfter: 60, last: {}, googleClientId: '', driveDirty: false, drive: defaultDrive(), onboarded: false, sample: false, numStyle: 'lakh', areaByCat: {} }
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
  if (!st.settings || st.settings.onboarded === undefined) out.settings.onboarded = true; // existing users skip the welcome
  if (!out.settings.last) out.settings.last = {};
  out.categories.forEach((c, i) => { if (!c.color) c.color = PALETTE[i % PALETTE.length]; });
  if (!out.categories.some(c => c.bill)) BILL_TYPES.forEach(([n, c]) => out.categories.push({ id: uid(), name: n, kind: 'out', bill: true, color: c }));
  out.settings.drive = { ...defaultDrive(), ...((st.settings && st.settings.drive) || {}) };
  if (!out.settings.drive.imgs) out.settings.drive.imgs = {};
  return out;
}

const PREVIEW = !!(window.HISAAB_CONFIG && window.HISAAB_CONFIG.preview);
async function load() {
  await DB.open();
  const st = await DB.get('kv', 'state');
  S = st ? normalizeState(st) : (PREVIEW ? sampleState() : defaultState());
  if (/[?&]nowelcome/.test(location.search)) S.settings.onboarded = true;
  if (!st) await saveRaw();
}
// Sample data for the preview link only (never used in the real app)
function sampleState() {
  const st = defaultState(), t = today(), d = n => addDays(t, n);
  const A = n => st.accounts.find(a => a.name === n).id, B = n => st.books.find(b => b.name === n).id, C = n => st.categories.find(c => c.name === n).id;
  st.accounts.find(a => a.name === 'Cash').opening = 25000;
  st.accounts.find(a => a.name === 'Bank').opening = 180000;
  const office = { id: uid(), name: 'Office (sample)', kind: 'org', phone: '' };
  const staff = { id: uid(), name: 'Site staff (sample)', kind: 'staff', phone: '' };
  const friend = { id: uid(), name: 'Friend (sample)', kind: 'friend', phone: '', dueDate: d(-3) };
  st.people.push(office, staff, friend);
  const work = { id: uid(), name: 'Office repair (sample)', ref: 'EST-01', closed: false };
  st.works.push(work);
  const E = (o) => st.entries.push({ id: uid(), createdAt: new Date().toISOString(), history: [], note: '', ...o });
  E({ type: 'expense', amount: 4500, date: d(-2), accountId: A('Cash'), bookId: B('Car'), categoryId: C('Fuel'), note: 'Fuel' });
  E({ type: 'expense', amount: 12800, date: d(-6), accountId: A('Bank'), bookId: B('Home'), categoryId: C('Food & grocery'), note: 'Monthly grocery' });
  E({ type: 'expense', amount: 3000, date: addMonths(t, -1), accountId: A('Cash'), bookId: B('Car'), categoryId: C('Fuel'), note: 'Fuel' });
  E({ type: 'expense', amount: 11000, date: addMonths(t, -1), accountId: A('Bank'), bookId: B('Home'), categoryId: C('Food & grocery'), note: 'Grocery' });
  E({ type: 'recoverable', amount: 25000, date: d(-40), accountId: A('Bank'), bookId: B('Office'), categoryId: C('Repair & maintenance'), personId: office.id, workId: work.id, note: 'Office roof repair' });
  E({ type: 'recoverable', amount: 3500, date: d(-75), accountId: A('Cash'), bookId: B('Office'), categoryId: C('Court / legal'), personId: office.id, note: 'Court fee' });
  E({ type: 'advance', amount: 10000, date: d(-10), accountId: A('Bank'), personId: staff.id, workId: work.id, note: 'Site advance' });
  E({ type: 'expense', amount: 4000, date: d(-8), viaPersonId: staff.id, bookId: B('Office'), categoryId: C('Repair & maintenance'), workId: work.id, note: 'Labour' });
  E({ type: 'lent', amount: 10000, date: d(-20), accountId: A('Cash'), personId: friend.id, note: 'Bike repair' });
  E({ type: 'received', amount: 4000, date: d(-5), accountId: A('Cash'), personId: friend.id, dueDate: d(-3), note: 'Part payment' });
  E({ type: 'expected', amount: 6500, date: d(2), direction: 'out', repeat: 'monthly', bookId: B('Home'), categoryId: C('Utilities'), note: 'Electricity', closed: false });
  E({ type: 'expected', amount: 1100, date: d(9), direction: 'out', repeat: 'monthly', bookId: B('Personal'), categoryId: C('Utilities'), note: 'Netflix', closed: false });
  E({ type: 'expected', amount: 15000, date: d(12), direction: 'in', categoryId: C('TA / allowance'), note: 'TA claim', closed: false });
  st.settings.lastBackup = new Date().toISOString();
  st.settings.sample = true;
  st.settings.onboarded = true;
  return st;
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
  recoverable: { label: 'To get back', hint: 'Spent now, to get back later (office, company, someone)', f: ['paidFrom', 'book', 'cat', 'work', 'recoverFrom', 'note', 'receipt'] },
  income:      { label: 'Income',      hint: 'Salary, TA, online income…', f: ['account', 'catIn', 'note', 'receipt'] },
  lent:        { label: 'Lent',        hint: 'I gave money, they will return it', f: ['person*', 'account', 'work', 'due', 'note'] },
  borrowed:    { label: 'Borrowed',    hint: 'I took money, I will return it', f: ['person*', 'account', 'due', 'note'] },
  received:    { label: 'Got back',    hint: 'A person returned money (loan or unused advance)', f: ['person*', 'account', 'due', 'note'] },
  repaid:      { label: 'Paid back',   hint: 'I returned money to a person', f: ['person*', 'account', 'note'] },
  advance:     { label: 'Advance',     hint: 'Given to staff for work; they report spending later', f: ['person*', 'account', 'work', 'note'] },
  transfer:    { label: 'Transfer',    hint: 'Move money between my accounts', f: ['account', 'toAccount', 'note'] },
  expected:    { label: 'Upcoming',    hint: 'Money due in future: TA, arrears, payouts, bills', f: ['book', 'catAny', 'personOpt', 'repeat', 'note'], dateLabel: 'Due on' }
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
          push(e.date, e, 'You paid for them', a);
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
    case 'expense': return 'out';
    case 'recoverable': return e.viaPersonId ? 'neutral' : 'out';
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
  const vp = person(e.viaPersonId); if (vp) parts.push(vp.kind === 'staff' ? 'from ' + vp.name + "'s advance" : 'paid by ' + vp.name);
  const w = work(e.workId); if (w) parts.push(w.name);
  if (e.accountId && !e.viaPersonId && e.type !== 'transfer') { const a = acc(e.accountId); if (a) parts.push(a.name); }
  if (e.oldEntry) parts.push('before app');
  return parts.join(' · ');
}
const STATUS_LBL = { pending: 'not paid yet', partial: 'part paid', recovered: 'paid back', 'written-off': "won't get" };
const TYPE_ICO = { lent: '↗', advance: '↗', repaid: '↗', received: '↙', borrowed: '↙', transfer: '⇄', recovery: '↩', adjustment: '=', income: '+', expense: '•', recoverable: '↻', expected: '◷' };
function entryIcon(e) {
  const c = cat(e.categoryId);
  if (c) return `<span class="ico" style="--c:${c.color}" aria-hidden="true">${esc(c.name.trim()[0] || '•').toUpperCase()}</span>`;
  const p = person(e.personId) || person(e.viaPersonId);
  if (p && ['lent', 'advance', 'repaid', 'received', 'borrowed', 'recovery'].includes(e.type)) return `<span class="ico" style="--c:${personColor(p)}" aria-hidden="true">${esc(p.name.trim()[0] || '?').toUpperCase()}</span>`;
  const fl = entryFlow(e), col = e.type === 'transfer' ? 'var(--move)' : fl === 'in' ? 'var(--in)' : fl === 'out' ? 'var(--out)' : 'var(--muted)';
  return `<span class="ico" style="--c:${col}" aria-hidden="true">${TYPE_ICO[e.type] || '•'}</span>`;
}
function personAvatar(p) { return `<span class="ico" style="--c:${personColor(p)}" aria-hidden="true">${esc(p.name.trim()[0] || '?').toUpperCase()}</span>`; }
function entryItem(e, opts = {}) {
  const fl = opts.owed ? 'in' : entryFlow(e);
  const amt = e.type === 'adjustment' ? e.amount : e.amount;
  const sign = opts.owed ? '' : fl === 'in' ? '+' : fl === 'out' ? '-' : '';
  let extra = '';
  if (e.type === 'recoverable') { const ri = recInfo(e); extra = `<div class="li-sub"><span class="badge ${ri.status}">${STATUS_LBL[ri.status] || ri.status}</span></div>`; }
  if (e.type === 'expected') { const xi = expectedInfo(e); const od = !xi.closed && e.date < today(); extra = `<div class="li-sub"><span class="badge ${xi.closed ? 'recovered' : od ? 'overdue' : 'pending'}">${xi.closed ? 'done' : od ? 'overdue' : e.direction === 'out' ? 'to pay' : 'to receive'}</span></div>`; }
  return `<button class="list-item" data-act="openEntry" data-id="${e.id}">
    ${entryIcon(e)}
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

// Bottom bar = top-level tabs (path resets). Everything else (tiles, alerts, links,
// More) opens on top of the current screen, so Back returns step by step.
let navDepth = 0; // history entries we pushed
function pushHist() { history.pushState({ h: 1 }, ''); navDepth++; }
function setTab(t) {
  if (t === 'add' && cur.v !== 'add') resetForm();
  insMonth = null;
  if (t !== 'home' && tab === 'home' && !stack.length && navDepth === 0) pushHist(); // so Back from a tab returns Home
  tab = t; stack = []; cur = { v: t, p: null };
  render();
  window.scrollTo(0, 0);
}
function go(v, p = null) {
  stack.push({ ...cur, tab, y: window.scrollY });
  cur = { v, p };
  pushHist();
  render();
  window.scrollTo(0, 0);
}
// Open a tab's screen on top of the current one (keeps the way back)
function jump(t) {
  if (t === cur.v && !stack.length && tab === t) return;
  if (t === 'add') resetForm();
  stack.push({ ...cur, tab, y: window.scrollY });
  tab = t; cur = { v: t, p: null };
  if (t === 'insights') insMonth = null;
  pushHist();
  render();
  window.scrollTo(0, 0);
}
function stepBack() {
  const prev = stack.pop();
  cur = { v: prev.v, p: prev.p }; tab = prev.tab || tab;
  render();
  window.scrollTo(0, prev.y || 0);
}
function back() {
  if (sheetOpen) { closeSheet(); return; }
  if (stack.length) stepBack();
  else if (cur.v !== 'home') setTab('home');
}
window.addEventListener('popstate', () => {
  navDepth = Math.max(0, navDepth - 1);
  if (sheetOpen) { closeSheet(); pushHist(); return; }
  if (!$('#lock').hidden) { pushHist(); return; }
  if (stack.length) stepBack();
  else if (cur.v !== 'home' && S.settings.onboarded) { tab = 'home'; cur = { v: 'home', p: null }; render(); window.scrollTo(0, 0); }
});

const TITLES = {
  welcome: 'Hisaab',
  home: 'Hisaab', people: 'People', add: 'Add entry', pending: 'Pending', more: 'Settings & more',
  person: 'Person', accounts: 'Accounts', books: 'Areas', cats: 'Categories', works: 'Projects / sites', work: 'Project',
  templates: 'Quick templates', bills: 'Bills', insights: 'Insights', entries: 'All entries', backup: 'Backup & restore', security: 'App lock', help: 'How it works'
};

function render() {
  const onb = !S.settings.onboarded;
  document.body.classList.toggle('onboarding', onb);
  if (onb) { tab = 'home'; stack = []; cur = { v: 'welcome', p: null }; }
  else if (cur.v === 'welcome') cur = { v: 'home', p: null };
  $$('.nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#moreBtn').classList.toggle('on', tab === 'more');
  $('#backBtn').hidden = stack.length === 0;
  $('#lockBtn').hidden = !S.settings.pinHash;
  let title = TITLES[cur.v] || 'Hisaab';
  if (cur.v === 'person') title = person(cur.p)?.name || 'Person';
  if (cur.v === 'work') title = work(cur.p)?.name || 'Work';
  if (cur.v === 'add' && form.editingId) title = form.draftId ? 'Complete entry' : 'Edit entry';
  if (cur.v === 'add' && form.type === 'expected' && form.direction === 'out') title = form.editingId ? 'Edit bill' : 'Add bill';
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
  if (old.length) alerts.push(`<button class="alert" data-act="goPending" data-seg="rec"><span class="grow"><b>${old.length} item${old.length > 1 ? 's' : ''} to get back</b> older than ${S.settings.alertDays} days · ${money(old.reduce((a, e) => a + recInfo(e, am).remaining, 0))}</span>›</button>`);
  const od = live().filter(e => e.type === 'expected' && !expectedInfo(e).closed && e.date < t);
  const soon = live().filter(e => e.type === 'expected' && e.direction === 'out' && !expectedInfo(e).closed && e.date >= t && e.date <= addDays(t, 3));
  if (soon.length) alerts.push(`<button class="alert info" data-act="jump" data-tab="bills"><span class="grow"><b>${soon.length} bill${soon.length > 1 ? 's' : ''}</b> due in the next 3 days · ${money(soon.reduce((a, e) => a + expectedInfo(e).rem, 0))}</span>›</button>`);
  if (od.length) alerts.push(`<button class="alert" data-act="goPending" data-seg="exp"><span class="grow"><b>${od.length} payment${od.length > 1 ? 's' : ''}</b> past due date</span>›</button>`);
  const drafts = S.entries.filter(e => e.draft);
  const pbAll = personBalances();
  const dueP = S.people.filter(p => p.dueDate && pbAll[p.id] && p.dueDate <= t).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  if (dueP.length === 1) { const p = dueP[0], b = pbAll[p.id]; alerts.push(`<button class="alert" data-act="go" data-v="person" data-p="${p.id}"><span class="grow"><b>${esc(p.name)}</b> · ${b > 0 ? money(b) + ' was promised to you' : 'you promised to pay ' + money(-b)} by ${fmtShort(p.dueDate)}</span>›</button>`); }
  else if (dueP.length > 1) alerts.push(`<button class="alert" data-act="jump" data-tab="people"><span class="grow"><b>${dueP.length} people</b> past a promised payment date</span>›</button>`);
  if (drafts.length) alerts.push(`<button class="alert info" data-act="goEntries" data-filter="draft"><span class="grow"><b>${drafts.length} incomplete</b> receipt${drafts.length > 1 ? 's' : ''} to fill in</span>›</button>`);
  const dv = S.settings.drive;
  if (dv.connected && dv.needsReconnect) {
    alerts.push(`<button class="alert" data-act="driveReconnect"><span class="grow"><b>Google Drive backup paused</b> · tap to reconnect</span>›</button>`);
  } else {
    const lb = latestBackup();
    if (live().length >= 5 && (!lb || daysBetween(lb.slice(0, 10), t) > 7)) alerts.push(`<button class="alert" data-act="go" data-v="backup"><span class="grow"><b>Backup due</b> · ${lb ? 'last ' + fmtDate(lb.slice(0, 10)) : 'never backed up'}${dv.connected ? '' : ' · set up auto backup'}</span>›</button>`);
  }
  if (!live().length && S.accounts.every(a => !Number(a.opening))) alerts.push(`<button class="alert info" data-act="go" data-v="accounts"><span class="grow"><b>Start here:</b> enter how much is in your cash and bank today</span>›</button>`);

  const bs = billStats(t);
  const recent = [...S.entries].filter(e => !e.draft && e.type !== 'expected').sort(sortDesc).slice(0, 8);
  const shownAlerts = ui.allAlerts ? alerts : alerts.slice(0, 2);
  return `${sampleBanner()}
  <div class="tiles">
    <button class="tile" data-act="goEntries" data-filter="spent"><div class="lbl">Spent this month</div><div class="val out">${money(s.spent.total)}</div><div class="sub">your own money</div></button>
    <button class="tile" data-act="jump" data-tab="people"><div class="lbl">Owed to me</div><div class="val in">${money(s.owedToMe)}</div><div class="sub">people &amp; office</div></button>
    <button class="tile" data-act="jump" data-tab="people"><div class="lbl">I owe</div><div class="val ${s.iOwe ? 'out' : ''}">${money(s.iOwe)}</div><div class="sub">to people</div></button>
    <button class="tile" data-act="jump" data-tab="bills"><div class="lbl">Bills · 30 days</div><div class="val ${bs.overdue ? 'danger' : bs.count ? 'out' : ''}">${money(bs.total)}</div><div class="sub">${bs.count ? bs.count + ' unpaid' + (bs.overdue ? ', some overdue' : '') : 'nothing due'}</div></button>
  </div>
  <div class="cashline"><span>Cash &amp; bank now</span><b>${money(s.cash)}</b></div>
  ${shownAlerts.join('')}
  ${alerts.length > 2 ? `<button class="link small" style="margin:-2px 2px 8px" data-act="toggleAlerts">${ui.allAlerts ? 'Show less' : 'Show ' + (alerts.length - 2) + ' more'}</button>` : ''}
  <div class="sec-title">Quick add</div>
  <div class="chips">
    <button class="chip ghost" data-act="snap">📷 Snap receipt</button>
    ${S.templates.map(tp => `<button class="chip" data-act="useTpl" data-id="${tp.id}">${esc(tp.name)}</button>`).join('')}
  </div>
  ${S.templates.length ? '' : '<p class="muted small" style="margin:6px 2px 0">Tip: tick "Save as quick template" when adding something you repeat, like fuel. It will appear here for one-tap entry.</p>'}
  <div class="sec-title">Recent <span><button data-act="goSearch">Search</button> · <button data-act="goEntries" data-filter="">All</button></span></div>
  <div class="card flush">${recent.length ? recent.map(e => entryItem(e)).join('') : '<div class="empty">Nothing yet. Tap the <b>+</b> button below to add your first entry.<br><button class="link mt" data-act="go" data-v="help">How Hisaab works</button></div>'}</div>`;
};

function sampleBanner() {
  if (!S.settings.sample) return '';
  return PREVIEW
    ? `<div class="alert info"><span class="grow"><b>Preview</b> with sample data. Changes stay in this browser only.</span><button class="link" data-act="resetSample">Reset</button></div>`
    : `<div class="alert info"><span class="grow"><b>Sample data.</b> Look around freely, then start with your own.</span><button class="link" data-act="clearSample">Start fresh</button></div>`;
}
function ageBarsHtml() {
  const am = allocMap(), t = today();
  const buckets = [['0–30 days', 0, 30, ''], ['31–60 days', 31, 60, ''], ['61–90 days', 61, 90, 'w'], ['Over 90 days', 91, 1e9, 'd']].map(b => ({ label: b[0], min: b[1], max: b[2], cls: b[3], v: 0 }));
  for (const e of live()) if (e.type === 'recoverable') {
    const rem = recInfo(e, am).remaining; if (rem <= 0) continue;
    const age = daysBetween(e.date, t);
    const bk = buckets.find(b => age >= b.min && age <= b.max) || buckets[0];
    bk.v = r2(bk.v + rem);
  }
  if (!buckets.some(b => b.v > 0)) return '';
  const maxA = Math.max(1, ...buckets.map(b => b.v));
  return `<div class="card">${buckets.map(b => `<div class="bar-row"><div class="bar-top"><span>${b.label}</span><b>${money(b.v)}</b></div><div class="bar ${b.cls}"><i style="width:${(b.v / maxA) * 100}%"></i></div></div>`).join('')}</div>`;
}

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
  const seg = ui.peopleSeg || 'people';
  const head = `<div class="seg"><button class="${seg === 'people' ? 'on' : ''}" data-act="peopleSeg" data-seg="people">People</button><button class="${seg === 'rec' ? 'on' : ''}" data-act="peopleSeg" data-seg="rec">To get back</button></div>`;
  return head + (seg === 'rec' ? pendingRec() : peopleList());
};
function peopleList() {
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
      ${personAvatar(p)}
      <div class="li-main"><div class="li-title">${esc(p.name)}</div><div class="li-sub">${dueTag(p, v) || esc(PERSON_KINDS[p.kind] || '') + (p.phone ? ' · ' + esc(p.phone) : '')}</div></div>
      <div class="li-amt">${money(Math.abs(v))}<div class="li-sub">${st}</div></div></button>`;
  }).join('') : `<div class="empty">${q ? 'No match.' : 'No people yet. Add friends, staff, or your office/company as a person.'}</div>`}</div>`;
}

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
    <button data-act="quickType" data-type="spentBy" data-p="${pid}">${p.kind === 'staff' ? 'Spent from advance' : 'Paid for me'}</button>
  </div>
  <div class="linkrow"><button class="link" data-act="shareWA" data-p="${pid}">Send statement on WhatsApp</button><span>·</span><button class="link" data-act="printPerson" data-p="${pid}">PDF</button><span>·</span><button class="link" data-act="editPerson" data-id="${pid}">Edit</button></div>
  ${openRec.length ? `<div class="sec-title">${esc(p.name)} still owes you for <button data-act="recoverForPerson" data-p="${pid}">They paid</button></div>
  <div class="card flush">${openRec.sort(sortDesc).map(e => entryItem(e, { owed: true })).join('')}</div>` : ''}
  <div class="sec-title">Statement (${lines.length})</div>
  <div class="card flush">${lines.length ? `<table class="ledger"><thead><tr><th>What happened</th><th class="num">Amount</th><th class="num">Balance after</th></tr></thead>${[...lines].reverse().map(l => `
    <tr data-act="openEntry" data-id="${l.e.id}"><td><div>${esc(l.label)}</div><div class="muted small">${fmtShort(l.date)}${l.e.note && !l.label.startsWith('Recovered') ? ' · ' + esc(l.e.note) : ''}${l.e.workId && work(l.e.workId) ? ' · ' + esc(work(l.e.workId).name) : ''}</div></td>
    <td class="num">${money(Math.abs(l.v))}</td>
    <td class="num"><span class="${l.bal > 0 ? 'in' : l.bal < 0 ? 'out' : 'muted'}">${l.bal > 0 ? 'owes ' + money(l.bal) : l.bal < 0 ? 'you owe ' + money(-l.bal) : 'settled'}</span></td></tr>`).join('')}</table>` : '<div class="empty">No entries with this person yet.</div>'}</div>`;
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
  'out:me': 'Your own spending: grocery, fuel, bills. Counts in "Spent this month".',
  'out:me:later': 'Not paid yet. Shows in Bills until you tap Pay.',
  'out:back': 'You paid on behalf of your office, company or a person, and they will repay you. Not your spending; listed under People → To get back.',
  'out:person': 'Money handed to someone: a loan, a staff advance, or paying back what you owe them. The app works out which from their balance.',
  'in:income': 'Salary, TA, online income…',
  'in:income:later': 'Not received yet (TA claim, arrears, payout). Shows under People → To get back until you tap Receive.',
  'in:person': 'Someone returned your money, or lent you money.',
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
  const billOnly = f.type === 'expected' && f.direction === 'out' && (f.billOnly || f.editingId);
  if (billOnly) parts.push(`<div class="type-hint">A bill you pay regularly. Tap Pay in Bills when you pay it.</div>`);
  const segBtn = (v, label) => `<button type="button" class="${f.dir === v ? 'on' : ''}" data-act="setDir" data-v="${v}" ${lock ? 'disabled' : ''}>${label}</button>`;
  if (!billOnly) parts.push(`<div class="seg dir">${segBtn('out', 'Money out')}${segBtn('in', 'Money in')}${segBtn('move', 'Transfer')}</div>`);
  const kinds = f.dir === 'out' ? [['me', 'My expense'], ['back', 'Paid for someone'], ['person', 'Gave to someone']]
    : f.dir === 'in' ? [['income', 'Income'], ['person', 'Got from someone']] : [];
  if (kinds.length && !billOnly) parts.push(`<div class="chips" style="margin-bottom:8px">${kinds.map(([k, l]) => `<button class="chip ${f.kind === k ? 'on' : ''}" data-act="setKind" data-v="${k}" ${lock ? 'disabled' : ''}>${l}</button>`).join('')}</div>`);
  if (!billOnly) parts.push(`<div class="type-hint">${esc(UI_HINT[f.dir + ':' + (f.kind || '') + (f.later ? ':later' : '')] || '')}</div>`);
  if (f.dir === 'in' && !f.editingId && live().some(e => e.type === 'recoverable' && recInfo(e).remaining > 0)) parts.push(`<div class="type-hint">Getting back money you spent for office or someone? <button class="link small" data-act="goPending" data-seg="rec">Mark it in To get back ›</button></div>`);
  if (!billOnly && ['me', 'income'].includes(f.kind) && !f.linkExpected && !(f.editingId && !f.later && S.entries.find(x => x.id === f.editingId)?.linkExpected)) {
    parts.push(`<label class="inline-check" style="margin-top:-4px"><input type="checkbox" class="check" data-act="toggleLater" ${f.later ? 'checked' : ''} ${lock ? 'disabled' : ''}> ${f.dir === 'out' ? 'Not paid yet (due later)' : 'Not received yet (expected later)'}</label>`);
  }
  parts.push(`<div class="card">
    <div class="amount-box"><span>Rs</span><input id="amt" data-f="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(f.amount)}"><button type="button" class="calc" data-act="amtOp" data-op="+" aria-label="Add another amount">+ another</button></div>
    <div class="amount-preview" id="amtPreview"></div>`);



  const extra = [];
  const dateLbl = T.dateLabel || 'Date';
  const showBook = has('book') && !(f.type === 'expected' && f.direction !== 'out'), showCat = has('cat') || has('catIn') || has('catAny');
  const catKind = has('cat') ? 'out' : has('catIn') ? 'in' : (f.direction === 'out' ? 'out' : 'in');
  const use = {}; live().forEach(e => { if (e.categoryId) use[e.categoryId] = (use[e.categoryId] || 0) + 1; });
  const billMode = f.type === 'expected' && f.direction === 'out';
  const cats = S.categories.filter(c => c.kind === catKind && (billMode ? c.bill : (!c.bill || c.id === f.categoryId))).map((c, i) => ({ c, i })).sort((a, b) => (use[b.c.id] || 0) - (use[a.c.id] || 0) || a.i - b.i).map(x => x.c);
  const OLD_LBL = 'Old amount, from before I used Hisaab';
  // --- essentials
  if (showCat) parts.push(`<div class="field"><label>${billMode ? 'Bill type' : 'Category'}</label><div class="chips">${cats.map(c => `<button type="button" class="chip cat ${f.categoryId === c.id ? 'on' : ''}" style="--c:${c.color || '#868e96'}" data-act="pickCat" data-id="${c.id}"><i></i>${esc(c.name)}</button>`).join('')}<button type="button" class="chip ghost" data-act="editSimple" data-kind="${billMode ? 'catbill' : catKind === 'in' ? 'catin' : 'catout'}" data-fromform="1">+ New</button></div></div>`);
  if (has('person*') && !S.people.length) parts.push(`<div class="field"><label>${f.type === 'lent' ? 'To whom' : 'From whom'}</label><button type="button" class="btn primary block" data-act="editPerson" data-fromform="personId">+ Add the person first</button></div>`);
  else if (has('person*')) parts.push(`<div class="field"><label>${f.type === 'lent' ? 'To whom' : 'From whom'}</label><div class="row"><select class="inp grow" data-f="personId">${opt(S.people, f.personId, 'Select person')}</select><button type="button" class="btn sm" data-act="editPerson" data-fromform="personId">+ New</button></div></div>`);
  if (has('paidFrom')) {
    const people = S.people.map(p => `<option value="p:${p.id}" ${f.paidFrom === 'p:' + p.id ? 'selected' : ''}>${esc(p.name)} (${pb[p.id] > 0 ? 'advance ' + money(pb[p.id]) : pb[p.id] < 0 ? 'I owe ' + money(-pb[p.id]) : 'no balance'})</option>`).join('');
    parts.push(`<div class="field"><label>Paid from</label><select data-f="paidFrom">
      <option value="">Select</option>
      <optgroup label="My accounts">${accOpts.map(a => `<option value="a:${a.id}" ${f.paidFrom === 'a:' + a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</optgroup>
      ${f.type === 'recoverable' ? `<optgroup label="Old pending amount"><option value="old" ${f.paidFrom === 'old' ? 'selected' : ''}>${OLD_LBL}</option></optgroup>` : ''}
      ${S.people.length ? `<optgroup label="Someone paid for me (staff advance, or I owe them)">${people}</optgroup>` : ''}
    </select></div>`);
  }
  if (has('account')) parts.push(`<div class="field"><label>${f.type === 'transfer' ? 'From account' : ['income', 'borrowed', 'received'].includes(f.type) ? 'Into account' : 'From account'}</label><select data-f="accountId">${opt(accOpts, f.accountId, 'Select account')}${['lent', 'borrowed', 'advance', 'received', 'repaid'].includes(f.type) ? `<option value="__old" ${f.accountId === '__old' ? 'selected' : ''}>${OLD_LBL} (no account)</option>` : ''}</select></div>`);
  if ((has('paidFrom') && f.paidFrom === 'old') || (has('account') && f.accountId === '__old')) parts.push(`<div class="type-hint">Old amount: updates who owes whom, but does not change any account balance.</div>`);
  if (has('toAccount')) parts.push(`<div class="field"><label>To account</label><select data-f="toAccountId">${opt(accOpts, f.toAccountId, 'Select account')}</select></div>`);
  if (has('recoverFrom')) parts.push(`<div class="field"><label>Who repays you? (optional)</label><div class="row"><select class="inp grow" data-f="recoverFrom">${opt(S.people, f.recoverFrom, 'Not decided yet')}</select><button type="button" class="btn sm" data-act="editPerson" data-fromform="recoverFrom">+ New</button></div></div>`);
  const dateField = `<div class="field"><label>${dateLbl}</label><input type="date" data-f="date" value="${esc(f.date)}"></div>`;
  const repeatField = `<div class="field"><label>How often</label><select data-f="repeat">${REPEAT_OPT.map(([k, l]) => `<option value="${k}" ${(f.repeat || '') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
  if (billMode) {
    parts.push(`<div class="field"><label>Bill name</label><input data-f="note" value="${esc(f.note)}" placeholder="e.g. LESCO, SNGPL, PTCL, Netflix" maxlength="80"></div>`);
    parts.push(`<div class="two">${dateField}${repeatField}</div>`);
    if (f.repeat && f.date) parts.push(`<div class="type-hint">After you pay, the next one is due on <b>${fmtDate(nextDue(f.date, f.repeat))}</b>.</div>`);
    parts.push(`<div class="field"><label>Usually paid from</label><select data-f="accountId">${opt(accOpts, f.accountId, 'Choose when paying')}</select></div>`);
  } else if (f.type === 'expected') {
    parts.push(`<div class="two">${dateField}${repeatField}</div>`);
  } else extra.push(dateField);
  // --- more details
  if (showBook) extra.push(`<div class="field"><label>Area <span class="muted">(Home, Office, Car…)</span></label><select data-f="bookId">${opt(S.books, f.bookId, 'None')}</select></div>`);
  if (has('due')) extra.push(`<div class="field"><label>${f.type === 'received' ? 'Rest promised by' : 'Return by'} (optional)</label><input type="date" data-f="dueDate" value="${esc(f.dueDate)}"></div>`);
  if (has('personOpt') && !billMode) extra.push(`<div class="field"><label>From / to (optional)</label><select data-f="personId">${opt(S.people, f.personId, 'None')}</select></div>`);
  if (has('work') && (f.type !== 'lent' || f.workId || person(f.personId)?.kind === 'staff')) extra.push(`<div class="field"><label>Project / site (optional)</label><div class="row"><select class="inp grow" data-f="workId">${opt(S.works.filter(w => !w.closed || w.id === f.workId), f.workId, 'None')}</select><button type="button" class="btn sm" data-act="editWork" data-fromform="1">+ New</button></div></div>`);
  if (!billMode) extra.push(`<div class="field"><label>Note</label><input data-f="note" value="${esc(f.note)}" placeholder="What was it for?" maxlength="200"></div>`);
  if (has('receipt')) {
    const src = f.receiptData || (f.receipt ? imgCache[f.receipt] : '');
    extra.push(`<div class="field"><label>Receipt</label>${(f.receiptData || f.receipt)
      ? `<div class="receipt-thumb"><img id="rcptImg" src="${src || ''}" alt="Receipt"><button type="button" data-act="removeReceipt">×</button></div>`
      : `<button type="button" class="btn sm" data-act="pickReceipt">📎 Attach photo</button>`}</div>`);
  }
  if (!f.editingId || f.draftId) extra.push(`<label class="inline-check"><input type="checkbox" class="check" data-f="saveTpl" ${f.saveTpl ? 'checked' : ''}> Save as quick template (one tap next time)</label>
    ${f.saveTpl ? `<div class="field"><input data-f="tplName" value="${esc(f.tplName)}" placeholder="Template name, e.g. Govt vehicle fuel"></div>` : ''}`);
  const open = !!S.settings.addMore || !!f.editingId;
  const filled = [f.type !== 'expected' && f.date !== today() ? fmtShort(f.date) : '', showBook && book(f.bookId) ? book(f.bookId).name : '', f.note && !billMode ? 'note' : '', (f.receipt || f.receiptData) ? 'receipt' : '', f.workId && work(f.workId) ? work(f.workId).name : ''].filter(Boolean);
  parts.push(`<button type="button" class="more-toggle" data-act="toggleAddMore" aria-expanded="${open}"><span>More details${filled.length ? ': ' + esc(filled.join(' · ')) : billMode ? ' (area)' : ' (date, area, note, receipt)'}</span><span>${open ? '▴' : '▾'}</span></button>`);
  if (open) parts.push(`<div class="more-box">${extra.join('')}</div>`);
  parts.push(`</div>`);
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
  if (!raw.trim()) { el.textContent = 'Several items? Type the first, tap "+ another", type the next.'; return; }
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
  if (e.type === 'expected' && e.direction === 'out') {
    if (f.accountId && acc(f.accountId)) e.accountId = f.accountId;
    if (!e.note) e.note = cat(e.categoryId)?.name || 'Bill';
  }
  if (has('repeat')) e.repeat = REPEAT_M[f.repeat] ? f.repeat : '';
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
  if (e.categoryId && e.bookId) { S.settings.areaByCat = S.settings.areaByCat || {}; S.settings.areaByCat[e.categoryId] = e.bookId; }

  if (f.saveTpl) {
    const name = (f.tplName || '').trim() || entryTitle(e);
    S.templates.push({ id: uid(), name, data: { type: e.type, amount: f.amount && !/[+\-*/]/.test(f.amount) ? String(e.amount) : '', paidFrom: f.paidFrom, accountId: f.accountId, toAccountId: f.toAccountId, bookId: e.bookId || '', categoryId: e.categoryId || '', workId: e.workId || '', personId: f.personId, recoverFrom: f.recoverFrom, note: e.note, direction: f.direction } });
  }
  S.settings.last = { ...S.settings.last, paidFrom: (f.paidFrom && f.paidFrom !== 'old') ? f.paidFrom : S.settings.last.paidFrom, accountId: (f.accountId && f.accountId !== '__old') ? f.accountId : S.settings.last.accountId, bookId: f.bookId || S.settings.last.bookId };

  await save();
  const ret = f.returnTo;
  const wasEdit = !!f.editingId && !f.draftId;
  if (again && !wasEdit) {
    const keep = { billOnly: f.billOnly, type: f.type, direction: f.direction, dir: f.dir, kind: f.kind, later: f.later, date: f.date, paidFrom: f.paidFrom, accountId: f.accountId, bookId: f.bookId, personId: f.personId, workId: f.workId, recoverFrom: f.recoverFrom };
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
  else if (stack.length) stepBack();
  else setTab('home');
}

function cancelForm() {
  const ret = form.returnTo;
  resetForm();
  if (ret) { tab = ret.tab; stack = ret.stack; cur = ret.cur; render(); } else if (stack.length) stepBack(); else setTab('home');
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
  // A repeating bill is settled by any payment (electricity/gas amounts vary month to month)
  if (!x.closed && (xi.rem <= 0 || (x.direction === 'out' && REPEAT_M[x.repeat]))) closeExpected(x);
}
const REPEAT_M = { weekly: 0.25, monthly: 1, '2m': 2, '3m': 3, '6m': 6, yearly: 12 };
const REPEAT_LBL = { weekly: 'weekly', monthly: 'monthly', '2m': 'every 2 months', '3m': 'every 3 months', '6m': 'every 6 months', yearly: 'yearly' };
const REPEAT_OPT = [['', 'Only once'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['2m', 'Every 2 months'], ['3m', 'Every 3 months (quarterly)'], ['6m', 'Every 6 months'], ['yearly', 'Every year']];
function nextDue(date, rep) { return rep === 'weekly' ? addDays(date, 7) : addMonths(date, REPEAT_M[rep]); }
function closeExpected(x) {
  x.closed = true;
  if (REPEAT_M[x.repeat] && !x.spawned) {
    x.spawned = true;
    S.entries.push({
      id: uid(), type: 'expected', amount: x.amount, date: nextDue(x.date, x.repeat), note: x.note || '', categoryId: x.categoryId || '',
      bookId: x.bookId || '', accountId: x.accountId || '', personId: x.personId || '', direction: x.direction, repeat: x.repeat, closed: false, spawned: false,
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
    <div class="tile"><div class="lbl">Still to get back</div><div class="val in">${money(totalOpen)}</div><div class="sub">${openAll.length} item${openAll.length !== 1 ? 's' : ''}</div></div>
    <div class="tile"><div class="lbl">Older than ${S.settings.alertDays} days</div><div class="val ${oldN ? 'warn' : ''}">${oldN}</div><div class="sub">follow these up</div></div>
  </div>
  ${ageBarsHtml()}
  <div class="stack">
    <div class="chips" style="align-self:center">${[['open', 'Not paid yet'], ['closed', 'Paid back'], ['all', 'All']].map(([k, l]) => `<button class="chip ${ui.recFilter === k ? 'on' : ''}" data-act="recFilt" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="field"><select data-ui="recPerson" aria-label="From whom"><option value="">From: anyone</option><option value="_none" ${ui.recPerson === '_none' ? 'selected' : ''}>Not assigned</option>${S.people.map(p => `<option value="${p.id}" ${ui.recPerson === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
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
      <div class="li-amt">${money(open ? ri.remaining : e.amount)}<div class="li-sub"><span class="badge ${ri.status}">${STATUS_LBL[ri.status] || ri.status}</span>${open && ri.remaining !== e.amount ? ' of ' + money(e.amount) : ''}</div></div>
    </div>`;
  }).join('') : '<div class="empty">Nothing here.</div>'}</div>
  ${incomeDueHtml()}
  ${ui.sel.size ? `<div style="height:64px"></div><div class="sticky-bar"><button class="btn primary block" data-act="recordRecovery">They paid · ${ui.sel.size} selected · ${money(selTotal)}</button></div>` : '<p class="muted small mt">When money comes back, tick the items it covers and tap "They paid".</p>'}`;
}

function pendingExp(dirOnly) {
  const t = today();
  let list = live().filter(e => e.type === 'expected' && (!dirOnly || (e.direction === 'out' ? 'out' : 'in') === dirOnly)).map(e => ({ e, xi: expectedInfo(e) }));
  const open = list.filter(x => !x.xi.closed).sort((a, b) => (a.e.date < b.e.date ? -1 : 1));
  const closed = list.filter(x => x.xi.closed).sort((a, b) => (a.e.date < b.e.date ? 1 : -1));
  const inSum = r2(open.filter(x => x.e.direction !== 'out').reduce((s, x) => s + x.xi.rem, 0));
  const outSum = r2(open.filter(x => x.e.direction === 'out').reduce((s, x) => s + x.xi.rem, 0));
  const row = ({ e, xi }) => {
    const od = !xi.closed && e.date < t;
    return `<div class="list-item">
      <button class="li-main" style="text-align:left" data-act="openEntry" data-id="${e.id}">
        <div class="li-title">${esc(entryTitle(e))}</div>
        <div class="li-sub ${od ? 'danger' : ''}">${fmtDate(e.date)}${od ? ' · overdue' : ''}${REPEAT_LBL[e.repeat] ? ' · ' + REPEAT_LBL[e.repeat] : ''}${person(e.personId) ? ' · ' + esc(person(e.personId).name) : ''}</div>
      </button>
      <div class="li-amt ${e.direction === 'out' ? 'out' : 'in'}">${e.direction === 'out' ? '-' : '+'}${money(xi.closed ? e.amount : xi.rem)}
      ${!xi.closed ? `<div><button class="btn sm" data-act="payExpected" data-id="${e.id}">${e.direction === 'out' ? 'Pay' : 'Receive'}</button></div>` : '<div class="li-sub">done</div>'}</div>
    </div>`;
  };
  return `
  <div class="tiles">
    <div class="tile"><div class="lbl">To receive</div><div class="val in">${money(inSum)}</div><div class="sub">TA, arrears, payouts</div></div>
    ${dirOnly ? `<div class="tile"><div class="lbl">Open items</div><div class="val">${open.length}</div></div>` : `<div class="tile"><div class="lbl">To pay</div><div class="val out">${money(outSum)}</div></div>`}
  </div>
  <button class="btn primary block" data-act="quickType" data-type="expected">+ Add income due</button>
  <div class="sec-title">Open</div>
  <div class="card flush">${open.length ? open.map(row).join('') : '<div class="empty">Nothing due. Add TA claims, salary arrears or online payouts you are waiting for.</div>'}</div>
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
    ${item('works', 'Projects / sites', `${S.works.length} · group spending by a job, site or event`)}
    ${item('templates', 'Quick templates', `${S.templates.length} saved`)}
    ${item('books', 'Areas', (S.books.map(b => b.name).join(', ') || 'None') + ' · split your spending')}
    ${item('cats', 'Categories', `${S.categories.length} categories`)}
  </div>
  <div class="card flush">
    ${item('backup', 'Backup & restore', S.settings.drive.connected ? (S.settings.drive.needsReconnect ? 'Google Drive: reconnect needed' : 'Google Drive auto backup on' + (S.settings.drive.lastBackup ? ' · ' + fmtDate(S.settings.drive.lastBackup.slice(0, 10)) : '')) : lb ? 'Last backup ' + fmtDate(lb.slice(0, 10)) : 'Never backed up')}
    ${item('security', 'App lock', S.settings.pinHash ? 'PIN is on' : 'Off')}
    <button class="list-item" data-act="toggleNum"><div class="li-main"><div class="li-title">Number style</div><div class="li-sub">${S.settings.numStyle === 'intl' ? 'International: 1,250,000' : 'Lakh: 12,50,000'} · tap to switch</div></div></button>
    ${item('help', 'How it works', 'Plain guide to every screen')}
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
      <div><button class="btn sm" data-act="balanceCheck" data-id="${a.id}">Fix balance</button> <button class="btn sm" data-act="editAccount" data-id="${a.id}">Edit</button></div></div>
  </div>`).join('') || '<div class="empty">No accounts.</div>'}</div>
  <p class="muted small mt"><b>Fix balance</b>: enter what is actually in the wallet/bank. If it differs, one adjustment entry fixes the balance. Do this monthly.</p>`;
};

function simpleList(kind, items, sub, colored) {
  return `<button class="btn block" style="margin-bottom:12px" data-act="editSimple" data-kind="${kind}">+ Add</button>
  <div class="card flush">${items.map(x => `<button class="list-item" data-act="editSimple" data-kind="${kind}" data-id="${x.id}">
    ${colored ? `<span class="ico" style="--c:${x.color || '#868e96'}" aria-hidden="true">${esc(x.name.trim()[0] || '•').toUpperCase()}</span>` : ''}
    <div class="li-main"><div class="li-title">${esc(x.name)}</div>${sub ? `<div class="li-sub">${sub(x)}</div>` : ''}</div>›</button>`).join('') || '<div class="empty">None yet.</div>'}</div>`;
}
VIEWS.books = () => `<p class="muted small" style="margin:0 2px 10px">Areas split your spending so you can compare, for example Home vs Office vs Car. Categories (fuel, grocery…) say what it was; the area says what it was for.</p>` + simpleList('book', S.books, b => `${live().filter(e => e.bookId === b.id).length} entries`);
VIEWS.cats = () => `<div class="sec-title">Spending</div>${simpleList('catout', S.categories.filter(c => c.kind === 'out' && !c.bill), null, true)}<div class="sec-title">Bill types</div>${simpleList('catbill', S.categories.filter(c => c.bill), null, true)}<div class="sec-title">Income</div>${simpleList('catin', S.categories.filter(c => c.kind === 'in'), null, true)}`;

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
    <div class="tile"><div class="lbl">Still to get back</div><div class="val in">${money(st.recPending)}</div><div class="sub">advances given ${money(st.adv)}</div></div>
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
    if (F.cat) list = list.filter(e => catOf(e) === F.cat);
  }
  if (F.q) { const q = F.q.toLowerCase(); list = list.filter(e => (entryTitle(e) + ' ' + entrySub(e) + ' ' + e.amount).toLowerCase().includes(q)); }
  list.sort(sortDesc);
  const types = [...TYPE_ORDER, 'recovery', 'adjustment'];
  return `<input class="inp" placeholder="Search note, person, amount…" value="${esc(F.q)}" data-ef="q" style="margin-bottom:10px">
  ${F.drafts ? `<div class="alert info"><span class="grow">Showing incomplete receipts</span><button class="link" data-act="clearEF">Show all</button></div>` : F.spentOnly ? `<div class="alert info"><span class="grow">Own spending${F.cat ? ': ' + esc(catName(F.cat)) : ''}</span><button class="link" data-act="clearEF">Show all</button></div>` : ''}
  ${F.drafts ? '' : `<div class="two">
    <div class="field"><input type="month" value="${esc(F.month)}" data-ef="month"></div>
    <div class="field"><select data-ef="type"><option value="">All types</option>${types.map(t => `<option value="${t}" ${F.type === t ? 'selected' : ''}>${typeLabel(t)}</option>`).join('')}</select></div>
    <div class="field"><select data-ef="book"><option value="">All books</option>${S.books.map(b => `<option value="${b.id}" ${F.book === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
    <div class="field"><select data-ef="person"><option value="">All people</option>${S.people.map(p => `<option value="${p.id}" ${F.person === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
  </div>`}
  <div class="muted small" style="margin:0 2px 6px">${list.length} entr${list.length === 1 ? 'y' : 'ies'}${F.month && !F.drafts ? ' · ' + monthLabel(F.month) : ''}</div>
  <div class="card flush">${list.length ? list.map(e => entryItem(e)).join('') : '<div class="empty">No entries match.</div>'}</div>`;
};

// ---------------- Bills ----------------
function billStats(t) {
  const lim = addDays(t, 30);
  const open = live().filter(e => e.type === 'expected' && e.direction === 'out' && !expectedInfo(e).closed);
  const due = open.filter(e => e.date <= lim);
  return { count: due.length, total: r2(due.reduce((a, e) => a + expectedInfo(e).rem, 0)), overdue: open.some(e => e.date < t) };
}
VIEWS.bills = () => billsList();
function incomeDueHtml() {
  const t = today();
  const items = live().filter(e => e.type === 'expected' && e.direction !== 'out' && !expectedInfo(e).closed).sort((a, b) => (a.date < b.date ? -1 : 1));
  const row = e => { const od = e.date < t; return `<div class="list-item">${entryIcon(e)}
    <button class="li-main" style="text-align:left" data-act="openEntry" data-id="${e.id}"><div class="li-title">${esc(entryTitle(e))}</div>
    <div class="li-sub ${od ? 'danger' : ''}">${od ? 'Was due ' : 'Expected '}${fmtShort(e.date)}${REPEAT_LBL[e.repeat] ? ' · ' + REPEAT_LBL[e.repeat] : ''}</div></button>
    <div class="li-amt in">${money(expectedInfo(e).rem)}<div><button class="btn sm" data-act="payExpected" data-id="${e.id}">Received</button></div></div></div>`; };
  return `<div class="sec-title">Income expected <button data-act="quickType" data-type="expected">+ Add</button></div>
  <div class="card flush">${items.length ? items.map(row).join('') : '<div class="empty small">TA claims, arrears or payouts you are waiting for. Tap "+ Add".</div>'}</div>`;
}
function billsList() {
  const t = today(), filt = ui.billFilter || 'unpaid';
  const unpaid = live().filter(e => e.type === 'expected' && e.direction === 'out' && !expectedInfo(e).closed).sort((a, b) => (a.date < b.date ? -1 : 1));
  const billIds = new Set(S.entries.filter(e => e.type === 'expected' && e.direction === 'out').map(e => e.id));
  const paid = live().filter(e => e.linkExpected && billIds.has(e.linkExpected) && e.type === 'expense').sort(sortDesc);
  const st = billStats(t), overdue = unpaid.filter(e => e.date < t).length;
  const row = e => { const od = e.date < t, d = daysBetween(t, e.date);
    return `<div class="list-item">${entryIcon(e)}
    <button class="li-main" style="text-align:left" data-act="openEntry" data-id="${e.id}"><div class="li-title">${esc(entryTitle(e))}</div>
    <div class="li-sub ${od ? 'danger' : d <= 3 ? 'warn' : ''}">${od ? 'Overdue since ' + fmtShort(e.date) : d === 0 ? 'Due today' : 'Due ' + fmtShort(e.date)}${REPEAT_LBL[e.repeat] ? ' · ' + REPEAT_LBL[e.repeat] : ''}</div></button>
    <div class="li-amt">${money(expectedInfo(e).rem)}<div><button class="btn sm" data-act="payExpected" data-id="${e.id}">Pay</button></div></div></div>`; };
  const unpaidHtml = unpaid.length ? `<div class="card flush">${unpaid.map(row).join('')}</div>`
    : `<div class="empty">${S.entries.some(e => e.type === 'expected' && e.direction === 'out') ? 'All bills paid ✓' : 'No bills yet. Add electricity, gas, internet, rent, or subscriptions like Netflix or ChatGPT.'}</div>`;
  const paidHtml = paid.length ? `<div class="card flush">${paid.map(e => entryItem(e)).join('')}</div>` : '<div class="empty">No bill payments yet.</div>';
  const counts = { unpaid: unpaid.length, paid: paid.length };
  return `<div class="bill-sum"><span><b>${money(st.total)}</b> due in the next 30 days</span>${overdue ? `<span class="badge overdue">${overdue} overdue</span>` : ''}</div>
  <div class="row" style="margin-bottom:12px;flex-wrap:wrap">
    <div class="chips grow">${[['unpaid', 'Unpaid'], ['paid', 'Paid'], ['all', 'All']].map(([k, l]) => `<button class="chip ${filt === k ? 'on' : ''}" data-act="billFilt" data-v="${k}">${l}${counts[k] !== undefined ? ' ' + counts[k] : ''}</button>`).join('')}</div>
    <button class="btn primary sm" data-act="addBill">+ Add bill</button>
  </div>
  ${filt === 'unpaid' ? unpaidHtml : filt === 'paid' ? paidHtml : `<div class="sec-title">Unpaid</div>${unpaidHtml}<div class="sec-title">Paid</div>${paidHtml}`}
  <p class="muted small mt">Bill amount changes every month? Enter the usual amount; when you tap Pay, type the real one. The next bill is created automatically.</p>`;
}

// ---------------- Insights ----------------
function shiftYm(ym, n) { return addMonths(ym + '-01', n).slice(0, 7); }
function catOf(e) { return e.type === 'adjustment' ? '_unrec' : (e.categoryId || '_none'); }
function catName(id) { return id === '_unrec' ? 'Unrecorded (balance check)' : id === '_none' ? 'No category' : (cat(id)?.name || 'Deleted'); }
function bookName(id) { return id === '_unrec' ? 'Unrecorded (balance check)' : id === '_none' ? 'No area' : (book(id)?.name || 'Deleted'); }
function spendMonth(ym) { return ownSpending(...monthBounds(ym)); }
function insightTeaser(t) {
  const ym = t.slice(0, 7), cur = spendMonth(ym), prev = spendMonth(shiftYm(ym, -1));
  const top = Object.entries(cur.byCat).sort((a, b) => b[1] - a[1])[0];
  if (!cur.total) return { text: 'No spending yet', sub: 'this month' };
  const ch = prev.total ? Math.round((cur.total - prev.total) / prev.total * 100) : null;
  return { text: top ? esc(catName(top[0])) : 'This month', sub: (top ? 'top category · ' : '') + (ch === null ? 'see breakdown' : (ch >= 0 ? '+' : '') + ch + '% vs last month so far') };
}
let insMonth = null;
VIEWS.insights = () => {
  const ym = insMonth || today().slice(0, 7);
  const cur = spendMonth(ym), prev = spendMonth(shiftYm(ym, -1));
  const past = [1, 2, 3].map(i => spendMonth(shiftYm(ym, -i)));
  const avg = id => r2(past.reduce((a, m) => a + (m.byCat[id] || 0), 0) / 3);
  const ch = prev.total ? Math.round((cur.total - prev.total) / prev.total * 100) : null;
  const cats = Object.entries(cur.byCat).sort((a, b) => b[1] - a[1]);
  const maxC = Math.max(1, ...cats.map(c => c[1]));
  const catRows = cats.map(([id, v]) => {
    const a = avg(id);
    const tag = a === 0 ? (past.some(m => m.total) ? '<span class="badge partial">new</span>' : '') : v > a * 1.3 && v - a >= 500 ? `<span class="badge overdue">${Math.round((v - a) / a * 100)}% above usual</span>` : '';
    return `<button class="bar-row" style="display:block;width:100%;text-align:left" data-act="insCat" data-c="${esc(id)}">
      <div class="bar-top"><span>${esc(catName(id))} ${tag}</span><b>${money(v)}</b></div>
      <div class="bar"><i style="width:${v / maxC * 100}%;background:${id.startsWith('_') ? 'var(--muted)' : catColor(id)}"></i></div>
      ${a ? `<div class="muted small">usual ${money(Math.round(a))} / month</div>` : ''}</button>`;
  }).join('');
  const books = Object.entries(cur.byBook).sort((a, b) => b[1] - a[1]);
  const maxB = Math.max(1, ...books.map(c => c[1]));
  const [f, to] = monthBounds(ym);
  const big = live().filter(e => e.type === 'expense' && e.date >= f && e.date <= to).sort((a, b) => b.amount - a.amount).slice(0, 5);
  const months = [5, 4, 3, 2, 1, 0].map(i => { const m = shiftYm(ym, -i); return { m, v: spendMonth(m).total }; });
  const maxM = Math.max(1, ...months.map(x => x.v));
  const isNow = ym === today().slice(0, 7);
  return `<div class="row" style="margin-bottom:12px">
    <button class="btn sm" data-act="insMove" data-n="-1">‹</button>
    <div class="grow" style="text-align:center;font-weight:650">${monthLabel(ym)}</div>
    <button class="btn sm" data-act="insMove" data-n="1" ${isNow ? 'disabled' : ''}>›</button>
  </div>
  <div class="tiles">
    <div class="tile"><div class="lbl">Own spending</div><div class="val out">${money(cur.total)}</div><div class="sub">${isNow ? 'so far this month' : 'whole month'}</div></div>
    <div class="tile"><div class="lbl">vs ${monthLabel(shiftYm(ym, -1)).split(' ')[0]}</div><div class="val ${ch > 0 ? 'out' : 'in'}">${ch === null ? '—' : (ch >= 0 ? '+' : '') + ch + '%'}</div><div class="sub">${money(prev.total)} last month</div></div>
  </div>
  <div class="sec-title">By category <span class="muted" style="text-transform:none;font-weight:400">tap to see entries</span></div>
  <div class="card">${catRows || '<div class="muted small">No own spending in this month.</div>'}</div>
  <div class="sec-title">By area</div>
  <div class="card">${books.length ? books.map(([id, v]) => `<div class="bar-row"><div class="bar-top"><span>${esc(bookName(id))}</span><b>${money(v)}</b></div><div class="bar"><i style="width:${v / maxB * 100}%"></i></div></div>`).join('') : '<div class="muted small">Nothing yet.</div>'}</div>
  <div class="sec-title">Biggest expenses</div>
  <div class="card flush">${big.length ? big.map(e => entryItem(e)).join('') : '<div class="empty">None.</div>'}</div>
  ${months.filter(x => x.v).length < 2 ? '' : `<div class="sec-title">Last 6 months</div>
  <div class="card">${months.map(x => `<div class="bar-row"><div class="bar-top"><span>${monthLabel(x.m)}</span><b>${money(x.v)}</b></div><div class="bar"><i style="width:${x.v / maxM * 100}%"></i></div></div>`).join('')}</div>`}
  ${cur.total ? '' : '<p class="muted small mt">Add a few expenses and this page shows where your money goes, by category and area, and what is above your usual.</p>'}
  <p class="muted small mt">Only your own money: expenses, amounts you won't get back, and gaps found by Fix balance. Office money you will get back, loans and transfers are not counted.</p>`;
};

// ---------------- Welcome (first run) ----------------
let wiz = null;
function startWelcome() {
  wiz = { step: 1, connect: false,
    accounts: S.accounts.map(a => ({ id: a.id, name: a.name, bal: a.opening ? String(a.opening) : '' })),
    books: S.books.map(b => ({ id: b.id, name: b.name, on: true })) };
}
function readWiz() {
  if (!wiz) return;
  $$('[data-wa]').forEach(inp => { const a = wiz.accounts[+inp.dataset.i]; if (a) a[inp.dataset.wa] = inp.value; });
}
VIEWS.welcome = () => {
  if (!wiz) startWelcome();
  const st = wiz.step;
  const dots = `<div class="wdots" aria-label="Step ${st} of 4">${[1, 2, 3, 4].map(i => `<i class="${i <= st ? 'on' : ''}"></i>`).join('')}</div>`;
  if (st === 1) return `${dots}<div class="welcome">
    <h2>Welcome to Hisaab</h2>
    <p class="muted">Your money, and the people it involves, in one place.</p>
    <div class="wlist">
      <div><span class="ico" style="--c:var(--out)">−</span><div><b>What you spend</b><br><span class="muted small">Split by area, like Home, Office or Car</span></div></div>
      <div><span class="ico" style="--c:var(--in)">↙</span><div><b>Who owes you, and whom you owe</b><br><span class="muted small">With a clear statement to send on WhatsApp</span></div></div>
      <div><span class="ico" style="--c:var(--move)">↻</span><div><b>Money you'll get back</b><br><span class="muted small">From your office, company or anyone</span></div></div>
      <div><span class="ico" style="--c:var(--warn)">◷</span><div><b>Bills and payments due</b><br><span class="muted small">With reminders before the due date</span></div></div>
    </div>
    <p class="small muted">Everything stays on this phone. You can back it up to your own Google Drive.</p>
    <button class="btn primary block" data-act="wNext">Set up in 2 minutes</button>
    <button class="btn block mt" data-act="wSample">Try it with sample data first</button>
    <div class="row" style="justify-content:center;gap:18px;margin-top:12px"><button class="link" data-act="wRestore">Restore from a backup</button><button class="link" data-act="wSkip">Skip setup</button></div></div>`;
  if (st === 2) return `${dots}<div class="welcome">
    <h2>Where is your money today?</h2>
    <p class="muted small">Enter what's in each account right now. Rename, add or remove so the list matches yours. You can change this later.</p>
    <div class="card flush">${wiz.accounts.map((a, i) => `<div class="list-item">
      <input class="inp grow" data-wa="name" data-i="${i}" value="${esc(a.name)}" aria-label="Account name" placeholder="Account name">
      <input class="inp" style="width:120px;text-align:right" data-wa="bal" data-i="${i}" value="${esc(a.bal)}" inputmode="decimal" placeholder="0" aria-label="Balance">
      <button class="icon-btn" data-act="wDelAcc" data-i="${i}" aria-label="Remove">×</button></div>`).join('')}</div>
    <button class="btn sm mt" data-act="wAddAcc">+ Add account</button>
    <div class="btn-row mt"><button class="btn" data-act="wBack">Back</button><button class="btn primary" data-act="wNext">Next</button></div></div>`;
  if (st === 3) return `${dots}<div class="welcome">
    <h2>What do you spend on?</h2>
    <p class="muted small">Areas keep spending apart so you can compare, for example Home vs Office vs Car. Tap to turn off any you don't need. Categories like fuel and grocery are already set up.</p>
    <div class="chips">${wiz.books.map((b, i) => `<button class="chip ${b.on ? 'on' : ''}" data-act="wToggleBook" data-i="${i}">${b.on ? '✓ ' : ''}${esc(b.name)}</button>`).join('')}</div>
    <div class="row mt"><input class="inp grow" id="wNewBook" placeholder="Add an area, e.g. Farm, Shop"><button class="btn" data-act="wAddBook">Add</button></div>
    <div class="btn-row mt"><button class="btn" data-act="wBack">Back</button><button class="btn primary" data-act="wNext">Next</button></div></div>`;
  return `${dots}<div class="welcome">
    <h2>Keep a backup</h2>
    <p class="muted small">Your entries live only on this phone. If the phone is lost or Chrome's data is cleared, they are gone unless you back up.</p>
    ${driveClientId() ? `<div class="card"><b>Google Drive (automatic)</b><p class="muted small mt">Saves to a "Hisaab Backups" folder in your own Drive after each change. Hisaab can only see files it created.</p>
      <button class="btn primary block mt" data-act="wFinish" data-connect="1">Finish and connect Google Drive</button></div>` : ''}
    <div class="card"><b>Backup file</b><p class="muted small mt">Save one file to WhatsApp, email or USB, anytime from More → Backup.</p></div>
    <div class="btn-row"><button class="btn" data-act="wBack">Back</button><button class="btn ${driveClientId() ? '' : 'primary'}" data-act="wFinish">${driveClientId() ? 'Finish, back up later' : 'Finish'}</button></div></div>`;
};
async function finishWelcome(connect) {
  readWiz();
  const used = id => S.entries.some(e => e.accountId === id || e.toAccountId === id);
  const keep = [];
  for (const a of wiz.accounts) {
    const name = (a.name || '').trim(); if (!name) continue;
    const v = String(a.bal || '').trim() === '' ? 0 : evalAmount(a.bal);
    const opening = isNaN(v) ? 0 : v;
    if (a.id && acc(a.id)) { Object.assign(acc(a.id), { name, opening }); keep.push(a.id); }
    else { const id = uid(); S.accounts.push({ id, name, opening }); keep.push(id); }
  }
  S.accounts = S.accounts.filter(a => keep.includes(a.id) || used(a.id));
  if (!S.accounts.length) S.accounts.push({ id: uid(), name: 'Cash', opening: 0 });
  const usedB = id => S.entries.some(e => e.bookId === id);
  for (const b of wiz.books) { if (b.on && !b.id) S.books.push({ id: uid(), name: b.name }); }
  S.books = S.books.filter(b => usedB(b.id) || wiz.books.some(x => x.id === b.id && x.on) || !wiz.books.some(x => x.id === b.id));
  S.settings.last = {};
  S.settings.onboarded = true;
  wiz = null;
  await save();
  resetForm();
  setTab('home');
  if (connect) driveAuth('connect', true);
  else toast("You're set. Tap + to add your first entry");
}

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

VIEWS.help = () => `<div class="card small help">
  <h4>The idea</h4>
  <p>Hisaab separates <b>your own spending</b> from money that only passes through your hands (loans, office expenses you'll get back). That keeps "Spent this month" honest.</p>
  <h4>Adding an entry (+)</h4>
  <p><b>Money out → My expense</b>: grocery, fuel, anything that is your own cost.<br>
  <b>Money out → Paid for someone</b>: you paid on behalf of your office or someone, and they will repay you. Shows under People → To get back.<br>
  <b>Money out → Gave to someone</b>: cash handed over: a loan, a staff advance, or paying back what you owe.<br>
  <b>Money in → Income</b>: salary, TA, online income.<br>
  <b>Money in → Got from someone</b>: someone returns your money, or lends you some.<br>
  <b>Transfer</b>: between your own accounts, e.g. bank to cash.</p>
  <p>Tick <b>Not paid yet</b> / <b>Not received yet</b> for something due later. Tap <b>More details</b> for date, area, note or a receipt photo.</p>
  <h4>Words used</h4>
  <p><b>Account</b>: where money sits (cash, bank, Easypaisa).<br>
  <b>Category</b>: what it was (fuel, grocery).<br>
  <b>Area</b>: what it was for (Home, Office, Car). Optional.</p>
  <h4>Tabs</h4>
  <p><b>People</b>: everyone you deal with, their balance and a statement to share. <b>To get back</b> lists money you paid for office or others, plus income you're expecting (TA, payouts). When money comes, tick the items and tap They paid.<br>
  <b>Bills</b>: Unpaid, Paid or All. Tap Pay with the real amount; repeating bills come back automatically.<br>
  <b>Insights</b>: where your own money went this month, and what is above your usual.</p>
  <h4>Keeping it accurate</h4>
  <p>Once a month, More → Accounts → <b>Check</b>: type what's really in your wallet or bank; the app fixes the difference. For old loans from before you started, choose "Old amount, from before I used Hisaab" so your account balances aren't touched.</p>
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
  if (e.bookId) dl('Area', esc(book(e.bookId)?.name || '—'));
  if (e.categoryId) dl('Category', esc(cat(e.categoryId)?.name || '—'));
  if (e.workId) dl('Work', esc(work(e.workId)?.name || '—'));
  if (e.dueDate) dl('Return by', fmtDate(e.dueDate));
  if (REPEAT_LBL[e.repeat]) dl('Repeats', REPEAT_LBL[e.repeat]);
  if (e.note) dl('Note', esc(e.note));
  const actions = [];
  let extra = '';
  if (e.type === 'recoverable' && !e.draft) {
    const ri = recInfo(e);
    dl('Status', `<span class="badge ${ri.status}">${STATUS_LBL[ri.status] || ri.status}</span>`);
    dl('Paid back', money(ri.recovered));
    if (ri.writtenOff) dl('Written off', `${money(ri.writtenOff)} on ${fmtDate(e.writtenOff.date)}`);
    dl('Remaining', `<b>${money(ri.remaining)}</b>`);
    const recs = live().filter(x => x.type === 'recovery' && (x.allocations || []).some(a => a.id === e.id));
    if (recs.length) extra += `<div class="sec-title">Paid back so far</div><div class="card flush">${recs.map(r => { const a = r.allocations.find(a => a.id === e.id); return `<button class="list-item" data-act="openEntry" data-id="${r.id}"><div class="li-main"><div class="li-title">${fmtDate(r.date)}</div><div class="li-sub">${esc(acc(r.accountId)?.name || '')}</div></div><div class="li-amt in">${money(a.amount)}</div></button>`; }).join('')}</div>`;
    if (ri.remaining > 0) { actions.push(`<button class="btn primary" data-act="recoverOne" data-id="${e.id}">They paid</button>`); actions.push(`<button class="btn" data-act="writeOff" data-id="${e.id}">Won't get it back</button>`); }
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
  openSheet(`${sheetHead('Money received back')}
    <div class="field"><label>Amount received</label><input id="rcAmt" inputmode="decimal" value="${total}" data-rc="amt"></div>
    <div class="two">
      <div class="field"><label>Into account</label><select id="rcAcc">${opt(S.accounts.map(a => ({ id: a.id, name: `${a.name} (${money(ab[a.id] || 0)})` })), S.settings.last.accountId || S.accounts[0]?.id)}</select></div>
      <div class="field"><label>Date</label><input type="date" id="rcDate" value="${today()}"></div>
    </div>
    <div class="field"><label>Received from (optional)</label><select id="rcPerson">${opt(S.people, pid, 'Not specified')}</select></div>
    <div class="field"><label>Note / reference</label><input id="rcNote" placeholder="e.g. Estimate no., cheque no."></div>
    <div class="sec-title">Which items does this pay for?</div>
    <div class="card flush" id="rcList">${items.map((x, i) => `<div class="list-item">
      <div class="li-main"><div class="li-title">${esc(entryTitle(x.e))}</div><div class="li-sub">${fmtShort(x.e.date)} · pending ${money(x.rem)}</div></div>
      <input class="inp" style="width:110px;text-align:right" inputmode="decimal" data-rc="alloc" data-i="${i}" value="${x.rem}"></div>`).join('')}</div>
    <div id="rcMsg" class="small mt"></div>
    <button class="btn primary block mt" data-act="saveRecovery">Save</button>`);
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
  toast('Saved. Remaining amount updated');
  render();
}

// Write-off
function openWriteOff(id) {
  const e = S.entries.find(x => x.id === id); if (!e) return;
  const ri = recInfo(e);
  openSheet(`${sheetHead("Won't get it back")}
    <p style="margin-bottom:12px">Write off ${money(ri.remaining)} of "${esc(entryTitle(e))}"? It stops being pending and is counted as your own spending from the date below.</p>
    <div class="field"><label>Date</label><input type="date" id="woDate" value="${today()}"></div>
    <div class="btn-row"><button class="btn" data-act="closeSheet">Cancel</button><button class="btn danger" data-act="saveWriteOff" data-id="${id}">Confirm</button></div>`);
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
  const what = kind === 'book' ? 'area' : kind === 'catbill' ? 'bill type' : 'category';
  const isCat = kind !== 'book';
  const col = (x && x.color) || PALETTE[S.categories.length % PALETTE.length];
  openSheet(`${sheetHead((x ? 'Edit ' : 'New ') + what)}
    <div class="field"><label>Name</label><input id="sName" value="${esc(x?.name || '')}"></div>
    ${isCat ? `<div class="field"><label>Color</label><input type="hidden" id="sColor" value="${col}"><div class="chips">${PALETTE.map(c => `<button type="button" class="swatch ${c === col ? 'on' : ''}" style="--c:${c}" data-act="pickSwatch" data-c="${c}" aria-label="Color ${c}"></button>`).join('')}</div></div>` : ''}
    <div class="btn-row">${x ? `<button class="btn danger" data-act="deleteSimple" data-kind="${kind}" data-id="${x.id}">Delete</button>` : ''}<button class="btn primary" data-act="saveSimple" data-kind="${kind}" data-id="${x?.id || ''}">Save</button></div>`);
  setTimeout(() => $('#sName')?.focus(), 50);
}
async function saveSimple(kind, id) {
  const name = $('#sName').value.trim();
  if (!name) { toast('Enter a name'); return; }
  if (kind === 'book') { if (id) book(id).name = name; else S.books.push({ id: uid(), name }); }
  else {
    const color = $('#sColor') ? $('#sColor').value : PALETTE[0];
    if (id) Object.assign(cat(id), { name, color });
    else { const nid = uid(); S.categories.push({ id: nid, name, kind: kind === 'catin' ? 'in' : 'out', color, ...(kind === 'catbill' ? { bill: true } : {}) }); if (cur.v === 'add') form.categoryId = nid; }
  }
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
  const say = l => ({ 'You gave': 'I gave you', 'Advance given': 'Advance to you', 'You paid them': 'I paid you', 'They gave you': 'You gave me', 'They paid you': 'You paid me', 'Spent for me': 'You spent for me', 'You paid for them': 'I paid on your behalf', 'Written off': 'Waived' }[l.label] || (l.label.startsWith('Recovered') ? 'You repaid' : l.label));
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
  jump: el => { const t = el.dataset.tab; if (t === 'people') ui.peopleSeg = el.dataset.seg || 'people'; if (t === 'bills') ui.billFilter = 'unpaid'; jump(t); },
  tab: el => { const t = el.dataset.tab; if (t === 'people') ui.peopleSeg = 'people'; if (t === 'bills') ui.billFilter = 'unpaid';
    const ret = t === 'add' && cur.v !== 'add' && S.settings.onboarded ? { tab, stack: [...stack], cur: { ...cur } } : null;
    setTab(t); if (ret && ret.cur.v !== 'home') form.returnTo = ret; },
  go: el => go(el.dataset.v, el.dataset.p || null),
  back: () => { if (stack.length) history.back(); else back(); },
  goPending: el => {
    if (el.dataset.seg === 'rec' || el.dataset.seg === 'income') { ui.peopleSeg = 'rec'; jump('people'); }
    else { const outOverdue = live().some(e => e.type === 'expected' && e.direction === 'out' && !expectedInfo(e).closed && e.date < today()); if (outOverdue) { ui.billFilter = 'unpaid'; jump('bills'); } else { ui.peopleSeg = 'rec'; jump('people'); } }
  },
  peopleSeg: el => { ui.peopleSeg = el.dataset.seg; render(); },
  billFilt: el => { ui.billFilter = el.dataset.v; render(); },
  recFilt: el => { ui.recFilter = el.dataset.v; render(); },
  goSearch: () => { ui.entryFilter = { month: '', type: '', book: '', person: '', work: '', q: '', drafts: false, spentOnly: false }; go('entries'); setTimeout(() => $('[data-ef="q"]')?.focus(), 60); },
  pickCat: el => {
    const id = el.dataset.id;
    const prevName = cat(form.categoryId)?.name;
    form.categoryId = form.categoryId === id ? '' : id;
    if (form.type === 'expected' && form.direction === 'out' && (!form.note || form.note === prevName)) form.note = cat(form.categoryId)?.name || '';
    const remembered = (S.settings.areaByCat || {})[form.categoryId];
    if (form.categoryId && remembered && !form.bookTouched && book(remembered)) form.bookId = remembered;
    render();
  },
  toggleAddMore: async () => { S.settings.addMore = !S.settings.addMore; await saveRaw(); render(); },
  toggleAlerts: () => { ui.allAlerts = !ui.allAlerts; render(); },
  toggleNum: async () => { S.settings.numStyle = S.settings.numStyle === 'intl' ? 'lakh' : 'intl'; await saveRaw(); render(); },
  pickSwatch: el => { $('#sColor').value = el.dataset.c; $$('#sheet .swatch').forEach(b => b.classList.toggle('on', b === el)); },
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
  wNext: () => {
    readWiz();
    if (wiz.step === 2) {
      const bad = wiz.accounts.find(a => (a.name || '').trim() && String(a.bal || '').trim() !== '' && isNaN(evalAmount(a.bal)));
      if (bad) { toast(`"${bad.bal}" is not a valid amount for ${bad.name}`); return; }
      if (!wiz.accounts.some(a => (a.name || '').trim())) { toast('Keep at least one account, e.g. Cash'); return; }
    }
    wiz.step = Math.min(4, wiz.step + 1); render(); window.scrollTo(0, 0);
  },
  wBack: () => { readWiz(); wiz.step = Math.max(1, wiz.step - 1); render(); },
  wAddAcc: () => { readWiz(); wiz.accounts.push({ id: '', name: '', bal: '' }); render(); const ins = $$('[data-wa="name"]'); ins[ins.length - 1]?.focus(); },
  wDelAcc: el => { readWiz(); wiz.accounts.splice(+el.dataset.i, 1); render(); },
  wToggleBook: el => { const b = wiz.books[+el.dataset.i]; b.on = !b.on; render(); },
  wAddBook: () => { const n = ($('#wNewBook').value || '').trim(); if (!n) return; wiz.books.push({ id: '', name: n, on: true }); render(); },
  wFinish: el => finishWelcome(!!el.dataset.connect),
  wRestore: async () => { S.settings.onboarded = true; wiz = null; await saveRaw(); setTab('more'); go('backup'); },
  wSkip: async () => { S.settings.onboarded = true; wiz = null; await save(); setTab('home'); },
  wSample: async () => { S = sampleState(); await DB.clear('img'); await saveRaw(); wiz = null; resetForm(); setTab('home'); toast('Sample data loaded. Tap around!'); },
  clearSample: async () => {
    if (!(await confirmBox('Start fresh', 'Remove all sample data and set up with your own accounts?', 'Start fresh'))) return;
    const keep = { googleClientId: S.settings.googleClientId, numStyle: S.settings.numStyle };
    S = defaultState(); Object.assign(S.settings, keep);
    await DB.clear('img'); for (const k in imgCache) delete imgCache[k];
    await saveRaw(); wiz = null; resetForm(); render(); window.scrollTo(0, 0);
  },
  resetSample: async () => { S = sampleState(); await DB.clear('img'); await saveRaw(); resetForm(); toast('Sample data reset'); setTab('home'); },
  addBill: () => openFormWith({ type: 'expected', direction: 'out', repeat: 'monthly', accountId: '', billOnly: true }),
  insMove: el => { if (el.disabled) return; insMonth = shiftYm(insMonth || today().slice(0, 7), Number(el.dataset.n)); if (insMonth > today().slice(0, 7)) insMonth = today().slice(0, 7); render(); },
  insCat: el => {
    const ym = insMonth || today().slice(0, 7);
    ui.entryFilter = { month: ym, type: '', book: '', person: '', work: '', q: '', drafts: false, spentOnly: true, cat: el.dataset.c };
    go('entries');
  },
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
    const pre = { type: x.direction === 'out' ? 'expense' : 'income', amount: String(xi.rem), categoryId: x.categoryId || '', bookId: x.bookId || S.settings.last.bookId || '', note: x.note || '', linkExpected: x.id };
    if (x.accountId && acc(x.accountId)) { pre.paidFrom = 'a:' + x.accountId; pre.accountId = x.accountId; }
    openFormWith(pre);
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
    if (k === 'bookId') form.bookTouched = true;
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
  if (!d.connected || !d.auto || !driveClientId() || !S.settings.driveDirty || S.settings.sample) return;
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
