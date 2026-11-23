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
  const cur = (typeof S !== 'undefined' && S && S.settings && S.settings.currency) || 'Rs';
  return (v < 0 ? '-' : (sign && v > 0 ? '+' : '')) + cur + ' ' + s;
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

let undoSnap = null;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (undo ? '<button class="tundo" data-act="undoSave">Undo</button>' : '');
  undoSnap = undo || null;
  t.classList.toggle('act', !!undo);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove('show'); undoSnap = null; }, undo ? 5000 : 2600);
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
    budgets: { total: 0, cat: {}, book: {} },
    settings: { pinHash: '', pinSalt: '', lastBackup: null, alertDays: 60, lockAfter: 60, last: {}, googleClientId: '', driveDirty: false, drive: defaultDrive(), onboarded: false, sample: false, numStyle: 'lakh', areaByCat: {}, theme: 'system', textSize: 1, currency: 'Rs' }
  };
}
function defaultDrive() {
  return { connected: false, auto: true, email: '', folderId: '', imgFolderId: '', lastBackup: null, lastFile: null, imgs: {}, needsReconnect: false, lastAttempt: 0 };
}

function normalizeState(st) {
  const d = defaultState();
  const out = { ...d, ...st };
  for (const k of ['accounts', 'books', 'categories', 'people', 'works', 'entries', 'templates']) if (!Array.isArray(out[k])) out[k] = d[k];
  out.budgets = { total: 0, cat: {}, book: {}, ...(st.budgets || {}) };
  out.settings = { ...d.settings, ...(st.settings || {}) };
  if (!st.settings || st.settings.onboarded === undefined) out.settings.onboarded = true; // existing users skip the welcome
  if (!out.settings.last) out.settings.last = {};
  if (!Array.isArray(out.trash)) out.trash = [];
  out.categories.forEach((c, i) => { if (!c.color) c.color = PALETTE[i % PALETTE.length]; });
  if (!out.settings.colorFix41) { // categories created before v41 all got the same colour
    const seen = new Set(); let k = 0;
    out.categories.filter(c => !c.bill).forEach(c => { if (seen.has(c.color)) { let tries = 0; while (seen.has(PALETTE[k % PALETTE.length]) && tries++ < PALETTE.length) k++; c.color = PALETTE[k % PALETTE.length]; k++; } seen.add(c.color); });
    out.settings.colorFix41 = true;
  }
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
  if (!Array.isArray(S.trash)) S.trash = [];
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString(), gone = S.trash.filter(x => x.deletedAt < cutoff);
  if (gone.length) { for (const x of gone) if (x.receipt) { try { await DB.del('img', x.receipt); } catch (e) { /* ignore */ } } S.trash = S.trash.filter(x => x.deletedAt >= cutoff); await saveRaw(); }
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
  const brother = { id: uid(), name: 'Brother (sample)', kind: 'family', phone: '' };
  st.people.push(office, staff, friend, brother);
  const work = { id: uid(), name: 'Office repair (sample)', ref: 'EST-01', closed: false };
  st.works.push(work);
  const E = (o) => st.entries.push({ id: uid(), createdAt: new Date().toISOString(), history: [], note: '', ...o });
  E({ type: 'expense', amount: 4500, date: d(-2), accountId: A('Cash'), bookId: B('Car'), categoryId: C('Fuel'), note: 'Fuel' });
  E({ type: 'expense', amount: 12800, date: d(-6), accountId: A('Bank'), bookId: B('Home'), categoryId: C('Food & grocery'), note: 'Monthly grocery' });
  E({ type: 'expense', amount: 6500, date: d(-4), accountId: A('Bank'), bookId: B('Home'), categoryId: C('Education'), note: 'School fee', spentOn: brother.id });
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
  st.budgets = { total: 40000, cat: { [C('Food & grocery')]: 12000, [C('Fuel')]: 8000 }, book: { [B('Car')]: 10000 } };
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
  repaid:      { label: 'I paid back',   hint: 'I returned money to a person', f: ['person*', 'account', 'note'] },
  advance:     { label: 'Given to spend',     hint: 'Given to someone to spend for you; they report spending later', f: ['person*', 'account', 'work', 'note'] },
  transfer:    { label: 'Transfer',    hint: 'Move money between my accounts', f: ['account', 'toAccount', 'note'] },
  expected:    { label: 'Upcoming',    hint: 'Money due in future: TA, arrears, payouts, bills', f: ['book', 'catAny', 'personOpt', 'repeat', 'note'], dateLabel: 'Due on' }
};
const TYPE_ORDER = ['expense', 'recoverable', 'income', 'lent', 'borrowed', 'received', 'repaid', 'advance', 'transfer', 'expected'];
const SYS_LABEL = { recovery: 'Paid back to me', adjustment: 'Balance adjustment' };
const typeLabel = t => (TYPES[t] ? TYPES[t].label : SYS_LABEL[t] || t);
const PERSON_KINDS = { family: 'Family / relative', friend: 'Friend', staff: 'Staff / helper (spends for me)', org: 'Office / company (pays me back)', other: 'Other' };
const KIND_HINT = {
  family: 'Parents, brothers, sisters, relatives. Money you spend on them is usually not paid back.',
  friend: 'Friends and colleagues. Money with them is usually a loan that comes back.',
  staff: 'Someone you hand cash to so they buy things or pay for work for you, e.g. a driver, helper or site supervisor. They bring back bills or the change.',
  org: 'Your office, employer or a company. What you spend on their work is paid back to you later.',
  other: 'Anyone else, for example a shop or a landlord.'
};

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
      case 'repaid': if (e.personId === pid) push(e.date, e, 'You paid back', a); break;
      case 'borrowed': if (e.personId === pid) push(e.date, e, 'They lent you', -a); break;
      case 'received': if (e.personId === pid) push(e.date, e, 'They paid back', -a); break;
      case 'expense': if (e.viaPersonId === pid) push(e.date, e, 'They paid for you', -a); break;
      case 'recoverable':
        if (e.viaPersonId === pid) push(e.date, e, 'They paid for you', -a);
        if (e.personId === pid) {
          push(e.date, e, 'You paid for them', a);
          if (e.writtenOff) push(e.writtenOff.date, e, 'Written off', -e.writtenOff.amount);
        }
        break;
      case 'recovery':
        for (const al of e.allocations || []) {
          const r = recById[al.id];
          if (r && r.personId === pid) push(e.date, e, 'Paid back: ' + entryTitle(r), -al.amount);
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
  if (p && e.type === 'recoverable') return (e.claim ? 'Claim' : 'To get back') + ' · ' + p.name;
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
  if (e.type === 'expense' && person(e.spentOn)) parts.push('for ' + person(e.spentOn).name);
  const vp = person(e.viaPersonId); if (vp) parts.push(vp.kind === 'staff' ? 'from ' + vp.name + "'s advance" : 'paid by ' + vp.name);
  const w = work(e.workId); if (w) parts.push(w.name);
  if (e.accountId && !e.viaPersonId && e.type !== 'transfer') { const a = acc(e.accountId); if (a) parts.push(a.name); }
  if (e.oldEntry) parts.push('before app');
  return parts.join(' · ');
}
const STATUS_LBL = { pending: 'not back yet', partial: 'part back', recovered: 'paid back', 'written-off': 'written off' };
const TYPE_ICO = { lent: '↗', advance: '↗', repaid: '↗', received: '↙', borrowed: '↙', transfer: '⇄', recovery: '↩', adjustment: '=', income: '+', expense: '•', recoverable: '↻', expected: '◷' };
const ICON_PATHS = {
  pie: 'M21 12A9 9 0 1 1 12 3v9zM15 3.5A9 9 0 0 1 20.5 9H15z',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z',
  grid: 'M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z',
  tag: 'M3 12.2V4.5A1.5 1.5 0 0 1 4.5 3h7.7l8.8 8.8-9.2 9.2zM7.5 7.5h.01',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15l1.6 1-2 3.4-1.8-.7a7 7 0 0 1-2.2 1.3l-.3 1.9h-4l-.3-1.9a7 7 0 0 1-2.2-1.3l-1.8.7-2-3.4 1.5-1.2a7 7 0 0 1 0-2.6L3 11.8l2-3.4 1.8.7A7 7 0 0 1 9 7.8l.3-1.9h4l.3 1.9a7 7 0 0 1 2.2 1.3l1.8-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 2.6z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.4-2.7 3.8M12 17h.01',
  zap: 'M13 3 4 14h7l-1 7 9-11h-7z',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  basket: 'M5 10h14l-1.6 9H6.6z M8.5 10L12 4.5 15.5 10',
  fork: 'M7 3v18 M4.5 3v5a2.5 2.5 0 0 0 5 0V3 M17 21V3c-2.2 1.2-3.5 4-3.5 7.5H17',
  fuel: 'M4 21V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v16 M3 21h11 M6.5 8h4 M13 9h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  flame: 'M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 .5 2 1.5 3 2.5 3 0-3-1-5 0-8z',
  drop: 'M12 3.5l5.2 7.6a6.3 6.3 0 1 1-10.4 0z',
  wifi: 'M2 8.5a15 15 0 0 1 20 0 M5 12a10 10 0 0 1 14 0 M8.5 15.5a5 5 0 0 1 7 0 M12 19h.01',
  phone: 'M8 3h8v18H8z M11 18h2',
  tv: 'M3 6h18v12H3z M8 21h8',
  car: 'M4 16l1.5-6.5A2 2 0 0 1 7.4 8h9.2a2 2 0 0 1 1.9 1.5L20 16 M3 16h18v3H3z M7 19v2 M17 19v2',
  heart: 'M12 20s-7-4.4-7-9.8A4 4 0 0 1 12 7.6a4 4 0 0 1 7 2.6C19 15.6 12 20 12 20z',
  bag: 'M6 8h12l-1 12H7z M9 8V6.5a3 3 0 0 1 6 0V8',
  scale: 'M12 4v16 M8 20h8 M5 7h14 M5 7l-2.5 6a2.5 2.5 0 0 0 5 0z M19 7l-2.5 6a2.5 2.5 0 0 0 5 0z',
  book: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z M5 19.5A1.5 1.5 0 0 0 6.5 21H19',
  wallet: 'M3 7.5h16a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 7.5L15 3.5v4 M16.5 13.75h1.5',
  brief: 'M3 8h18v11H3z M9 8V5h6v3 M3 13h18',
  house: 'M3 11l9-7 9 7 M5.5 9.5V20h13V9.5',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7 M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6 M16 4.5a3.2 3.2 0 0 1 0 6.2 M18 14c2.2.5 3.5 2.4 3.5 5',
  plus: 'M12 5v14 M5 12h14',
  cloud: 'M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-.5 9.5z',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  lock: 'M6 11h12v10H6z M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  swap: 'M4 8h15l-3.5-3.5 M20 16H5l3.5 3.5',
  cal: 'M4 5h16v15H4z M4 10h16 M8 3v4 M16 3v4',
  back: 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4z M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7'
};
const svgIcon = k => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON_PATHS[k] || ICON_PATHS.receipt}"/></svg>`;
const CAT_ICON_RULES = [[/insur/, 'shield'], [/committee|\bbc\b|bisi/, 'users'], [/grocer|food|ration|kiryana/, 'basket'], [/restaurant|dinner|lunch|meal|tea|hotel|eat/, 'fork'], [/fuel|petrol|diesel|cng/, 'fuel'], [/repair|mainten|mechanic/, 'wrench'], [/electric|utilit|bijli|wapda|lesco|fesco|mepco/, 'bolt'], [/\bgas\b|sui/, 'flame'], [/water/, 'drop'], [/internet|wifi|broadband/, 'wifi'], [/mobile|phone|package/, 'phone'], [/subscri|netflix|youtube|spotify|\btv\b|cable/, 'tv'], [/transport|travel|car|taxi|bus|toll/, 'car'], [/medic|doctor|health|pharm|hospital/, 'heart'], [/shop|cloth/, 'bag'], [/court|legal|lawyer/, 'scale'], [/educat|school|tuition|book|college/, 'book'], [/salary|income|wage|pension|profit/, 'wallet'], [/\bta\b|allowance|office/, 'brief'], [/rent|home|house|decor|furnit|organi/, 'house'], [/milk|dairy/, 'basket'], [/wedding|gift|party|event|eid/, 'users'], [/donat|masjid|mosque|infaq|zakat|sadq|charit/, 'heart'], [/material|cement|brick|sand|steel/, 'wrench'], [/labou?r|mason|worker/, 'brief']];
function catIcon(name) { const n = String(name || '').toLowerCase(); const r = CAT_ICON_RULES.find(([re]) => re.test(n)); return r ? r[1] : 'receipt'; }
const TYPE_SVG = { transfer: 'swap', income: 'wallet', expected: 'cal', recovery: 'back', recoverable: 'receipt', expense: 'receipt', adjustment: 'receipt' };
function entryIcon(e) {
  if (e.type === 'expected' && e.note && catIcon(e.note) !== 'receipt') return `<span class="ico sq">${svgIcon(catIcon(e.note))}</span>`;
  const c = cat(e.categoryId);
  if (c) return `<span class="ico sq">${svgIcon(catIcon(c.name))}</span>`;
  const p = person(e.personId) || person(e.viaPersonId);
  if (p && ['lent', 'advance', 'repaid', 'received', 'borrowed', 'recovery'].includes(e.type)) return personAvatar(p);
  return `<span class="ico sq">${svgIcon(TYPE_SVG[e.type] || 'receipt')}</span>`;
}
function personAvatar(p) { return `<span class="ico av" aria-hidden="true">${esc(p.name.trim()[0] || '?').toUpperCase()}</span>`; }
function entryItem(e, opts = {}) {
  const fl = opts.owed ? 'in' : entryFlow(e);
  const amt = e.type === 'adjustment' ? e.amount : e.amount;
  const sign = opts.owed ? '' : fl === 'in' ? '+' : fl === 'out' ? '-' : '';
  let extra = '';
  if (e.type === 'recoverable') { const ri = recInfo(e); extra = `<div class="li-sub st"><span class="badge ${ri.status}">${STATUS_LBL[ri.status] || ri.status}</span></div>`; }
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
let reuseHist = false, ignorePop = false;
function pushHist() { if (reuseHist) { reuseHist = false; return; } history.pushState({ h: 1 }, ''); navDepth++; }
function dropHist() { ignorePop = true; history.back(); }
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
  if (menuOpen) { closeMenu('tap'); return; }
  if (stack.length) stepBack();
  else if (cur.v !== 'home') setTab('home');
}
window.addEventListener('popstate', () => {
  navDepth = Math.max(0, navDepth - 1);
  if (ignorePop) { ignorePop = false; return; }
  if (menuOpen) { closeMenu('pop'); return; }
  if (sheetOpen) { closeSheet(); pushHist(); return; }
  if (!$('#lock').hidden) { pushHist(); return; }
  if (stack.length) stepBack();
  else if (cur.v !== 'home' && S.settings.onboarded) { tab = 'home'; cur = { v: 'home', p: null }; render(); window.scrollTo(0, 0); }
});

const TITLES = {
  welcome: 'Hisaab',
  home: 'Hisaab', people: 'People', add: 'Add entry', pending: 'To get back', more: 'More',
  person: 'Person', accounts: 'Accounts', books: 'Areas', cats: 'Categories', works: 'Projects', work: 'Project', workmore: 'Breakdown', trash: 'Recently deleted', account: 'Account',
  templates: 'Quick templates', prefs: 'Preferences', budgets: 'Budgets', bills: 'Bills', insights: 'Insights', entries: 'All entries', backup: 'Backup & restore', security: 'App lock', help: 'How to use Hisaab', datacheck: 'Check your data'
};

const THEME_LBL = { system: 'Same as phone', light: 'Light', dark: 'Dark' };
const TEXT_SIZES = [[0.9, 'Small'], [1, 'Normal'], [1.12, 'Large'], [1.25, 'Extra large']];
const CURRENCIES = ['Rs', 'PKR', '₨', '$', 'AED', 'SAR', '£', '€'];
function applyPrefs() {
  const st = S.settings, root = document.documentElement;
  if (st.theme === 'light' || st.theme === 'dark') root.dataset.theme = st.theme; else delete root.dataset.theme;
  const z = Number(st.textSize) || 1;
  document.body.style.zoom = z === 1 ? '' : String(z);
  const dark = st.theme === 'dark' || (st.theme !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', dark ? '#121417' : '#ffffff');
}
function render() {
  applyPrefs();
  const onb = !S.settings.onboarded;
  document.body.classList.toggle('onboarding', onb);
  if (onb) { tab = 'home'; stack = []; cur = { v: 'welcome', p: null }; }
  else if (cur.v === 'welcome') cur = { v: 'home', p: null };
  $$('.nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#backBtn').hidden = stack.length === 0;
  let title = TITLES[cur.v] || 'Hisaab';
  if (cur.v === 'person') title = '';
  if (cur.v === 'pending') title = 'Not linked to a person';
  if (cur.v === 'work' || cur.v === 'account') title = '';
  if (cur.v === 'bill') { const b = billSeries(cur.p).at(-1); title = b ? entryTitle(b) : 'Bill'; }
  if (cur.v === 'add' && form.editingId) title = form.draftId ? 'Complete entry' : 'Edit entry';
  if (cur.v === 'add' && form.type === 'expected' && form.direction === 'out') title = form.editingId ? 'Edit bill' : 'Add bill';
  if (cur.v === 'add' && form.kind === 'person' && !form.viaFor && person(form.personId)) title = person(form.personId).name;
  $('#title').textContent = title;
  const rootTab = !stack.length && ['home', 'people', 'bills', 'insights', 'more'].includes(cur.v);
  const addNew = cur.v === 'add' && addMode() !== 'legacy';
  document.body.classList.toggle('roottab', rootTab);
  document.body.classList.toggle('nohead', rootTab || addNew);
  document.body.classList.toggle('addmode', addNew);
  const fn = VIEWS[cur.v] || VIEWS.home;
  $('#view').innerHTML = fn(cur.p);
  if (cur.v === 'add') { afterAddRender(); fitAmount(); }
  saveNav();
}
// Remember where you are, so pulling down to refresh keeps you on the same screen.
const NAV_KEEP = ['workmore', 'account', 'trash', 'home', 'people', 'bills', 'insights', 'entries', 'person', 'work', 'works', 'bill', 'budgets', 'accounts', 'books', 'cats', 'prefs', 'backup', 'help', 'pending', 'templates', 'security'];
function saveNav() {
  try {
    if (!S.settings.onboarded || !NAV_KEEP.includes(cur.v)) { sessionStorage.removeItem('hisaab_nav'); return; }
    sessionStorage.setItem('hisaab_nav', JSON.stringify({ tab, v: cur.v, p: cur.p, insMonth, insTab: ui.insTab || '', ef: cur.v === 'entries' ? ui.entryFilter : null, t: Date.now() }));
  } catch (e) { /* ignore */ }
}
function restoreNav() {
  try {
    const n = JSON.parse(sessionStorage.getItem('hisaab_nav') || 'null');
    if (!n || !S.settings.onboarded || !NAV_KEEP.includes(n.v) || Date.now() - n.t > 12 * 3600e3) return;
    if (n.v === 'person' && !person(n.p)) return;
    if ((n.v === 'work' || n.v === 'workmore') && !work(n.p)) return;
    if (n.v === 'bill' && !billSeries(n.p).length) return;
    tab = ['home', 'people', 'bills', 'insights'].includes(n.tab) ? n.tab : 'home';
    insMonth = n.insMonth || null; if (n.insTab) ui.insTab = n.insTab;
    if (n.ef) ui.entryFilter = n.ef;
    cur = { v: n.v, p: n.p };
    stack = n.v === tab ? [] : [{ v: tab, p: null, tab, y: 0 }];
    if (stack.length) pushHist();
  } catch (e) { /* ignore */ }
}

// ---------------- Views ----------------
const VIEWS = {};

function weekStart(d) { const [y, m, dd] = d.split('-').map(Number); const wd = (new Date(y, m - 1, dd).getDay() + 6) % 7; return addDays(d, -wd); }
function periodOf(P) {
  const t = today();
  if (P.k === 'week') {
    const cs = weekStart(t), from = P.start, to = addDays(from, 6), isCurrent = from === cs;
    const label = isCurrent ? 'This week' : from === addDays(cs, -7) ? 'Last week' : `${fmtShort(from)} – ${fmtShort(to)}`;
    const pf = addDays(from, -7);
    return { from, to, label, isCurrent, prev: { from: pf, to: isCurrent ? addDays(pf, daysBetween(from, t)) : addDays(pf, 6), label: isCurrent ? 'last week' : 'the week before' } };
  }
  if (P.k === 'custom') return { from: P.from, to: P.to, label: `${fmtShort(P.from)} – ${fmtShort(P.to)}`, custom: true };
  const cy = t.slice(0, 7), ym = P.ym, isCurrent = ym === cy, pym = shiftYm(ym, -1);
  const label = isCurrent ? 'This month' : ym === shiftYm(cy, -1) ? 'Last month' : monthLabel(ym);
  return { from: ym + '-01', to: ym + '-31', label, isCurrent, prev: { from: pym + '-01', to: isCurrent ? pym + '-' + t.slice(8, 10) : pym + '-31', label: isCurrent ? 'last month' : monthLabel(pym) } };
}
function insYm() { const P = curPeriod(), t = today(); if (P.k === 'month') return P.ym; const to = periodOf(P).to; return (to > t ? t : to).slice(0, 7); }
function daysInMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); }
function budgetRows(ym) {
  const B = S.budgets || { total: 0, cat: {}, book: {} }, sp = spendMonth(ym), t = today();
  const dim = daysInMonth(ym), frac = ym < t.slice(0, 7) ? 1 : ym > t.slice(0, 7) ? 0 : Number(t.slice(8, 10)) / dim;
  const mk = (k, id, label, spent, budget) => { const pct = budget ? spent / budget : 0; return { k, id, label, spent: r2(spent), budget, pct, left: r2(budget - spent), state: pct > 1 ? 'over' : pct >= 0.9 ? 'near' : pct > frac + 0.1 ? 'fast' : 'ok' }; };
  const rows = [];
  if (B.total > 0) rows.push(mk('total', '', 'All spending', sp.total, B.total));
  for (const [id, v] of Object.entries(B.cat || {})) if (v > 0 && cat(id)) rows.push(mk('cat', id, cat(id).name, sp.byCat[id] || 0, v));
  for (const [id, v] of Object.entries(B.book || {})) if (v > 0 && book(id)) rows.push(mk('book', id, book(id).name, sp.byBook[id] || 0, v));
  return { rows, frac, dim };
}
function streakHtml() {
  const sk = streakInfo(), t = today(), WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  return `<div class="streak">
    <div class="st-head">${svgIcon('flame')}<b>${sk.n ? sk.n + '-day streak' : 'No streak yet'}</b><span>${sk.todayOk ? 'Today is done' : sk.n ? 'Add today to keep it going' : 'Add today to start one'}</span></div>
    <div class="st-days">${sk.last7.map(x => { const dt = new Date(x.d + 'T00:00:00'); return `<button class="sd ${x.ok ? 'ok' : ''} ${x.d === t ? 'today' : ''}" data-act="streakDay" data-d="${x.d}" aria-label="${fmtDate(x.d)}${x.ok ? '' : ', nothing recorded'}"><small>${WD[dt.getDay()]}</small><i></i></button>`; }).join('')}</div>
    ${!sk.todayOk ? `<button class="btn block" data-act="noSpend" data-d="${t}">Nothing spent today</button>` : sk.missed ? `<div class="muted small">${sk.missed} day${sk.missed > 1 ? 's' : ''} missed this week. Tap a hollow dot to fill it.</div>` : '<div class="muted small">All days this week are recorded.</div>'}
  </div>
  <p class="muted small mt">A day counts when you add any entry for it, or mark that nothing was spent.</p>`;
}
function coveredDays() {
  const c = new Set();
  for (const e of live()) if (!e.draft && e.type !== 'expected') c.add(e.date);
  for (const d of (S.settings.noSpend || [])) c.add(d);
  return c;
}
function streakInfo() {
  const c = coveredDays(), t = today();
  let d = c.has(t) ? t : addDays(t, -1), n = 0;
  while (c.has(d)) { n++; d = addDays(d, -1); }
  const last7 = [6, 5, 4, 3, 2, 1, 0].map(i => { const x = addDays(t, -i); return { d: x, ok: c.has(x) }; });
  return { n, todayOk: c.has(t), last7, missed: last7.filter(x => !x.ok && x.d !== t).length };
}
function addAgainList() {
  const since = addDays(today(), -120), groups = {};
  for (const e of live()) {
    if (e.type !== 'expense' || e.draft || e.linkExpected || e.date < since) continue;
    const label = (e.note || cat(e.categoryId)?.name || '').trim(); if (!label) continue;
    const k = (e.categoryId || '') + '|' + label.toLowerCase();
    const g = groups[k] || (groups[k] = { n: 0, last: null, label });
    g.n++; if (!g.last || e.date > g.last.date || (e.date === g.last.date && (e.createdAt || '') > (g.last.createdAt || ''))) g.last = e;
  }
  return Object.values(groups).filter(g => g.n >= 2).sort((a, b) => b.n - a.n || (a.last.date < b.last.date ? 1 : -1)).slice(0, 4).map(g => {
    const e = g.last;
    return { label: g.label, amount: e.amount, d: { amount: String(e.amount), categoryId: e.categoryId || '', bookId: e.bookId || '', note: e.note || '', paidFrom: e.viaPersonId ? 'p:' + e.viaPersonId : e.accountId ? 'a:' + e.accountId : '', recoverFrom: e.spentOn || '' } };
  });
}
function curPeriod() { return ui.period || (ui.period = { k: 'month', ym: today().slice(0, 7) }); }
function incomeIn(from, to) { return r2(live().filter(e => e.type === 'income' && e.date >= from && e.date <= to).reduce((a, e) => a + e.amount, 0)); }
VIEWS.home = () => {
  const s = summary();
  const t = today();
  const am = allocMap();
  const alerts = [];
  { const dc = dataChecks(); if (dc.length) alerts.push(`<button class="alert" data-act="go" data-v="datacheck"><span class="grow"><b>Check your data</b> · ${dc.length} thing${dc.length > 1 ? 's' : ''} make${dc.length > 1 ? '' : 's'} your totals wrong</span>›</button>`); }
  const old = live().filter(e => e.type === 'recoverable' && recInfo(e, am).remaining > 0 && daysBetween(e.date, t) > S.settings.alertDays);
  if (old.length) alerts.push(`<button class="alert" data-act="goPending" data-seg="rec"><span class="grow"><b>${money(old.reduce((a, e) => a + recInfo(e, am).remaining, 0))} to get back</b> · over ${S.settings.alertDays} days old</span>›</button>`);
  const od = live().filter(e => e.type === 'expected' && !expectedInfo(e).closed && e.date < t);
  const soon = live().filter(e => e.type === 'expected' && e.direction === 'out' && !expectedInfo(e).closed && e.date >= t && e.date <= addDays(t, 3));
  if (soon.length) alerts.push(`<button class="alert info" data-act="jump" data-tab="bills"><span class="grow"><b>${soon.length} bill${soon.length > 1 ? 's' : ''} due soon</b> · ${money(soon.reduce((a, e) => a + expectedInfo(e).rem, 0))}</span>›</button>`);
  if (od.length) alerts.push(`<button class="alert" data-act="goPending" data-seg="exp"><span class="grow"><b>${od.length} payment${od.length > 1 ? 's' : ''} overdue</b></span>›</button>`);
  const drafts = S.entries.filter(e => e.draft);
  const pbAll = personBalances();
  const dueP = S.people.filter(p => p.dueDate && pbAll[p.id] && p.dueDate <= t).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  if (dueP.length === 1) { const p = dueP[0], b = pbAll[p.id]; alerts.push(`<button class="alert" data-act="go" data-v="person" data-p="${p.id}"><span class="grow"><b>${esc(p.name)}</b> · ${b > 0 ? money(b) + ' was promised to you' : 'you promised to pay ' + money(-b)} by ${fmtShort(p.dueDate)}</span>›</button>`); }
  else if (dueP.length > 1) alerts.push(`<button class="alert" data-act="jump" data-tab="people"><span class="grow"><b>${dueP.length} people</b> past a promised payment date</span>›</button>`);
  const bud = budgetRows(t.slice(0, 7)).rows.filter(r => r.state === 'over' || r.state === 'near').sort((a, b) => b.pct - a.pct);
  if (bud.length) { const r = bud[0]; alerts.push(`<button class="alert" data-act="go" data-v="budgets"><span class="grow"><b>${esc(r.label)} ${r.state === 'over' ? 'over budget' : 'budget ' + Math.round(r.pct * 100) + '% used'}</b> · ${r.state === 'over' ? money(-r.left) + ' over' : money(r.left) + ' left'}${bud.length > 1 ? ` · +${bud.length - 1} more` : ''}</span>›</button>`); }
  if (drafts.length) alerts.push(`<button class="alert info" data-act="goEntries" data-filter="draft"><span class="grow"><b>${drafts.length} incomplete</b> receipt${drafts.length > 1 ? 's' : ''} to fill in</span>›</button>`);
  const dv = S.settings.drive;
  const dLast = dv.lastBackup ? dv.lastBackup.slice(0, 10) : '';
  if (dv.connected && dv.needsReconnect) {
    alerts.unshift(`<button class="alert" data-act="driveReconnect"><span class="grow"><b>Google Drive backup paused</b> · tap to reconnect</span>›</button>`);
  } else if (dv.connected && S.settings.driveDirty && !S.settings.sample && (!dLast || daysBetween(dLast, t) >= 1)) {
    alerts.unshift(`<button class="alert" data-act="driveNow"><span class="grow"><b>Changes not backed up</b> · ${dLast ? 'last backup ' + fmtShort(dLast) : 'not backed up yet'} · tap to back up now</span>›</button>`);
  } else {
    const lb = latestBackup();
    if (live().length >= 5 && (!lb || daysBetween(lb.slice(0, 10), t) > 7)) alerts.push(`<button class="alert" data-act="go" data-v="backup"><span class="grow"><b>Backup due</b> · ${lb ? 'last ' + fmtDate(lb.slice(0, 10)) : 'never backed up'}${dv.connected ? '' : ' · set up auto backup'}</span>›</button>`);
  }
  if (!live().length && S.accounts.every(a => !Number(a.opening))) alerts.push(`<button class="alert info" data-act="go" data-v="accounts"><span class="grow"><b>Start here:</b> enter how much is in your cash and bank today</span>›</button>`);

  const recent = [...S.entries].filter(e => !e.draft && e.type !== 'expected').sort(sortDesc).slice(0, 8);
  const shownAlerts = ui.allAlerts ? alerts : alerts.slice(0, 2);
  const prevSpent = spendMonth(shiftYm(t.slice(0, 7), -1)).total;
  const P = curPeriod(), per = periodOf(P);
  const sp = ownSpending(per.from, per.to), inc = incomeIn(per.from, per.to);
  let cmp = '';
  if (per.prev) {
    const pv = ownSpending(per.prev.from, per.prev.to).total, d = r2(sp.total - pv);
    if (pv && sp.total) cmp = d === 0 ? `Same as ${per.prev.label}` : `${money(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than ${per.prev.label}${per.isCurrent ? ' by this date' : ''}`;
  }
  const areas = Object.entries(sp.byBook).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).slice(0, 4);
  const hasAny = live().length > 0;
  const sk0 = streakInfo();
  const homebar = `<div class="homebar">
    <button class="hb-btn" data-act="openMenu" aria-label="Menu">${svgIcon('menu')}</button>
    ${hasAny ? `<div class="period">
      ${P.k === 'custom' ? '' : '<button class="pstep" data-act="perStep" data-d="-1" aria-label="Previous period">‹</button>'}
      <button class="plabel" data-act="perPick">${per.label} <span aria-hidden="true">▾</span></button>
      ${P.k === 'custom' ? '' : `<button class="pstep" data-act="perStep" data-d="1" aria-label="Next period" ${per.isCurrent ? 'disabled' : ''}>›</button>`}
    </div>` : '<div class="hb-title">Hisaab</div>'}
    ${hasAny ? `<button class="hb-btn fire ${sk0.todayOk ? '' : 'pending'}" data-act="streakOpen" aria-label="${sk0.n}-day streak">${svgIcon('flame')}${sk0.n >= 2 ? `<b>${sk0.n}</b>` : ''}</button>` : '<span class="hb-btn"></span>'}
  </div>`;
  const hero = !hasAny ? `<div class="summary starter">
      <h2>Start with today's spending</h2>
      <p class="muted">Add anything you paid: fuel, grocery, a bill. It takes a few seconds.</p>
      <button class="btn primary block" data-act="tab" data-tab="add">+ Add expense</button>
      <button class="link mt" data-act="go" data-v="help">How to use Hisaab</button>
    </div>` : `
  <div class="summary">
    <button class="sum-main" data-act="goEntries" data-filter="spent">
      <span class="lbl">Spent</span>
      <span class="big">${money(sp.total)}</span>
      <span class="sub">${sp.total ? (cmp || 'Your own money. Loans and money you will get back are not counted.') : 'Nothing spent in this period'}</span>
    </button>
    ${areas.length || inc ? `<div class="kvs">
      ${areas.map(([id, v]) => `<button class="kv" data-act="goEntries" data-filter="spent" data-book="${id}"><span>${esc(bookName(id))}</span><b>${money(v)}</b></button>`).join('')}
      ${inc ? `<div class="kv inc"><span>Income</span><b class="in">${money(inc)}</b></div>` : ''}
    </div>` : ''}
    ${(() => { if (P.k !== 'month' || !(S.budgets && S.budgets.total > 0)) return ''; const r = budgetRows(P.ym).rows.find(x => x.k === 'total'); const fr = budgetRows(P.ym).frac;
      return `<button class="hbud ${r.state}" data-act="go" data-v="budgets"><div class="bar"><i style="width:${Math.min(100, r.pct * 100)}%"></i>${fr > 0 && fr < 1 ? `<em style="left:${fr * 100}%"></em>` : ''}</div><div class="hbud-sub"><span>${r.left >= 0 ? money(r.left) + ' left' : money(-r.left) + ' over budget'}</span><span>of ${money(r.budget)} budget</span></div></button>`; })()}
    <button class="link deep" data-act="openInsights">${P.k === 'month' ? 'See full breakdown' : `See ${monthLabel(insYm()).split(' ')[0]} breakdown`} ›</button>
  </div>`;
  return `${homebar}
  ${sampleBanner()}
  ${hero}
  ${alerts.length ? '<div class="sec-title">Needs attention</div>' : ''}
  ${shownAlerts.join('')}
  ${alerts.length > 2 ? `<button class="link small" style="margin:-2px 2px 8px" data-act="toggleAlerts">${ui.allAlerts ? 'Show less' : 'Show ' + (alerts.length - 2) + ' more'}</button>` : ''}

  ${hasAny ? `${(() => { const pins = S.templates, pinNames = new Set(pins.map(t => t.name.toLowerCase())), ag = addAgainList().filter(x => !pinNames.has(x.label.toLowerCase())).slice(0, Math.max(0, 6 - pins.length)); return `<div class="sec-title">Add again ${pins.length ? `<button data-act="pinEdit">${ui.pinEdit ? 'Done' : 'Edit'}</button>` : ''}</div>
  <div class="chips quickrow">
    ${pins.map(tp => ui.pinEdit ? `<button class="chip pin edit" data-act="unpin" data-id="${tp.id}" aria-label="Unpin ${esc(tp.name)}">${esc(tp.name)} <span aria-hidden="true">×</span></button>`
      : `<button class="chip pin" data-act="useTpl" data-id="${tp.id}">${svgIcon(catIcon(tp.name))}${esc(tp.name)}${tp.data.amount ? ` <span class="muted">${money(Number(tp.data.amount))}</span>` : ''}</button>`).join('')}
    ${ui.pinEdit ? '' : ag.map(x => `<button class="chip" data-act="addAgain" data-d='${esc(JSON.stringify(x.d))}'>${svgIcon(catIcon(x.label))}${esc(x.label)} <span class="muted">${money(x.amount)}</span></button>`).join('')}
  </div>
  ${!ag.length && !pins.length ? '<p class="muted small" style="margin:8px 2px 0">Things you enter often appear here for one-tap entry. To keep one here always, open it and tap <b>Pin</b>.</p>' : ''}`; })()}
  <div class="sec-title">Recent <button data-act="goEntries" data-filter="">See all ›</button></div>
  <div class="list">${recent.slice(0, 6).map(e => entryItem(e)).join('')}</div>` : ''}`;
};

function sampleBanner() {
  if (!S.settings.sample) return '';
  return PREVIEW
    ? `<div class="alert info note"><span class="grow"><b>Preview</b> with sample data. Changes stay in this browser only.</span><button class="link" data-act="resetSample">Reset</button></div>`
    : `<div class="alert info note"><span class="grow"><b>Sample data.</b> Look around freely, then start with your own.</span><button class="link" data-act="clearSample">Start fresh</button></div>`;
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
  return `<div class="agegrid">${buckets.map(b => `<div class="${b.v ? b.cls : ''}"><span>${b.label}</span><b>${money(b.v)}</b></div>`).join('')}</div>`;}

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

VIEWS.people = () => peopleList();
function peopleList() {
  const pb = personBalances(), LAST = {};
  live().forEach(e => { for (const id of [e.personId, e.spentOn, e.viaPersonId]) if (id && (!LAST[id] || e.date > LAST[id])) LAST[id] = e.date; });
  const q = ui.peopleQ.trim().toLowerCase();
  const pf = ui.peopleF || 'all';
  const list = S.people.filter(p => !q || p.name.toLowerCase().includes(q)).filter(p => pf === 'all' || (pf === 'owed' ? (pb[p.id] || 0) > 0 : (pb[p.id] || 0) < 0))
    .sort((a, b) => Math.abs(pb[b.id]) - Math.abs(pb[a.id]) || a.name.localeCompare(b.name));
  let owed = 0, owe = 0;
  Object.values(pb).forEach(v => { if (v > 0) owed = r2(owed + v); else owe = r2(owe - v); });
  const nOwed = S.people.filter(p => (pb[p.id] || 0) > 0).length, nOwe = S.people.filter(p => (pb[p.id] || 0) < 0).length;
  return `
  <div class="chips" style="margin-bottom:8px">${[['all', 'All', S.people.length], ['owed', 'Owe me', nOwed], ['owe', 'I owe', nOwe]].map(([k, l, n]) => `<button class="chip ${pf === k ? 'on' : ''}" data-act="peopleF" data-v="${k}">${l} (${n})</button>`).join('')}</div>
  ${pf === 'owed' ? (() => { const am = allocMap(), un = live().filter(e => e.type === 'recoverable' && !e.personId && recInfo(e, am).remaining > 0), unT = r2(un.reduce((a, e) => a + recInfo(e, am).remaining, 0));
    return `<div class="card owe-age"><div class="iv-h" style="margin:0 0 8px">How old <span>follow up the oldest first</span></div>${ageBarsHtml() || '<div class="muted small">Nothing waiting.</div>'}</div>${un.length ? `<button class="list-item card" data-act="openUnassigned"><div class="li-main"><div class="li-title">Not linked to a person</div><div class="li-sub">${un.length} item${un.length > 1 ? 's' : ''} you will get back</div></div><div class="li-amt in">${money(unT)}</div><span class="chev">›</span></button>` : ''}`; })() : ''}
  <div class="psum">${pf === 'owed' ? `${nOwed} ${nOwed === 1 ? 'person owes' : 'people owe'} you <b class="in">${money(owed)}</b>` : pf === 'owe' ? `You owe ${nOwe} ${nOwe === 1 ? 'person' : 'people'} <b class="${owe ? 'out' : ''}">${money(owe)}</b>` : `Owed to you <b class="in">${money(owed)}</b> · You owe <b class="${owe ? 'out' : ''}">${money(owe)}</b>`}</div>
  <div class="row" style="margin-bottom:10px">
    <input class="inp grow" placeholder="Search people" value="${esc(ui.peopleQ)}" data-ui="peopleQ">
    <button class="btn primary" data-act="editPerson">+ Person</button>
  </div>
  <div class="list">${list.length ? list.map(p => {
    const v = pb[p.id] || 0;
    const st = v > 0 ? `<span class="in">owes you</span>` : v < 0 ? `<span class="out">you owe</span>` : '<span class="muted">settled</span>';
    return `<button class="list-item" data-act="go" data-v="person" data-p="${p.id}">
      ${personAvatar(p)}
      <div class="li-main"><div class="li-title">${esc(p.name)}</div><div class="li-sub">${dueTag(p, v) || (LAST[p.id] ? 'Last entry ' + fmtShort(LAST[p.id]) : esc(PERSON_KINDS[p.kind] || ''))}</div></div>
      <div class="li-amt">${money(Math.abs(v))}<div class="li-sub">${st}</div></div><span class="chev" aria-hidden="true">›</span></button>`;
  }).join('') : `<div class="empty">${q ? 'No match.' : pf !== 'all' ? 'Nobody here.' : 'No people yet. Tap + Person to add family, a friend or your office, then record what you give or receive on their page.'}</div>`}</div>`;
}

VIEWS.person = (pid) => {
  const p = person(pid);
  if (!p) return '<div class="empty">Person not found.</div>';
  const bal = personBalances()[pid] || 0;
  const lines = personLines(pid);
  const am = allocMap();
  const openRec = live().filter(e => e.type === 'recoverable' && e.personId === pid && recInfo(e, am).remaining > 0);
  const shown = lines;
  const balTxt = bal > 0 ? `${esc(p.name)} owes you` : bal < 0 ? `You owe ${esc(p.name)}` : 'All settled';
  const monthName = ym => new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
  let lastYm = '';
  const hist = [...shown].reverse().map(l => {
    const ym = l.date.slice(0, 7);
    const head = ym !== lastYm ? `<div class="month">${monthName(ym)}</div>` : '';
    lastYm = ym;
    const c = cat(l.e.categoryId);
    const settle = ['repaid', 'received', 'recovery'].includes(l.e.type) || l.label === 'Written off';
    const what = l.label.startsWith('Paid back:') ? l.label : (l.e.note || (c && c.name) || l.label);
    const sub = [what !== l.label ? l.label : '', l.e.workId && work(l.e.workId) ? work(l.e.workId).name : ''].filter(Boolean).join(' · ');
    const d = new Date(l.date + 'T00:00:00');
    return `${head}<button class="hrow" data-act="openEntry" data-id="${l.e.id}">
      <span class="hdate"><small>${'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[d.getMonth()]}</small><b>${String(d.getDate()).padStart(2, '0')}</b></span>
      ${entryIcon(l.e)}
      <span class="li-main"><span class="li-title">${esc(what)}</span>${sub ? `<span class="li-sub">${esc(sub)}</span>` : ''}</span>
      <span class="hamt ${settle ? '' : l.v > 0 ? 'in' : 'out'}"><small>${l.label === 'Written off' ? 'written off' : settle ? 'paid back' : l.v > 0 ? 'you gave' : 'you got'}</small>${money(Math.abs(l.v))}</span>
    </button>`;
  }).join('');
  const balLine = bal > 0 ? `<span class="lbl">${esc(p.name)} owes you</span><b class="in">${money(bal)}</b>` : bal < 0 ? `<span class="lbl">You owe ${esc(p.name)}</span><b class="out">${money(-bal)}</b>` : `<span class="lbl">Balance</span><b>All settled</b>`;
  return `
  <div class="phero">
    ${personAvatar(p).replace('ico av', 'ico av lg')}
    <div class="grow"><h2>${esc(p.name)}</h2><div class="muted small">${esc(PERSON_KINDS[p.kind] || '')}${p.phone ? ' · ' + esc(p.phone) : ''}</div>
      <div class="hlinks"><button class="link" data-act="editPerson" data-id="${pid}">Edit</button>${lines.length ? `<span>·</span><button class="link" data-act="sharePerson" data-p="${pid}">Share</button>` : ''}${p.phone ? `<span>·</span><a class="link" href="tel:${esc(p.phone.replace(/[^+\d]/g, ''))}">Call</a>` : ''}</div></div>
  </div>
  <div class="pbal">${balLine}</div>
  ${(() => { const cs = claimSplit(pid); if (!cs.claims) return ''; const personal = r2(bal - cs.claims);
    return `<div class="psplit"><div><span>Official claims</span><b class="in">${money(cs.claims)}</b><small>${Object.entries(cs.by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${money(v)}`).join(' · ')}</small></div><div><span>Personal</span><b class="${personal > 0 ? 'in' : personal < 0 ? 'out' : ''}">${personal > 0 ? money(personal) : personal < 0 ? '−' + money(-personal) : 'settled'}</b><small>${personal > 0 ? 'owes you' : personal < 0 ? 'you owe' : 'loans &amp; other'}</small></div></div>`; })()}
  ${(() => { const ym = today().slice(0, 7), m = spentOnTotals(ym + '-01', ym + '-31')[pid] || 0, y = spentOnTotals(ym.slice(0, 4) + '-01-01', ym.slice(0, 4) + '-12-31')[pid] || 0;
    return y ? `<button class="spenton" data-act="spentOnList" data-p="${pid}" data-ym="${ym}"><span>Spent on ${esc(p.name)}</span><b>${money(m)}</b><span class="muted small">this month · ${money(y)} this year ›</span></button>` : ''; })()}
  ${dueTag(p, bal) ? `<div class="small muted" style="margin:-6px 0 10px">${dueTag(p, bal)} <button class="link small" data-act="editPerson" data-id="${pid}">change</button></div>` : ''}
  <div class="pills pfit">
    ${bal ? `<button class="pill primary" data-act="settleUp" data-p="${pid}">Settle up</button>` : ''}
    <button class="pill gave" data-act="personMoney" data-dir="out" data-p="${pid}"><span class="out">−</span> I gave / paid</button>
    <button class="pill got" data-act="personMoney" data-dir="in" data-p="${pid}"><span class="in">+</span> I received</button>
  </div>
  ${(() => { const oc = openRec.filter(isClaim), op = openRec.filter(e => !isClaim(e)), blk = (t, l) => l.length ? `<div class="sec-title">${t} <button data-act="recoverForPerson" data-p="${pid}">They paid back</button></div><div class="list">${l.sort(sortDesc).map(e => entryItem(e, { owed: true })).join('')}</div>` : '';
    return blk('Official claims to get back', oc) + blk(oc.length ? 'Personal: to get back' : 'To get back', op); })()}
  <div class="sec-title">History</div>
  <div class="list">${!lines.length ? `<div class="empty">${spentOnTotals('0000-01-01', '9999-12-31')[pid] ? `No loans or money to get back with ${esc(p.name)}. Spending on them is shown above.` : 'No entries with this person yet. Use <b>I gave</b> or <b>I received</b> above.'}</div>` : !shown.length ? '<div class="empty">Nothing here.</div>' : hist}</div>`;
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
  'out:me': 'Your own spending: grocery, fuel, bills. Counts in "Spent".',
  'out:me:for': 'Your own spending on {n}. Counts in "Spent" and shows in "Spent on people". {n} does not owe you.',
  'out:back:for': '{n} will pay you back. Not your spending: it shows on {n}\'s page under To get back.',
  'out:me:later': 'Not paid yet. Shows in Bills until you tap Pay.',
  'out:back': 'You paid on behalf of your office, company or a person, and they will repay you. Not your spending; listed under People → To get back.',
  'out:person': 'Money handed to someone: a loan, money to spend for you, or paying back what you owe them. The app works out which from their balance.',
  'in:income': 'Salary, TA, online income, anything you earn.',
  'in:income:later': 'Not received yet (TA claim, arrears, payout). Shows under People → To get back until you tap Receive.',
  'in:person': 'Someone returned your money, or lent you money.',
  'move:': 'Move money between your own accounts.'
};
// "For whom / From whom" + "What is this money?" (generic words, one place for every case)
const WHAT_OUT = { gone: ['Not coming back', 'A gift, a treat, or a fee you paid for them'], back: ['Coming back', 'They will return it, or the office will reimburse you'], spend: ['To spend for me', 'They buy something for you and give back the change'], repay: ['Paying back what I owe', ''] };
const WHAT_IN = { items: ['Paying back items', ''], paid: ['Paying me back', ''], lentme: ['Lending me', 'You will return it later'] };
function openItemsOf(pid) { const am = allocMap(); return live().filter(e => e.type === 'recoverable' && e.personId === pid && recInfo(e, am).remaining > 0); }
function holdsForMe(pid) { return live().some(e => e.type === 'advance' && e.personId === pid) && (personBalances()[pid] || 0) > 0; }
function defaultWhat(id, dir) {
  const p = person(id), b = personBalances()[id] || 0;
  if (dir === 'in') return openItemsOf(id).length ? 'items' : b > 0 ? 'paid' : 'lentme';
  if (b < 0) return 'repay';
  if (!p) return 'gone';
  return p.kind === 'family' ? 'gone' : p.kind === 'staff' ? 'spend' : 'back';
}
function applyWhat() {
  const f = form, id = f.forId || '';
  if (!id) { f.viaFor = false; f.forcedType = ''; f.recoverFrom = ''; if (['person', 'back'].includes(f.kind) || !f.kind) f.kind = f.dir === 'in' ? 'income' : 'me'; deriveType(); return; }
  f.viaFor = true; f.later = false;
  if (f.dir === 'out') {
    if (f.what === 'gone' || f.what === 'back') { f.kind = f.what === 'back' ? 'back' : 'me'; f.recoverFrom = id; f.forcedType = ''; }
    else { f.kind = 'person'; f.personId = id; f.recoverFrom = ''; f.forcedType = f.what === 'spend' ? 'advance' : 'repaid'; }
  } else { f.kind = 'person'; f.personId = id; f.recoverFrom = ''; f.forcedType = f.what === 'lentme' ? 'borrowed' : 'received'; }
  if (f.dir === 'in' && f.what === 'items') f.forcedType = 'received';
  deriveType();
}
function openForPerson(pid, dir) {
  openFormWith({ type: dir === 'in' ? 'income' : 'expense', forId: pid, forOpen: true, what: defaultWhat(pid, dir === 'in' ? 'in' : 'out') });
  applyWhat(); render();
}
function forPeople(sel) {
  const used = {};
  for (const e of live()) { const id = e.type === 'expense' ? e.spentOn : e.type === 'recoverable' ? e.personId : ''; if (id) used[id] = (used[id] || 0) + 1; }
  const rank = p => (p.kind === 'family' ? 0 : p.kind === 'org' ? 1 : 2);
  const pb = personBalances();
  const list = S.people.filter(p => p.kind === 'family' || p.kind === 'org' || used[p.id] || pb[p.id] || p.id === sel)
    .sort((a, b) => rank(a) - rank(b) || (used[b.id] || 0) - (used[a.id] || 0) || a.name.localeCompare(b.name));
  const top = list.slice(0, 6);
  if (sel && !top.some(p => p.id === sel) && person(sel)) top.push(person(sel));
  return top;
}
function spentOnTotals(from, to) {
  const out = {};
  for (const e of live()) if (e.type === 'expense' && e.spentOn && e.date >= from && e.date <= to) out[e.spentOn] = r2((out[e.spentOn] || 0) + e.amount);
  return out;
}
function areaForCat(cid) {
  if (!cid) return '';
  const recent = live().filter(e => e.categoryId === cid && e.bookId && book(e.bookId)).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
  const n = {}; let best = '', bv = 0;
  for (const e of recent) { n[e.bookId] = (n[e.bookId] || 0) + 1; if (n[e.bookId] > bv) { best = e.bookId; bv = n[e.bookId]; } }
  if (best) return best;
  const r = (S.settings.areaByCat || {})[cid];
  return r && book(r) ? r : '';
}
function resetForm(over = {}) {
  if (typeof ui !== 'undefined') { ui.allCats = false; ui.noteOpen = false; }
  const L = S.settings.last || {};
  const u = uiFromType(over.type || 'expense', over.direction);
  form = {
    type: 'expense', amount: '', date: today(), paidFrom: L.paidFrom || (S.accounts[0] ? 'a:' + S.accounts[0].id : ''),
    accountId: L.accountId || (S.accounts[0]?.id || ''), toAccountId: '', bookId: '', categoryId: '', workId: '',
    personId: '', recoverFrom: '', dueDate: '', direction: 'in', repeat: '', note: '',
    receipt: '', receiptData: '', saveTpl: false, tplName: '', txId: '', units: '', billRef: '', sms: null, litres: '', odo: '',
    editingId: null, draftId: null, linkExpected: null, returnTo: null, fromQuick: false, forId: '', what: '', viaFor: false, forcedType: '', forOpen: false, claim: false, claimOff: false, bookTouched: false, ...u, ...over
  };
  if (!form.forId && form.dir === 'out' && form.recoverFrom && ['me', 'back'].includes(form.kind)) { form.forId = form.recoverFrom; form.what = form.kind === 'back' ? 'back' : 'gone'; form.viaFor = true; }
  deriveType();
}
function setFormTypeForTest(t, direction) { const keep = form.amount; Object.assign(form, uiFromType(t, direction)); form.amount = keep; deriveType(); render(); }

function opt(list, val, empty) {
  return (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '') + list.map(x => `<option value="${x.id}" ${x.id === val ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
}

function addLegacy() {
  const f = form, T = TYPES[f.type] || TYPES.expense, has = k => T.f.includes(k);
  const ab = accountBalances(), pb = personBalances();
  const accOpts = S.accounts.map(a => ({ id: a.id, name: `${a.name} (${money(ab[a.id] || 0)})` }));
  const parts = [], tail = [];

  if (!f.editingId) {

  }
  const lock = formLocked();
  const billOnly = f.type === 'expected' && f.direction === 'out' && (f.billOnly || f.editingId);
  if (billOnly) parts.push(`<div class="type-hint">A bill you pay regularly. Tap Pay in Bills when you pay it.</div>`);
  const dirc = f.dir === 'in' ? 'var(--in)' : f.dir === 'move' ? 'var(--move)' : 'var(--out)';
  parts.push(`<div class="addform" style="--dirc:${dirc}">`);
  const segBtn = (v, label) => `<button type="button" class="${f.dir === v ? 'on' : ''}" data-act="setDir" data-v="${v}" ${lock ? 'disabled' : ''}>${label}</button>`;
  const personMode = f.kind === 'person' && !f.viaFor;
  if (personMode) {
    const pn = person(f.personId);
    parts.push(`<div class="seg pdir">${['out', 'in'].map(v => `<button type="button" class="${f.dir === v ? 'on' : ''}" data-act="setPDir" data-v="${v}" ${lock ? 'disabled' : ''}>${v === 'out' ? 'I gave' : 'I received'}</button>`).join('')}</div>`);
    if (pn) { const b = personBalances()[pn.id] || 0; parts.push(`<div class="type-hint">${esc(pn.name)}: ${b > 0 ? 'owes you ' + money(b) : b < 0 ? 'you owe ' + money(-b) : 'all settled'} now.</div>`); }
    if (pn && f.dir === 'in' && !f.editingId) tail.push(`<button class="signpost" data-act="quickType" data-type="spentBy" data-p="${pn.id}">${pn.kind === 'staff' ? 'They spent from my advance?' : 'They paid a bill or bought something for me?'} <b>Record that ›</b></button>`);
  }
  if (!billOnly && !personMode) parts.push(`<div class="seg dir">${segBtn('out', 'Money out')}${segBtn('in', 'Money in')}${segBtn('move', 'Transfer')}</div>`);
  parts.push(`<div class="card">
    <div class="amount-box"><span>${esc(S.settings.currency || 'Rs')}</span><input id="amt" data-f="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(f.amount)}"></div>
    <div class="amount-preview" id="amtPreview"></div>`);

  const forMode = (f.dir === 'out' || f.dir === 'in') && !personMode && !billOnly && (f.viaFor || ['me', 'back', 'income'].includes(f.kind));
  const forP = person(f.forId);
  const forShown = forMode && (f.forOpen || f.forId || f.kind === 'back');
  if (f.sms) parts.push(smsBanner(f));
  else if (!f.editingId && !billOnly && !personMode && f.dir !== 'move' && !f.linkExpected && !f.amount) parts.push(`<div class="quickin"><button type="button" class="chip" data-act="pasteSms">${svgIcon('receipt')} Paste bank SMS</button><button type="button" class="chip" data-act="snap">${svgIcon('camera')} Snap receipt, fill later</button></div>`);
  if (forMode && !forShown && !f.later) parts.push(`<button type="button" class="forlink" data-act="forOpen">${f.dir === 'in' ? 'From someone? Loan, money back…' : 'For someone else? Family, friend, office…'}<span>›</span></button>`);
  if (forShown) {
    const isIn = f.dir === 'in';
    parts.push(`<div class="field forrow"><label>${isIn ? 'From whom?' : 'For whom?'}</label><div class="chips kinds">
      <button type="button" class="chip ${!f.forId && f.kind !== 'back' ? 'on' : ''}" data-act="setFor" data-id="" ${lock ? 'disabled' : ''}>${isIn ? 'Just income' : 'Just me'}</button>
      ${forPeople(f.forId).map(p => `<button type="button" class="chip ${f.forId === p.id ? 'on' : ''}" data-act="setFor" data-id="${p.id}" ${lock ? 'disabled' : ''}>${esc(p.name)}</button>`).join('')}
      <button type="button" class="chip ghost" data-act="forOther" ${lock ? 'disabled' : ''}>Other…</button>
    </div></div>`);
    if (forP) {
      const b = personBalances()[forP.id] || 0, nm = esc(forP.name);
      const its = isIn ? openItemsOf(forP.id) : [];
      const opts = isIn ? [
          ...(its.length ? [['items', 'Paying back items', `${its.slice(0, 2).map(e => esc(entryTitle(e))).join(', ')}${its.length > 2 ? ` +${its.length - 2} more` : ''} · ${money(its.reduce((a, e) => a + recInfo(e).remaining, 0))}`]] : []),
          holdsForMe(forP.id) ? ['paid', 'Returning unused money', `${nm} holds ${money(b)} of yours`] : ['paid', 'Paying me back', b > 0 ? `${nm} owes you ${money(b)}` : 'Money they owed you'],
          ['lentme', 'Lending me', WHAT_IN.lentme[1]],
          ['paidforme', 'Paid something for me', `A bill or item ${nm} paid for you. You will owe them.`]]
        : [['gone', ...WHAT_OUT.gone], ['back', ...WHAT_OUT.back], ['spend', ...WHAT_OUT.spend], ...(b < 0 ? [['repay', WHAT_OUT.repay[0], `You owe ${nm} ${money(-b)}`]] : [])];
      parts.push(`<div class="field"><label>What is this money?</label><div class="whatlist">${opts.map(([k, t, sub]) => `<button type="button" class="what ${f.what === k ? 'on' : ''}" data-act="setWhat" data-v="${k}" ${lock ? 'disabled' : ''}><b>${t}</b>${sub ? `<span>${sub}</span>` : ''}</button>`).join('')}</div></div>`);
      if (isIn && f.what === 'items') parts.push(`<div class="type-hint">After Save you choose which items this money covers.</div>`);
    } else if (f.kind === 'back') parts.push(`<div class="type-hint">To get back. Pick who will pay you back.</div>`);
  }
  if (!billOnly && !(forMode && forP) && (f.dir === 'move' || f.later || personMode)) parts.push(`<div class="type-hint">${esc(UI_HINT[f.dir + ':' + (f.kind || '') + (f.later ? ':later' : '')] || '')}</div>`);
  let laterHtml = '';
  if (!billOnly && ['me', 'income'].includes(f.kind) && !f.forId && !f.linkExpected && !(f.editingId && !f.later && S.entries.find(x => x.id === f.editingId)?.linkExpected)) {
    laterHtml = (`<label class="inline-check"><input type="checkbox" class="check" data-act="toggleLater" ${f.later ? 'checked' : ''} ${lock ? 'disabled' : ''}> ${f.dir === 'out' ? 'Not paid yet (due later)' : 'Not received yet (expected later)'}</label>`);
  }



  const extra = [];
  const dateLbl = T.dateLabel || 'Date';
  const showBook = has('book') && !(f.type === 'expected' && f.direction !== 'out'), showCat = has('cat') || has('catIn') || has('catAny');
  const catKind = has('cat') ? 'out' : has('catIn') ? 'in' : (f.direction === 'out' ? 'out' : 'in');
  const use = {}; live().forEach(e => { if (e.categoryId) use[e.categoryId] = (use[e.categoryId] || 0) + 1; });
  const billMode = f.type === 'expected' && f.direction === 'out';
  const cats = S.categories.filter(c => c.kind === catKind && (billMode ? c.bill : (!c.bill || c.id === f.categoryId))).map((c, i) => ({ c, i })).sort((a, b) => (use[b.c.id] || 0) - (use[a.c.id] || 0) || a.i - b.i).map(x => x.c);
  const OLD_LBL = 'Old amount, from before I used Hisaab';
  // --- essentials
  const BILL_SUG = ['School fee', 'Committee', 'Netflix', 'Car insurance', 'Maintenance'];
  if (showCat && billMode) {
    const have = new Set(cats.map(c => c.name.toLowerCase()));
    parts.push(`<div class="field"><label>Bill type</label><div class="tgrid">${cats.map(c => `<button type="button" class="tile2 cat ${f.categoryId === c.id ? 'on' : ''}" data-act="pickCat" data-id="${c.id}">${svgIcon(catIcon(c.name))}<span>${esc(c.name)}</span></button>`).join('')}${BILL_SUG.filter(n => !have.has(n.toLowerCase())).map(n => `<button type="button" class="tile2" data-act="pickBillSug" data-name="${n}">${svgIcon(catIcon(n))}<span>${n}</span></button>`).join('')}<button type="button" class="tile2 ghost" data-act="editSimple" data-kind="catbill" data-fromform="1">${svgIcon('plus')}<span>Other…</span></button></div></div>`);
  } else if (showCat) {
    // Most used first, left to right; the rest one tap away (fewer choices to scan)
    const TOPN = 6, all = ui.allCats || cats.length <= TOPN + 1;
    let shown = all ? cats : cats.slice(0, TOPN);
    if (!all && f.categoryId && !shown.some(c => c.id === f.categoryId)) { const sel = cats.find(c => c.id === f.categoryId); if (sel) shown = [...shown.slice(0, TOPN - 1), sel]; }
    const chip = c => `<button type="button" class="chip cat ${f.categoryId === c.id ? 'on' : ''}" data-act="pickCat" data-id="${c.id}">${svgIcon(catIcon(c.name))}${esc(c.name)}</button>`;
    parts.push(`<div class="field"><label class="lblrow"><span>Category</span>${cats.length > TOPN + 1 ? `<button type="button" class="link small" data-act="allCats">${all ? 'Show less' : `All ${cats.length} ›`}</button>` : ''}</label>
      <div class="chips">${shown.map(chip).join('')}${all ? `<button type="button" class="chip ghost" data-act="editSimple" data-kind="${catKind === 'in' ? 'catin' : 'catout'}" data-fromform="1">+ New</button>` : `<button type="button" class="chip ghost" data-act="allCats">More…</button>`}</div></div>`);
  }
  if (showBook && S.books.length) parts.push(`<label class="arealine"><span>Area</span><select class="inp" data-f="bookId" aria-label="Area">${opt(S.books, f.bookId, 'None')}</select></label>`);
  // Project: its own visible line once you have an open project (always starts at None, never copied from the last entry)
  const openWorks = S.works.filter(w => !w.closed || w.id === f.workId);
  const projLine = has('work') && openWorks.length > 0 && !(f.type === 'lent' && !f.workId && person(f.personId)?.kind !== 'staff');
  const vehW = work(f.workId);
  if (projLine) parts.push(`<label class="arealine"><span>Project</span><select class="inp" data-f="workId" aria-label="Project">${opt(openWorks, f.workId, 'None')}<option value="__new">+ New project…</option></select></label>`);
  if (vehW && vehW.vehicle && ['expense', 'recoverable'].includes(f.type)) parts.push(`<div class="two veh"><div class="field"><label>Litres <span class="muted">(fuel)</span></label><input data-f="litres" value="${esc(f.litres || '')}" inputmode="decimal" placeholder="e.g. 30"></div><div class="field"><label>Odometer km</label><input data-f="odo" value="${esc(f.odo || '')}" inputmode="numeric" placeholder="e.g. 48250"></div></div>`);
  if (laterHtml) (f.later ? parts : extra).push(laterHtml);
  if (f.type === 'expense' && !f.forId && !f.linkExpected && !f.editingId) {
    const t1 = today(), lim = addDays(t1, 7);
    const due = live().filter(e => e.type === 'expected' && e.direction === 'out' && !expectedInfo(e).closed && e.date <= lim).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 3);
    if (due.length) parts.push(`<div class="billhint"><span>Paying a bill?</span>${due.map(e => `<button type="button" class="chip" data-act="useBill" data-id="${e.id}">${svgIcon(catIcon(e.note || cat(e.categoryId)?.name))}${esc(entryTitle(e))} ${money(expectedInfo(e).rem)}</button>`).join('')}</div>`);
  }
  if (f.linkExpected && f.type === 'expense') { const x = S.entries.find(e => e.id === f.linkExpected); if (x) {
    parts.push(`<div class="type-hint">Paying the bill <b>${esc(entryTitle(x))}</b>. It will be marked paid. <button class="link small" data-act="unlinkBill">Not this bill</button>${x.ref ? `<div class="refline">Ref <b>${esc(x.ref)}</b> <button class="btn sm" data-act="copyRef" data-v="${esc(x.ref)}">Copy</button></div>` : ''}${x.estimated ? `<div class="muted small">The amount is an estimate. Type the amount on your bill.</div>` : ''}</div>`);
    parts.push(`<div class="two"><div class="field"><label>Transaction ID <span class="muted">(optional)</span></label><input data-f="txId" value="${esc(f.txId || '')}" placeholder="From the bank message" autocomplete="off"></div>${billUnitsOk(x) ? `<div class="field"><label>Units used <span class="muted">(optional)</span></label><input data-f="units" value="${esc(f.units || '')}" inputmode="numeric" placeholder="e.g. 240"></div>` : ''}</div>`);
  } }
  else if (f.txId && f.type !== 'expected') parts.push(`<div class="field"><label>Transaction ID</label><input data-f="txId" value="${esc(f.txId)}" autocomplete="off"></div>`);
  if (has('person*') && f.viaFor) { /* person chosen in For/From whom */ }
  else if (has('person*') && !S.people.length) parts.push(`<div class="field"><label>${f.type === 'lent' ? 'To whom' : 'From whom'}</label><button type="button" class="btn primary block" data-act="editPerson" data-fromform="personId">+ Add the person first</button></div>`);
  else if (has('person*')) parts.push(`<div class="field"><label>${f.type === 'lent' ? 'To whom' : 'From whom'}</label><div class="row"><select class="inp grow" data-f="personId">${opt(S.people, f.personId, 'Select person')}</select><button type="button" class="btn sm" data-act="editPerson" data-fromform="personId">+ New</button></div></div>`);
  if (has('paidFrom')) {
    const holders = new Set(live().filter(e => e.type === 'advance').map(e => e.personId));
    const people = S.people.filter(p => holders.has(p.id) && (pb[p.id] || 0) > 0).map(p => `<option value="p:${p.id}" ${f.paidFrom === 'p:' + p.id ? 'selected' : ''}>${esc(p.name)} (${pb[p.id] > 0 ? 'advance ' + money(pb[p.id]) : pb[p.id] < 0 ? 'I owe ' + money(-pb[p.id]) : 'no balance'})</option>`).join('');
    parts.push(`<div class="field"><label>Paid from</label><select data-f="paidFrom">
      <option value="">Select</option>
      <optgroup label="My accounts">${accOpts.map(a => `<option value="a:${a.id}" ${f.paidFrom === 'a:' + a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</optgroup>
      ${f.type === 'recoverable' ? `<optgroup label="Old pending amount"><option value="old" ${f.paidFrom === 'old' ? 'selected' : ''}>${OLD_LBL}</option></optgroup>` : ''}
      ${people ? `<optgroup label="Money I gave them to spend for me">${people}</optgroup>` : ''}
      ${S.people.length ? `<optgroup label="Someone else"><option value="ask" ${f.paidFrom === 'ask' || (f.paidFrom.startsWith('p:') && !people.includes('value="' + f.paidFrom + '"')) ? 'selected' : ''}>Someone else paid for me…</option></optgroup>` : ''}
    </select></div>`);
    if (f.paidFrom === 'ask' || (f.paidFrom.startsWith('p:') && !people.includes('value="' + f.paidFrom + '"'))) {
      const who = f.paidFrom.startsWith('p:') ? f.paidFrom.slice(2) : '';
      parts.push(`<div class="field"><label>Who paid? <span class="muted">(you will owe them)</span></label><select data-f="paidFromWho">${opt(S.people, who, 'Select person')}</select></div>`);
    }
  }
  if (has('account')) parts.push(`<div class="field"><label>${f.type === 'transfer' ? 'From account' : ['income', 'borrowed', 'received'].includes(f.type) ? 'Into account' : 'From account'}</label><select data-f="accountId">${opt(accOpts, f.accountId, 'Select account')}${['lent', 'borrowed', 'advance', 'received', 'repaid'].includes(f.type) ? `<option value="__old" ${f.accountId === '__old' ? 'selected' : ''}>${OLD_LBL} (no account)</option>` : ''}</select></div>`);
  if ((has('paidFrom') && f.paidFrom === 'old') || (has('account') && f.accountId === '__old')) parts.push(`<div class="type-hint">Old amount: updates who owes whom, but does not change any account balance.</div>`);
  if (has('toAccount')) parts.push(`<div class="field"><label>To account</label><select data-f="toAccountId">${opt(accOpts, f.toAccountId, 'Select account')}</select></div>`);
  const dateField = `<div class="field"><label>${dateLbl}</label><input type="date" data-f="date" value="${esc(f.date)}"></div>`;
  const repeatField = `<div class="field"><label>How often</label><select data-f="repeat">${REPEAT_OPT.map(([k, l]) => `<option value="${k}" ${(f.repeat || '') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
  if (billMode) {
    parts.push(`<div class="field"><label>Bill name</label><input data-f="note" value="${esc(f.note)}" placeholder="e.g. LESCO, SNGPL, PTCL, Netflix" maxlength="80"></div>`);
    parts.push(`<div class="field"><label>Reference / consumer no. <span class="muted">(optional)</span></label><input data-f="billRef" value="${esc(f.billRef || '')}" placeholder="From the printed bill" autocomplete="off" maxlength="40"></div>`);
    parts.push(`<div class="two">${dateField}${repeatField}</div>`);
    if (f.repeat && f.date) parts.push(`<div class="type-hint">After you pay, the next one is due on <b>${fmtDate(nextDue(f.date, f.repeat))}</b>.</div>`);
    parts.push(`<div class="field"><label>Usually paid from</label><select data-f="accountId">${opt(accOpts, f.accountId, 'Choose when paying')}</select></div>`);
  } else if (f.type === 'expected') {
    parts.push(`<div class="two">${dateField}${repeatField}</div>`);
  } else {
    const t0 = today(), dl = f.date === t0 ? 'Today, ' + fmtShort(f.date) : f.date === addDays(t0, -1) ? 'Yesterday, ' + fmtShort(f.date) : fmtDate(f.date);
    parts.push(`<div class="field"><label>Date</label><label class="datebox"><span>${dl}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v15H4z M4 10h16 M8 3v4 M16 3v4"/></svg><input type="date" class="dpick" data-f="date" value="${esc(f.date)}" aria-label="Change date"></label></div>`);
  }
  // --- more details
  if (has('due')) extra.push(`<div class="field"><label>${f.type === 'received' ? 'Rest promised by' : 'Return by'} (optional)</label><input type="date" data-f="dueDate" value="${esc(f.dueDate)}"></div>`);
  if (has('personOpt') && !billMode) extra.push(`<div class="field"><label>From / to (optional)</label><select data-f="personId">${opt(S.people, f.personId, 'None')}</select></div>`);
  if (has('work') && !projLine && (f.type !== 'lent' || f.workId || person(f.personId)?.kind === 'staff')) extra.push(`<div class="field"><label>Project / site (optional)</label><div class="row"><select class="inp grow" data-f="workId">${opt(S.works.filter(w => !w.closed || w.id === f.workId), f.workId, 'None')}</select><button type="button" class="btn sm" data-act="editWork" data-fromform="1">+ New</button></div></div>`);
  if (!billMode) extra.push(`<div class="field"><label>Note</label><input data-f="note" value="${esc(f.note)}" placeholder="What was it for?" maxlength="200"></div>`);
  if (has('receipt')) {
    const src = f.receiptData || (f.receipt ? imgCache[f.receipt] : '');
    extra.push(`<div class="field"><label>Receipt</label>${(f.receiptData || f.receipt)
      ? `<div class="receipt-thumb"><img id="rcptImg" src="${src || ''}" alt="Receipt"><button type="button" data-act="removeReceipt">×</button></div>`
      : `<button type="button" class="btn sm" data-act="pickReceipt">📎 Attach photo</button>`}</div>`);
  }
  const open = !!S.settings.addMore || !!f.editingId;
  const filled = [f.note && !billMode ? 'note' : '', (f.receipt || f.receiptData) ? 'receipt' : '', f.workId && work(f.workId) && !projLine ? work(f.workId).name : ''].filter(Boolean);
  parts.push(`<button type="button" class="more-toggle" data-act="toggleAddMore" aria-expanded="${open}"><span>More details${filled.length ? ': ' + esc(filled.join(' · ')) : billMode ? '' : ' (note, receipt)'}</span><span>${open ? '▴' : '▾'}</span></button>`);
  if (open) parts.push(`<div class="more-box">${extra.join('')}</div>`);
  parts.push(`</div>`);
  if (f.editingId && !f.draftId) parts.push(`<button class="btn primary block" data-act="saveForm">Update</button>`);
  else parts.push(`<button class="btn primary block" data-act="saveForm">Save</button><button class="link addnext" data-act="saveNext">Save and add another</button>`);
  if (f.editingId || f.linkExpected || f.returnTo) parts.push(`<button class="btn block mt" data-act="cancelForm">Cancel</button>`);
  if (tail.length) parts.push(`<div class="form-tail">${tail.join('')}</div>`);
  parts.push(`</div>`);
  return parts.join('');
}

// ---------------- Add screen (v40): big amount, small chips, category tiles, keypad ----------------
// Own money on the + screen; money with a person uses the same screen in "person" mode.
function addMode() {
  const f = form;
  const billOnly = f.type === 'expected' && f.direction === 'out' && (f.billOnly || f.editingId);
  if (billOnly || f.later || f.type === 'expected' || formLocked()) return 'legacy';
  if (f.kind === 'person' && !f.viaFor) return 'legacy';
  if (f.dir !== 'move' && (f.forId || f.viaFor || f.kind === 'back')) return 'person';
  return 'simple';
}
const ARROW = {
  in: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M5 13l7 7 7-7"/></svg>',
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V4M5 11l7-7 7 7"/></svg>',
  move: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 20V5M4 9l4-4 4 4M16 4v15M12 15l4 4 4-4"/></svg>'
};
function chipSel(label, sel, icon, cls = '') {
  return `<label class="ach ${cls}">${icon ? svgIcon(icon) : ''}<span>${label}</span>${sel}</label>`;
}
function addChips(f, mode) {
  const T = TYPES[f.type] || TYPES.expense, has = k => T.f.includes(k);
  const ab = accountBalances(), out = [];
  const aOpt = (val, sel) => S.accounts.map(a => `<option value="${val(a)}" ${sel === val(a) ? 'selected' : ''}>${esc(a.name)} (${money(ab[a.id] || 0)})</option>`).join('');
  if (has('paidFrom')) {
    const k = f.paidFrom || '', pp = k.startsWith('p:') ? person(k.slice(2)) : null;
    const label = k === 'old' ? 'Before Hisaab' : pp ? 'Paid by ' + esc(pp.name) : acc(k.slice(2))?.name ? esc(acc(k.slice(2)).name) : 'Paid from';
    // People holding my money (given to spend for me) can pay from it; "someone else paid for me" lives in People
    const pb = personBalances(), holders = new Set(live().filter(e => e.type === 'advance').map(e => e.personId));
    const hold = S.people.filter(p => holders.has(p.id) && (pb[p.id] || 0) > 0);
    const holdOpts = hold.map(p => `<option value="p:${p.id}" ${k === 'p:' + p.id ? 'selected' : ''}>${esc(p.name)} (holds ${money(pb[p.id])})</option>`).join('');
    const extraP = pp && !hold.some(p => p.id === pp.id) ? `<option value="${k}" selected>Paid by ${esc(pp.name)}</option>` : '';
    out.push(chipSel(label, `<select data-f="paidFrom" aria-label="Paid from">${k ? '' : '<option value="" selected>Choose</option>'}<optgroup label="My accounts">${aOpt(a => 'a:' + a.id, k)}</optgroup>${holdOpts ? `<optgroup label="Money I gave them to spend">${holdOpts}</optgroup>` : ''}${extraP}${f.type === 'recoverable' ? `<option value="old" ${k === 'old' ? 'selected' : ''}>Before Hisaab (no account)</option>` : ''}</select>`, pp ? 'users' : 'wallet', k ? '' : 'need'));
  }
  if (has('account')) {
    const old = ['lent', 'borrowed', 'advance', 'received', 'repaid'].includes(f.type);
    const label = f.accountId === '__old' ? 'Before Hisaab' : acc(f.accountId) ? esc(acc(f.accountId).name) : f.type === 'transfer' ? 'From' : 'Account';
    out.push(chipSel((f.type === 'transfer' ? 'From ' : '') + label, `<select data-f="accountId" aria-label="Account">${f.accountId ? '' : '<option value="" selected>Choose</option>'}${aOpt(a => a.id, f.accountId)}${old ? `<option value="__old" ${f.accountId === '__old' ? 'selected' : ''}>Before Hisaab (no account)</option>` : ''}</select>`, 'wallet', f.accountId ? '' : 'need'));
  }
  if (has('toAccount')) out.push(chipSel('To ' + (acc(f.toAccountId) ? esc(acc(f.toAccountId).name) : '…'), `<select data-f="toAccountId" aria-label="To account"><option value="">Choose</option>${aOpt(a => a.id, f.toAccountId)}</select>`, 'swap', f.toAccountId ? '' : 'need'));
  if (mode === 'person' && (has('cat'))) {
    const cats = S.categories.filter(c => c.kind === 'out' && (!c.bill || c.id === f.categoryId));
    out.push(chipSel(f.categoryId ? esc(catName(f.categoryId)) : 'Category', `<select data-f="categoryId" aria-label="Category"><option value="">None</option>${cats.map(c => `<option value="${c.id}" ${f.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`, f.categoryId ? catIcon(catName(f.categoryId)) : 'tag'));
  }
  if (has('book') && S.books.length) out.push(chipSel(f.bookId && book(f.bookId) ? esc(book(f.bookId).name) : 'Area', `<select data-f="bookId" aria-label="Area"><option value="">No area</option>${S.books.map(b => `<option value="${b.id}" ${f.bookId === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>`, 'grid', f.bookId ? '' : 'dim'));
  const openWorks = S.works.filter(w => !w.closed || w.id === f.workId);
  if (has('work')) out.push(chipSel(work(f.workId) ? esc(work(f.workId).name) : 'Project', `<select data-f="workId" aria-label="Project"><option value="">No project</option>${openWorks.map(w => `<option value="${w.id}" ${f.workId === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}<option value="__new">+ New project…</option></select>`, 'folder', f.workId ? '' : 'dim'));
  const ca = f.type === 'expense' && !f.linkExpected && mode === 'simple' ? claimArea(f.bookId) : null;
  if (ca) out.push(`<button type="button" class="ach ${f.claimOff ? 'dim' : 'claim'}" data-act="toggleClaim" aria-pressed="${!f.claimOff}">${svgIcon('back')}<span>${f.claimOff ? 'My own money · no claim' : 'Claim from ' + esc(person(ca.claimFrom).name)}</span></button>`);
  if (f.type === 'recoverable' && mode === 'person') out.push(`<button type="button" class="ach ${f.claim ? 'claim' : 'dim'}" data-act="toggleClaimFlag" aria-pressed="${!!f.claim}">${svgIcon('brief')}<span>${f.claim ? 'Official claim' : 'Personal (not a claim)'}</span></button>`);
  if (f.receipt || f.receiptData) out.push(`<button type="button" class="ach" data-act="removeReceipt" aria-label="Remove receipt">${svgIcon('camera')}<span>Receipt ×</span></button>`);
  let extra = '';
  const vw = work(f.workId);
  if (((vw && vw.vehicle) || book(f.bookId)?.vehicle) && ['expense', 'recoverable'].includes(f.type)) extra += `<div class="addmini"><input data-f="litres" value="${esc(f.litres || '')}" inputmode="decimal" placeholder="Litres" aria-label="Litres"><input data-f="odo" value="${esc(f.odo || '')}" inputmode="numeric" placeholder="Odometer km" aria-label="Odometer km"></div>`;
  return `<div class="achips">${out.join('')}</div>${extra}`;
}
function noteLine(f) { return `<input class="addnote" data-f="note" value="${esc(f.note)}" placeholder="Note: what was it for?" maxlength="200" aria-label="Note" autocomplete="off">`; }
function dateRow(f) {
  const t0 = today(), opts = [[0, 'Today'], [1, 'Yesterday'], [2, '2 days ago']];
  const known = opts.some(([n]) => f.date === addDays(t0, -n));
  return `<div class="dchips" role="group" aria-label="Date">${opts.map(([n, l]) => `<button type="button" class="dch ${f.date === addDays(t0, -n) ? 'on' : ''}" data-act="dateQuick" data-n="${n}">${l}</button>`).join('')}
    <label class="dch pick ${known ? '' : 'on'}">${svgIcon('cal')}<span>${known ? 'Pick' : fmtShort(f.date)}</span><input type="date" data-f="date" value="${esc(f.date)}" aria-label="Pick a date"></label></div>`;
}
function keypadHtml(mode, f) {
  const k = (v, cls = '', label = v, aria = '') => `<button type="button" class="kp ${cls}" data-act="kp" data-k="${v}" ${aria ? `aria-label="${aria}"` : ''}>${label}</button>`;
  const side = mode === 'person'
    ? `<button type="button" class="kp side" data-act="toMe" aria-label="Back to my own spending">${svgIcon('wallet')}<small>Mine</small></button>`
    : f.dir === 'move' || f.editingId ? '<span class="kp blank"></span>'
      : `<button type="button" class="kp side" data-act="toPersonPick" aria-label="Money with a person">${svgIcon('users')}<small>Person</small></button>`;
  return `<div class="keypad2">
    ${k('1')}${k('2')}${k('3')}${k('⌫', 'op', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 5H9l-6 7 6 7h12zM18 9l-6 6M12 9l6 6"/></svg>', 'Delete (hold to clear)')}
    ${k('4')}${k('5')}${k('6')}${k('+', 'op plus', '+', 'Plus')}
    ${k('7')}${k('8')}${k('9')}${k('-', 'op minus', '−', 'Minus')}
    ${k('.', '', '.')}${k('0')}${side}<button type="button" class="kp ok" data-act="saveForm" aria-label="${f.editingId && !f.draftId ? 'Update' : 'Save'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
  </div>`;
}
function addTop(mode, f) {
  const lock = formLocked();
  let sw;
  if (mode === 'person') {
    sw = [['out', 'I gave'], ['in', 'I received']].map(([v, l]) => `<button type="button" class="dsw ${v} ${f.dir === v ? 'on' : ''}" data-act="pDir" data-v="${v}" ${lock ? 'disabled' : ''} aria-label="${l}">${ARROW[v]}${f.dir === v ? `<span>${l}</span>` : ''}</button>`).join('');
  } else {
    sw = [['in', 'Income'], ['out', 'Expense'], ['move', 'Transfer']].map(([v, l]) => `<button type="button" class="dsw ${v} ${f.dir === v ? 'on' : ''}" data-act="setDir" data-v="${v}" ${f.editingId && f.dir !== v && (f.type === 'transfer' || v === 'move') ? 'disabled' : ''} aria-label="${l}">${ARROW[v]}${f.dir === v ? `<span>${l}</span>` : ''}</button>`).join('');
  }
  return `<div class="addtop"><button type="button" class="icon-btn" data-act="cancelForm" aria-label="Close">✕</button>
    <div class="dirsw">${sw}</div>
    <div class="addtop-r"><button type="button" class="icon-btn" data-act="addMoreSheet" aria-label="More options">⋯</button></div></div>`;
}
function amountBlock(f) {
  return `<div class="abig"><span class="cur">${esc(S.settings.currency || 'Rs')}</span><input id="amt" data-f="amount" inputmode="none" autocomplete="off" placeholder="0" value="${esc(f.amount)}" aria-label="Amount"></div>
    <div class="amount-preview" id="amtPreview"></div>`;
}
function billBanner(f) {
  const x = S.entries.find(e => e.id === f.linkExpected); if (!x) return '';
  return `<div class="paybill"><div class="pb-top">${svgIcon(catIcon(x.note || cat(x.categoryId)?.name))}<span>Paying <b>${esc(entryTitle(x))}</b>${x.estimated ? ' · amount is an estimate' : ''}</span><button type="button" class="link small" data-act="unlinkBill">Not this bill</button></div>
    ${x.ref ? `<div class="refline">Ref <b>${esc(x.ref)}</b> <button type="button" class="btn sm" data-act="copyRef" data-v="${esc(x.ref)}">Copy</button></div>` : ''}
    <div class="addmini"><input data-f="txId" value="${esc(f.txId || '')}" placeholder="Transaction ID (optional)" autocomplete="off" aria-label="Transaction ID">${billUnitsOk(x) ? `<input data-f="units" value="${esc(f.units || '')}" inputmode="numeric" placeholder="Units" aria-label="Units used">` : ''}</div></div>`;
}
function catTiles(f) {
  const kind = f.dir === 'in' ? 'in' : 'out';
  // Rank by use: first within the chosen project or area, then overall
  const use = {}, loc = {}, scope = f.workId ? (e => e.workId === f.workId) : (f.bookId && f.bookTouched) || (f.bookId && !f.categoryId) ? (e => e.bookId === f.bookId) : null;
  live().forEach(e => { if (!e.categoryId) return; use[e.categoryId] = (use[e.categoryId] || 0) + 1; if (scope && scope(e)) loc[e.categoryId] = (loc[e.categoryId] || 0) + 1; });
  const cats = S.categories.filter(c => c.kind === kind && (!c.bill || c.id === f.categoryId)).map((c, i) => ({ c, i })).sort((a, b) => (loc[b.c.id] || 0) - (loc[a.c.id] || 0) || (use[b.c.id] || 0) - (use[a.c.id] || 0) || a.i - b.i).map(x => x.c);
  const bills = kind === 'out' && f.type === 'expense' && !f.linkExpected && !f.editingId
    ? live().filter(e => e.type === 'expected' && e.direction === 'out' && !expectedInfo(e).closed && e.date <= addDays(today(), 7) && !(f.bookId && e.bookId && e.bookId !== f.bookId) && !live().some(p => p.type === 'expense' && !p.linkExpected && billMatch(p) === e)).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 2) : [];
  const all = ui.allCats, slots = 7 - bills.length;
  let shown = all ? cats : cats.slice(0, slots);
  if (!all && f.categoryId && !shown.some(c => c.id === f.categoryId)) { const s = cats.find(c => c.id === f.categoryId); if (s) shown = [...shown.slice(0, slots - 1), s]; }
  const tile = c => `<button type="button" class="ctile ${f.categoryId === c.id ? 'on' : ''}" data-act="pickCat" data-id="${c.id}">${svgIcon(catIcon(c.name))}<span>${esc(c.name)}</span></button>`;
  return `<div class="ctiles">${all ? '' : bills.map(e => `<button type="button" class="ctile bill" data-act="useBill" data-id="${e.id}">${svgIcon(catIcon(e.note || cat(e.categoryId)?.name))}<span>${esc(entryTitle(e))}</span><em>due</em></button>`).join('')}${shown.map(tile).join('')}${all
    ? `<button type="button" class="ctile ghost" data-act="editSimple" data-kind="${kind === 'in' ? 'catin' : 'catout'}" data-fromform="1">${svgIcon('plus')}<span>New</span></button><button type="button" class="ctile ghost" data-act="allCats">${svgIcon('back')}<span>Less</span></button>`
    : cats.length > shown.length ? `<button type="button" class="ctile ghost" data-act="allCats">${svgIcon('grid')}<span>More</span></button>` : ''}</div>`;
}
function whatTiles(f) {
  const lock = formLocked(), p = person(f.forId), isIn = f.dir === 'in';
  if (!p) return `<div class="field"><div class="chips kinds">${forPeople('').map(x => `<button type="button" class="chip" data-act="setFor" data-id="${x.id}">${esc(x.name)}</button>`).join('')}<button type="button" class="chip ghost" data-act="forOther">Other…</button></div></div>`;
  const b = personBalances()[p.id] || 0, nm = esc(p.name), its = isIn ? openItemsOf(p.id) : [];
  const opts = isIn ? [
    ...(its.length ? [['items', 'Paying back items', `${esc(entryTitle(its[0]))}${its.length > 1 ? ' +' + (its.length - 1) : ''} · ${money(its.reduce((a, e) => a + recInfo(e).remaining, 0))}`]] : []),
    holdsForMe(p.id) ? ['paid', 'Returning unused money', `holds ${money(b)} of yours`] : ['paid', 'Paying me back', b > 0 ? `owes you ${money(b)}` : 'money they owed you'],
    ['lentme', 'Lending me', 'you will return it'],
    ['paidforme', 'Paid for me', 'a bill or item; you will owe them']]
    : [['gone', 'Not coming back', 'gift, treat, a fee for them'], ['back', 'Coming back', 'a loan, or office will repay'], ['spend', 'To spend for me', 'they buy things, return change'], ...(b < 0 ? [['repay', 'Paying back what I owe', `you owe ${money(-b)}`]] : [])];
  return `<div class="wtiles">${opts.map(([k, t, sub]) => `<button type="button" class="wtile ${f.what === k ? 'on' : ''}" data-act="setWhat" data-v="${k}" ${lock ? 'disabled' : ''}><b>${t}</b><span>${sub}</span></button>`).join('')}</div>
    ${isIn && holdsForMe(p.id) && !f.editingId ? `<button type="button" class="link small spentby" data-act="quickType" data-type="spentBy" data-p="${p.id}">They spent some of it for me ›</button>` : ''}`;
}
VIEWS.add = () => {
  const mode = addMode();
  if (mode === 'legacy') return addLegacy();
  const f = form, parts = [`<div class="addv ${mode}" data-dir="${f.dir}">`, addTop(mode, f)];
  if (mode === 'person') {
    const p = person(f.forId), b = p ? personBalances()[p.id] || 0 : 0;
    parts.push(p ? `<div class="pline"><span class="ico av">${esc((p.name.trim()[0] || '?').toUpperCase())}</span><div class="grow"><b>${esc(p.name)}</b><span>${b > 0 ? 'owes you ' + money(b) : b < 0 ? 'you owe ' + money(-b) : 'all settled'}</span></div>${f.editingId ? '' : `<button type="button" class="link small" data-act="forOther">Change</button>`}</div>`
      : `<div class="pline"><div class="grow"><b>${f.dir === 'in' ? 'From whom?' : 'For whom?'}</b></div></div>`);
  }
  parts.push(amountBlock(f), noteLine(f), dateRow(f));
  if (f.sms) parts.push(smsBanner(f));
  if (f.linkExpected && f.type === 'expense') parts.push(billBanner(f));
  else if (f.txId && !f.sms) parts.push(`<div class="addmini"><input data-f="txId" value="${esc(f.txId)}" placeholder="Transaction ID" aria-label="Transaction ID"></div>`);
  parts.push(addChips(f, mode));
  if (mode === 'person') parts.push(whatTiles(f));
  else if (f.dir !== 'move') parts.push(catTiles(f));
  if (f.dir === 'in' && f.what === 'items' && mode === 'person') parts.push(`<div class="type-hint">After saving you choose which items this covers.</div>`);
  parts.push(keypadHtml(mode, f), '</div>');
  return parts.join('');
};
function addMoreSheet() {
  const f = form, mode = addMode(), isNew = !f.editingId;
  const b = (act, icon, label, extra = '') => `<button class="opt" data-act="${act}" ${extra}>${svgIcon(icon)}<span>${label}</span></button>`;
  openSheet(`${sheetHead('More')}<div class="optlist moreopts">
    ${(f.receipt || f.receiptData) ? b('removeReceipt', 'camera', 'Remove receipt photo') : b('pickReceipt', 'camera', 'Attach receipt photo')}
    ${isNew && mode === 'simple' ? b('snap', 'camera', 'Snap receipt now, fill details later') : ''}
    ${isNew && mode === 'simple' && f.dir !== 'move' ? b('pasteSms', 'receipt', 'Paste bank SMS') : ''}
    ${isNew && mode === 'simple' && f.dir !== 'move' && !f.linkExpected ? b('setLater', 'cal', f.dir === 'out' ? 'Not paid yet (due later)' : 'Not received yet (expected later)') : ''}
    ${mode === 'person' && has2(f, 'due') ? `<label class="opt dueopt">${svgIcon('cal')}<span>${f.type === 'received' ? 'Rest promised by' : 'Return by'}</span><input type="date" data-f="dueDate" value="${esc(f.dueDate || '')}"></label>` : ''}
    ${isNew ? b('saveNext', 'plus', 'Save and add another') : ''}
  </div>`);
}
function has2(f, k) { return (TYPES[f.type] || TYPES.expense).f.includes(k); }
function kpPress(k) {
  const inp = $('#amt'); if (!inp) return;
  let v = String(form.amount || '');
  if (k === '⌫') v = v.slice(0, -1);
  else if (k === 'C') v = '';
  else if (k === '+' || k === '-') { if (!v) return; v = /[+\-]$/.test(v) ? v.slice(0, -1) + k : v + k; }
  else if (k === '.') { const last = v.split(/[+\-]/).pop(); if (last.includes('.')) return; v += last ? '.' : '0.'; }
  else { const last = v.split(/[+\-]/).pop(); if (last === '0') v = v.slice(0, -1); if (last.replace('.', '').length >= 10) return; v += k; }
  form.amount = v; inp.value = v; updateAmtPreview(); fitAmount();
}
function fitAmount() { const inp = $('#amt'); if (!inp) return; const n = String(inp.value || '0').length; inp.style.fontSize = n > 12 ? '30px' : n > 9 ? '38px' : n > 7 ? '46px' : ''; }

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
  if (!raw.trim()) { el.textContent = ''; return; }
  const v = evalAmount(raw);
  if (isNaN(v)) { el.innerHTML = '<span class="danger">Not a valid amount</span>'; return; }
  el.textContent = /[+\-*/x×]/.test(raw.replace(/^-/, '')) ? '= ' + money(v) : $('.abig') ? '' : money(v);
}

function formToEntry() {
  const f = form, T = TYPES[f.type], has = k => T.f.includes(k);
  const amount = evalAmount(f.amount);
  if (!(amount > 0)) { toast('Enter a valid amount'); return null; }
  if (!f.date) { toast('Select a date'); return null; }
  const e = { type: f.type, amount, date: f.date, note: (f.note || '').trim() };
  if (has('paidFrom')) {
    if (!f.paidFrom || f.paidFrom === 'ask') { toast(f.paidFrom === 'ask' ? 'Select who paid' : 'Select where the money came from'); return null; }
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
  if (f.type === 'expense' && f.recoverFrom && person(f.recoverFrom)) e.spentOn = f.recoverFrom;
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
  if (e.type === 'expected' && e.direction === 'out' && (f.billRef || '').trim()) e.ref = f.billRef.trim();
  if ((f.txId || '').trim() && e.type !== 'expected') e.txId = f.txId.trim();
  if (f.linkExpected && Number(f.units) > 0) e.units = Number(f.units);
  if ((work(f.workId)?.vehicle || book(f.bookId)?.vehicle) && ['expense', 'recoverable'].includes(e.type)) { if (Number(f.litres) > 0) e.litres = Math.round(Number(f.litres) * 100) / 100; if (Number(f.odo) > 0) e.odo = Math.round(Number(f.odo)); }
  if (e.type === 'lent' || e.type === 'received') {
    const old = f.editingId ? S.entries.find(x => x.id === f.editingId) : null;
    const grp = e.type === 'lent' ? ['lent', 'advance', 'repaid'] : ['received', 'borrowed'];
    if (f.viaFor && f.forcedType) e.type = f.forcedType;
    else if (old && !old.draft && grp.includes(old.type) && old.personId === e.personId) e.type = old.type;
    else {
      const bal = personBalances()[e.personId] || 0, p = person(e.personId);
      e.type = e.type === 'lent' ? (bal < 0 ? 'repaid' : (p && p.kind === 'staff') ? 'advance' : 'lent') : (bal > 0 ? 'received' : 'borrowed');
    }
    if (e.type === 'advance' || e.type === 'repaid') delete e.dueDate;
  }
  if (e.type === 'expense' && !e.categoryId && !f.linkExpected && !f.draftId) { toast('Pick a category'); $('.ctiles')?.scrollIntoView({ block: 'center' }); return null; }
  if (e.oldEntry && !f.editingId) { const fd = firstAccDate(); if (fd && e.date >= fd) { toast(`"Before Hisaab" is only for money paid before ${fmtShort(fd)}. Choose the account.`); return null; } }
  if (e.type === 'recoverable' && f.claim) e.claim = true;
  if (e.type === 'expense' && claimOn(f)) { const b = claimArea(f.bookId); e.type = 'recoverable'; e.personId = b.claimFrom; e.claim = true; delete e.spentOn; }
  return e;
}

const DIFF_KEYS = ['litres', 'odo', 'txId', 'units', 'ref', 'type', 'amount', 'date', 'oldEntry', 'accountId', 'toAccountId', 'viaPersonId', 'bookId', 'categoryId', 'workId', 'personId', 'dueDate', 'direction', 'repeat', 'note', 'receipt'];
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
  if (!form.editingId && form.viaFor && form.dir === 'in' && form.what === 'items') {
    const amt = evalAmount(form.amount); if (!(amt > 0)) { toast('Enter a valid amount'); return; }
    openRecovery(openItemsOf(form.forId).map(e => e.id), { amount: amt, accountId: form.accountId, date: form.date, note: form.note, after: true, returnTo: form.returnTo });
    return;
  }
  const snap = form.editingId ? null : JSON.stringify(S);
  const e = formToEntry();
  if (!e) return;
  const f = form;
  if (!f.editingId) {
    if (e.type !== 'expected' && e.date > today() && !(await confirmBox('Date is in the future', `${fmtDate(e.date)} hasn't come yet. Save with this date?`, 'Save anyway'))) return;
    const bx = billMatch(e);
    if (bx && await confirmBox(`Is this the ${entryTitle(bx)} bill?`, `${esc(entryTitle(bx))} (${money(expectedInfo(bx).rem || bx.amount)}, due ${fmtShort(bx.date)}) is still open. Link this payment to it?`, 'Yes, link it')) { e.linkExpected = bx.id; f.linkExpected = bx.id; }
    if (e.type === 'received' && f.viaFor && f.what === 'paid' && !holdsForMe(e.personId)) {
      const b = personBalances()[e.personId] || 0, extra = r2(e.amount - Math.max(0, b));
      if (extra > 0) {
        const nm = person(e.personId)?.name || 'They';
        const old = await confirmBox('Money lent before Hisaab?', `${esc(nm)} owes you ${money(Math.max(0, b))} in Hisaab. Was the other ${money(extra)} lent before you started using the app?`, 'Yes, lent before', false, 'No, they are lending me');
        if (old) S.entries.push({ id: uid(), createdAt: new Date().toISOString(), history: [], type: 'lent', amount: extra, date: addDays(firstAccDate() || e.date, -1), note: 'Lent before Hisaab', personId: e.personId, oldEntry: true });
      }
    }
  }
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
    if (e.type === 'expected') { upd.closed = old.closed || false; upd.spawned = old.spawned || false; if (old.direction === 'out' || e.direction === 'out') { upd.seriesId = billSid(old); if (old.estimated && old.amount === e.amount) upd.estimated = true; } }
    if (old.draft) { upd.createdAt = nowIso; }
    else if (Object.keys(changes).length) upd.history = [...upd.history, { at: nowIso, changes }];
    S.entries[idx] = upd;
    savedId = upd.id;
  } else {
    const dup = live().find(x => x.type === e.type && x.amount === e.amount && x.date === e.date && (x.accountId || '') === (e.accountId || '') && (x.personId || '') === (e.personId || '') && (x.viaPersonId || '') === (e.viaPersonId || ''));
    if (dup && !(await confirmBox('Possible duplicate', `An entry of ${money(e.amount)} on ${fmtDate(e.date)} already exists ("${esc(entryTitle(dup))}"). Save anyway?`, 'Save anyway'))) return;
    e.receipt = TYPES[e.type].f.includes('receipt') ? await persistReceipt('') : '';
    e.id = uid(); e.createdAt = nowIso; e.history = [];
    if (e.type === 'expected' && e.direction === 'out') e.seriesId = e.id;
    S.entries.push(e);
    savedId = e.id;
  }

  if (f.sms && f.sms.digits && e.accountId && acc(e.accountId)) { S.settings.acctDigits = { ...(S.settings.acctDigits || {}), [f.sms.digits]: e.accountId }; }
  if (e.linkExpected) afterExpectedPayment(e.linkExpected);
  if (e.dueDate && e.personId && person(e.personId)) person(e.personId).dueDate = e.dueDate;
  if (e.categoryId && e.bookId) { S.settings.areaByCat = S.settings.areaByCat || {}; S.settings.areaByCat[e.categoryId] = e.bookId; }


  S.settings.last = { ...S.settings.last, paidFrom: (f.paidFrom && f.paidFrom !== 'old') ? f.paidFrom : S.settings.last.paidFrom, accountId: (f.accountId && f.accountId !== '__old') ? f.accountId : S.settings.last.accountId, bookId: f.bookId || S.settings.last.bookId };

  await save();
  const ret = f.returnTo;
  const wasEdit = !!f.editingId && !f.draftId;
  if (again && !wasEdit) {
    const keep = { billOnly: f.billOnly, type: f.type, direction: f.direction, dir: f.dir, kind: f.kind, later: f.later, date: f.date, paidFrom: f.paidFrom, accountId: f.accountId, bookId: f.bookId, bookTouched: f.bookTouched, personId: f.personId, workId: f.workId, recoverFrom: f.recoverFrom, forId: f.forId, what: f.what, viaFor: f.viaFor, forcedType: f.forcedType, forOpen: f.forOpen };
    resetForm(keep);
    tab = 'add'; stack = []; cur = { v: 'add', p: null };
    render(); window.scrollTo(0, 0);
    toast(`Saved ${entryTitle(e)} ${money(e.amount)}. Add the next one`, snap);
    setTimeout(() => $('#amt')?.focus(), 60);
    return;
  }
  resetForm();
  if (wasEdit) toast('Updated'); else toast(`Saved · ${entryTitle(e)} ${money(e.amount)}`, snap);
  if (ret) { tab = ret.tab; stack = ret.stack; cur = ret.cur; render(); }
  else if (stack.length) stepBack();
  else setTab('home');
}

async function cancelForm() {
  if (cur.v === 'add' && !form.editingId && evalAmount(form.amount || '') > 0 && !(await confirmBox('Discard this entry?', `${money(evalAmount(form.amount))} has not been saved.`, 'Discard', true))) return;
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
    workId: e.workId || '', personId: e.type === 'recoverable' ? '' : (e.personId || ''), recoverFrom: e.type === 'recoverable' ? (e.personId || '') : e.type === 'expense' ? (e.spentOn || '') : '',
    dueDate: e.dueDate || '', direction: e.direction || 'in', repeat: e.repeat || '', receipt: e.receipt || '',
    editingId: e.id, draftId: e.draft ? e.id : null, linkExpected: e.linkExpected || null, bookTouched: !!e.bookId, claim: !!e.claim, claimOff: true,
    txId: e.txId || '', units: e.units ? String(e.units) : '', billRef: e.ref || '', litres: e.litres ? String(e.litres) : '', odo: e.odo ? String(e.odo) : ''
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
    const due = nextDue(x.date, x.repeat), sid = x.direction === 'out' ? billSid(x) : '';
    if (sid) x.seriesId = sid;
    const est = sid ? billEstimate(sid, due) : null;
    S.entries.push({
      id: uid(), type: 'expected', amount: est ? est.v : x.amount, date: due, note: x.note || '', categoryId: x.categoryId || '',
      bookId: x.bookId || '', accountId: x.accountId || '', personId: x.personId || '', direction: x.direction, repeat: x.repeat, closed: false, spawned: false,
      ...(sid ? { seriesId: sid, estimated: !!est } : {}), ...(x.ref ? { ref: x.ref } : {}),
      createdAt: new Date().toISOString(), history: []
    });
  }
}

// ---------------- Pending view ----------------
VIEWS.pending = () => {
  const seg = ui.pendingSeg;
  return pendingRec();
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
let menuOpen = false;
function openMenu() {
  const d = S.settings.drive, ym = today().slice(0, 7);
  const bad = d.connected && d.needsReconnect, off = !d.connected;
  const status = d.connected
    ? `<b>${esc(d.email || 'Google Drive')}</b><span>${bad ? 'Backup paused · tap to reconnect' : d.lastBackup ? 'Backed up ' + fmtShort(d.lastBackup.slice(0, 10)) + ', ' + new Date(d.lastBackup).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'Backup on'}</span>`
    : `<b>Backup not set up</b><span>${S.settings.lastBackup ? 'Last file backup ' + fmtShort(S.settings.lastBackup.slice(0, 10)) : 'Your data is only on this phone'}</span>`;
  const bt = budgetRows(ym).rows.find(x => x.k === 'total');
  const ab = accountBalances(), cash = r2(Object.values(ab).reduce((a, b) => a + b, 0));
  const here = v => (cur.v === v ? ' on' : '');
  const it = (v, icon, label, meta, act) => `<button class="dr-item${here(v)}" ${act || `data-act="go" data-v="${v}"`}>${svgIcon(icon)}<span class="dr-l">${label}</span>${meta !== '' && meta != null ? `<span class="dr-m">${meta}</span>` : ''}</button>`;
  $('#menuPanel').innerHTML = `<div class="dr-head">
      <div class="dr-brand"><img src="icon.svg?v=41.1" alt="" width="36" height="36"><div><b>Hisaab</b><span>Your money and people</span></div></div>
      <button class="dr-acct ${bad || off ? 'warn' : ''}" data-act="go" data-v="backup"><span class="ico av">${svgIcon('cloud')}</span><span class="dr-acct-t">${status}</span>${bad || off ? '<span class="dr-dot"></span>' : ''}</button>
    </div>
    <nav class="dr-nav" aria-label="Menu">
      <div class="dr-sec">Money</div>
      ${it('budgets', 'pie', 'Budgets', bt ? (bt.left >= 0 ? shortMoney(bt.left) + ' left' : '<span class="danger">' + shortMoney(-bt.left) + ' over</span>') : 'Set up')}
      ${it('accounts', 'wallet', 'Accounts', shortMoney(cash))}
      ${it('entries', 'list', 'All entries', live().length, 'data-act="goEntries" data-filter=""')}
      ${(S.trash || []).length ? it('trash', 'back', 'Recently deleted', S.trash.length) : ''}
      <div class="dr-sep"></div><div class="dr-sec">Organise</div>
      ${it('works', 'folder', 'Projects', S.works.filter(w => !w.closed).length || '')}
      ${it('books', 'grid', 'Areas', S.books.length)}
      ${it('cats', 'tag', 'Categories', S.categories.length)}
      <div class="dr-sep"></div><div class="dr-sec">App</div>
      ${it('backup', 'cloud', 'Backup & restore', bad ? '<span class="danger">Paused</span>' : d.connected ? 'On' : '<span class="warn">Off</span>')}
      ${it('security', 'shield', 'App lock', S.settings.pinHash ? 'On' : 'Off')}
      ${S.settings.pinHash ? it('lockNow', 'lock', 'Lock now', '', 'data-act="lockNow"') : ''}
      ${it('prefs', 'gear', 'Preferences', '')}
      ${it('help', 'help', 'How to use', '')}
    </nav>
    <p class="dr-foot">Data stays on this phone${DB.ok ? '' : ' (limited storage)'} · v41.1</p>`;
  $('#menu').hidden = false; menuOpen = true; pushHist();
  requestAnimationFrame(() => $('#menu').classList.add('open'));
}
// mode: 'pop' = phone Back (history already moved), 'item' = a menu item was tapped (its screen reuses the menu's history entry), else tap outside
function closeMenu(mode) {
  if (!menuOpen) return;
  menuOpen = false; const m = $('#menu'); m.classList.remove('open'); m.hidden = true;
  if (mode === 'item') reuseHist = true;
  else if (mode !== 'pop') dropHist();
}
VIEWS.more = () => {
  const lb = S.settings.lastBackup;
  const item = (v, t, s) => `<button class="list-item" data-act="go" data-v="${v}"><div class="li-main"><div class="li-title">${t}</div><div class="li-sub">${s}</div></div>›</button>`;
  const ab = accountBalances();
  return `<div class="mn-h">Money</div><div class="card flush">
    ${(() => { const r = budgetRows(today().slice(0, 7)).rows.find(x => x.k === 'total'); const n = budgetRows(today().slice(0, 7)).rows.length; return item('budgets', 'Budgets', !n ? 'Set a monthly limit' : r ? (r.left >= 0 ? money(r.left) + ' left this month' : money(-r.left) + ' over this month') : n + ' budget' + (n > 1 ? 's' : '')); })()}
    ${item('accounts', 'Accounts & balance check', `${S.accounts.length} accounts · total ${money(Object.values(ab).reduce((a, b) => a + b, 0))}`)}
    <button class="list-item" data-act="goEntries" data-filter=""><div class="li-main"><div class="li-title">All entries</div><div class="li-sub">${live().length} entries · search and filter</div></div>›</button>
  </div>
  <div class="mn-h">Organise</div><div class="card flush">
    ${item('works', 'Projects', `${S.works.filter(w => !w.closed).length} open · a job, site or event`)}
    ${item('templates', 'Quick templates', `${S.templates.length} saved`)}
    ${item('books', 'Areas', (S.books.map(b => b.name).join(', ') || 'None') + ' · split your spending')}
    ${item('cats', 'Categories', `${S.categories.length} categories`)}
  </div>
  <div class="mn-h">App</div><div class="card flush">
    ${item('backup', 'Backup & restore', S.settings.drive.connected ? (S.settings.drive.needsReconnect ? 'Google Drive: reconnect needed' : 'Google Drive auto backup on' + (S.settings.drive.lastBackup ? ' · ' + fmtDate(S.settings.drive.lastBackup.slice(0, 10)) : '')) : lb ? 'Last backup ' + fmtDate(lb.slice(0, 10)) : 'Never backed up')}
    ${item('security', 'App lock', S.settings.pinHash ? 'PIN is on' + (S.settings.bioId ? ' · fingerprint' : '') : 'Off')}
    ${S.settings.pinHash ? `<button class="list-item" data-act="lockNow"><div class="li-main"><div class="li-title">Lock now</div></div>${svgIcon('lock')}</button>` : ''}
    ${item('prefs', 'Preferences', `${THEME_LBL[S.settings.theme] || THEME_LBL.system} · ${(TEXT_SIZES.find(x => x[0] === Number(S.settings.textSize)) || TEXT_SIZES[1])[1]} text · ${esc(S.settings.currency || 'Rs')} · ${S.settings.numStyle === 'intl' ? 'International' : 'Lakh'}`)}
    ${item('help', 'How to use Hisaab', 'Simple steps and examples for every situation')}
  </div>
  <p class="muted small mt">Data is stored only on this device${DB.ok ? '' : ' (limited storage mode)'}. Back up regularly.</p>`;
};

VIEWS.budgets = () => {
  const ym = today().slice(0, 7), { rows, frac, dim } = budgetRows(ym);
  const daysLeft = dim - Number(today().slice(8, 10));
  const row = r => `<button class="bud ${r.state}" data-act="editBudget" data-k="${r.k}" data-id="${r.id}">
    <div class="bud-top">${r.k === 'cat' ? svgIcon(catIcon(r.label)) : ''}<span class="grow">${esc(r.label)}</span><b>${money(r.spent)}</b><span class="muted small">&nbsp;of ${money(r.budget)}</span></div>
    <div class="bar"><i style="width:${Math.min(100, r.pct * 100)}%"></i>${frac > 0 && frac < 1 ? `<em style="left:${frac * 100}%"></em>` : ''}</div>
    <div class="bud-sub">${r.left >= 0 ? money(r.left) + ' left' : `<span class="danger">${money(-r.left)} over</span>`}${r.state === 'fast' ? ' · spending faster than the month' : r.state === 'near' ? ' · almost used' : ''}</div>
  </button>`;
  const total = rows.find(r => r.k === 'total'), others = rows.filter(r => r.k !== 'total');
  return `<p class="muted small" style="margin:0 2px 12px">${monthLabel(ym)} · ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left. The line on each bar shows how far through the month you are.</p>
  ${total ? row(total) + (total.left > 0 && daysLeft > 0 ? `<p class="bud-day">About <b>${money(Math.floor(total.left / (daysLeft + 1)))}</b> a day for the rest of ${monthLabel(ym).split(' ')[0]} keeps you inside the budget.</p>` : total.left <= 0 ? `<p class="bud-day danger">Budget used up. Every rupee from now is over.</p>` : '') : `<button class="bud empty-b" data-act="editBudget" data-k="total"><b>Set a monthly budget</b><span class="muted small">A limit for all your own spending each month</span></button>`}
  ${others.length ? `<div class="sec-title">By category and area</div>${others.sort((a, b) => b.pct - a.pct).map(row).join('')}` : ''}
  <button class="btn block mt" data-act="editBudget">+ Budget for a category or area</button>
  <p class="muted small mt">Budgets count only your own spending, the same as "Spent" on Home. Money you paid for others is not included.</p>`;
};
function openBudgetSheet(k, id) {
  const B = S.budgets, cur = k === 'total' ? B.total : k ? (B[k] || {})[id] : '';
  const cats = S.categories.filter(c => c.kind === 'out');
  const sel = k ? `${k}:${id}` : '';
  const opts = `<option value="">Choose…</option><option value="total:" ${sel === 'total:' ? 'selected' : ''}>All spending (monthly total)</option>
    <optgroup label="Areas">${S.books.map(b => `<option value="book:${b.id}" ${sel === 'book:' + b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</optgroup>
    <optgroup label="Categories">${cats.map(c => `<option value="cat:${c.id}" ${sel === 'cat:' + c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`;
  openSheet(`${sheetHead(k ? 'Edit budget' : 'New budget')}
    <div class="field"><label>Budget for</label><select id="bFor" ${k ? 'disabled' : ''}>${opts}</select></div>
    <div class="field"><label>Monthly limit</label><input id="bAmt" inputmode="decimal" value="${cur ? esc(String(cur)) : ''}" placeholder="e.g. 40000"></div>
    <button class="btn primary block" data-act="saveBudget">Save</button>
    ${k && cur ? `<button class="link danger addnext" data-act="removeBudget" data-k="${k}" data-id="${id}">Remove this budget</button>` : ''}`);
  setTimeout(() => $('#bAmt')?.focus(), 60);
}
VIEWS.prefs = () => {
  const st = S.settings, ts = TEXT_SIZES.find(x => x[0] === Number(st.textSize)) || TEXT_SIZES[1];
  const row = (k, t, v) => `<button class="list-item" data-act="prefSheet" data-k="${k}"><div class="li-main"><div class="li-title">${t}</div></div><span class="muted">${v}</span><span class="chev" aria-hidden="true">›</span></button>`;
  return `<div class="card flush">
    ${row('theme', 'Appearance', THEME_LBL[st.theme] || THEME_LBL.system)}
    ${row('text', 'Text size', ts[1])}
  </div>
  <div class="card flush">
    ${row('cur', 'Currency symbol', esc(st.currency || 'Rs'))}
    ${row('num', 'Number style', st.numStyle === 'intl' ? '1,250,000' : '12,50,000')}
  </div>
  <p class="muted small mt">Tip: long-press the Hisaab icon on your home screen for shortcuts to Add expense, Bills and People.</p>`;
};
function openPrefSheet(k) {
  const st = S.settings;
  const opt = (v, label, on, style = '') => `<button class="opt ${on ? 'on' : ''}" data-act="setPref" data-k="${k}" data-v="${esc(String(v))}" ${style}>${label}</button>`;
  let title = '', body = '';
  if (k === 'theme') { title = 'Appearance'; body = Object.entries(THEME_LBL).map(([v, l]) => opt(v, l, (st.theme || 'system') === v)).join(''); }
  if (k === 'text') { title = 'Text size'; body = TEXT_SIZES.map(([v, l]) => opt(v, `<span style="font-size:${Math.round(15 * v)}px">${l} · Spent Rs 21,300</span>`, Number(st.textSize || 1) === v)).join(''); }
  if (k === 'cur') { title = 'Currency symbol'; body = CURRENCIES.map(c => opt(c, `${esc(c)} 1,250`, (st.currency || 'Rs') === c)).join(''); }
  if (k === 'num') { title = 'Number style'; body = opt('lakh', 'Lakh · 12,50,000', st.numStyle !== 'intl') + opt('intl', 'International · 1,250,000', st.numStyle === 'intl'); }
  openSheet(`${sheetHead(title)}<div class="optlist">${body}</div>`);
}
// Effect of one entry on one account (+ in, − out, 0 none) — same rules as accountBalances
function accEffect(e, id) {
  const a = e.amount;
  switch (e.type) {
    case 'income': case 'borrowed': case 'received': case 'recovery': return e.accountId === id ? a : 0;
    case 'expense': case 'recoverable': return !e.viaPersonId && e.accountId === id ? -a : 0;
    case 'lent': case 'advance': case 'repaid': return e.accountId === id ? -a : 0;
    case 'transfer': return (e.accountId === id ? -a : 0) + (e.toAccountId === id ? a : 0);
    case 'adjustment': return e.accountId === id ? a : 0;
  }
  return 0;
}
VIEWS.accounts = () => {
  const ab = accountBalances(), tot = r2(Object.values(ab).reduce((x, y) => x + y, 0));
  return `<div class="psum">Total in all accounts <b>${money(tot)}</b></div>
  <div class="row" style="margin-bottom:10px"><button class="btn grow" data-act="quickType" data-type="transfer">Transfer</button><button class="btn primary" data-act="editAccount">+ Account</button></div>
  <div class="list">${S.accounts.map(a => `<button class="list-item" data-act="go" data-v="account" data-p="${a.id}">
    <span class="ico av" aria-hidden="true">${svgIcon('wallet')}</span>
    <div class="li-main"><div class="li-title">${esc(a.name)}</div></div>
    <div class="li-amt ${(ab[a.id] || 0) < 0 ? 'danger' : ''}">${money(ab[a.id] || 0)}</div><span class="chev" aria-hidden="true">›</span></button>`).join('') || '<div class="empty">No accounts.</div>'}</div>
  <p class="muted small mt">Tap an account for its statement with the balance after every entry. Check it against your bank app once a month; if it differs, use <b>Fix balance</b> there.</p>`;
};
VIEWS.account = (id) => {
  const a = acc(id); if (!a) return '<div class="empty">Not found.</div>';
  if (ui.accFor !== id) { ui.accFor = id; ui.accMonth = null; }
  const ym = ui.accMonth || today().slice(0, 7), [f, to] = monthBounds(ym);
  const rows = live().filter(e => accEffect(e, id) !== 0).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.createdAt || '') < (y.createdAt || '') ? -1 : 1));
  let bal = Number(a.opening) || 0, open = null; const inMonth = [];
  for (const e of rows) { if (e.date < f) { bal = r2(bal + accEffect(e, id)); continue; } if (open === null) open = bal; bal = r2(bal + accEffect(e, id)); if (e.date <= to) inMonth.push({ e, bal }); }
  if (open === null) open = bal;
  const close = inMonth.length ? inMonth[inMonth.length - 1].bal : open;
  const inT = r2(inMonth.reduce((x, r) => x + Math.max(0, accEffect(r.e, id)), 0)), outT = r2(inMonth.reduce((x, r) => x + Math.max(0, -accEffect(r.e, id)), 0));
  const now = accountBalances()[id] || 0, isNow = ym === today().slice(0, 7);
  let lastD = '', list = '';
  for (const r of inMonth.slice().reverse()) {
    if (r.e.date !== lastD) { list += `<div class="pj-month">${fmtDate(r.e.date)}</div>`; lastD = r.e.date; }
    const v = accEffect(r.e, id);
    list += `<button class="list-item" data-act="openEntry" data-id="${r.e.id}">${entryIcon(r.e)}<div class="li-main"><div class="li-title">${esc(entryTitle(r.e))}</div><div class="li-sub">${esc(entrySub(r.e))}</div></div>
      <div class="li-amt ${v > 0 ? 'in' : 'out'}">${v > 0 ? '+' : '−'}${money(Math.abs(v))}<div class="li-sub">bal ${money(r.bal)}</div></div></button>`;
  }
  return `<div class="phero"><span class="ico av lg" aria-hidden="true">${svgIcon('wallet')}</span>
    <div class="grow"><h2>${esc(a.name)}</h2><div class="muted small">Opening ${money(a.opening || 0)}</div>
    <div class="hlinks"><button class="link" data-act="balanceCheck" data-id="${id}">Fix balance</button><span>·</span><button class="link" data-act="editAccount" data-id="${id}">Edit</button><span>·</span><button class="link" data-act="exportAcc" data-id="${id}">Export</button></div></div></div>
  <div class="pbal"><span class="lbl">Balance now</span><b class="${now < 0 ? 'out' : ''}">${money(now)}</b></div>
  <div class="iv-month"><button class="icon-btn" data-act="accMonth" data-n="-1" aria-label="Previous month">‹</button><b>${monthLabel(ym)}</b><button class="icon-btn" data-act="accMonth" data-n="1" aria-label="Next month" ${isNow ? 'disabled' : ''}>›</button></div>
  <div class="iv-stats pj-stats"><div><span>Start</span><b>${money(open)}</b></div><div><span>In</span><b class="in">${money(inT)}</b></div><div><span>Out</span><b class="out">${money(outT)}</b></div></div>
  <div class="psum" style="margin-top:-4px">End of ${monthLabel(ym).split(' ')[0]}: <b>${money(close)}</b></div>
  <div class="list">${list || '<div class="empty">No money moved in or out this month.</div>'}</div>`;
};

function simpleList(kind, items, sub, colored) {
  return `<button class="btn block" style="margin-bottom:12px" data-act="editSimple" data-kind="${kind}">+ Add</button>
  <div class="card flush">${items.map(x => `<button class="list-item" data-act="editSimple" data-kind="${kind}" data-id="${x.id}">
    ${colored ? `<span class="ico sq">${svgIcon(catIcon(x.name))}</span>` : ''}
    <div class="li-main"><div class="li-title">${esc(x.name)}</div>${sub ? `<div class="li-sub">${sub(x)}</div>` : ''}</div>›</button>`).join('') || '<div class="empty">None yet.</div>'}</div>`;
}
// Areas, categories and projects share one list design: what it is, how many entries, this month's amount.
function groupRows(kind, items, o) {
  return `<div class="card flush">${items.map(x => {
    const n = o.count(x), v = o.month(x);
    return `<div class="list-item gl-row">${o.icon ? `<span class="ico sq">${svgIcon(catIcon(x.name))}</span>` : `<span class="ico gl-av">${esc((x.name || '?').trim()[0] || '?').toUpperCase()}</span>`}
      <button class="li-main gl-main" ${o.open(x)}><div class="li-title">${esc(x.name)}</div><div class="li-sub">${n} ${n === 1 ? 'entry' : 'entries'}${v ? ` · <b>${money(v)}</b> this month` : ''}</div></button>
      <button class="icon-btn gl-edit" data-act="editSimple" data-kind="${kind}" data-id="${x.id}" aria-label="Edit ${esc(x.name)}">${svgIcon('pencil')}</button></div>`;
  }).join('') || '<div class="empty">None yet.</div>'}</div>`;
}
function groupHead(kind, label) { return `<div class="sec-title">${label}<button data-act="editSimple" data-kind="${kind}">+ Add</button></div>`; }
VIEWS.books = () => {
  const m = spendMonth(today().slice(0, 7)).byBook;
  return `<p class="muted small" style="margin:0 2px 4px">Areas split your spending so you can compare, for example Home vs Office vs Car. Tap one to see its entries.</p>
    ${groupHead('book', 'Areas')}${groupRows('book', S.books, { count: b => live().filter(e => e.bookId === b.id).length, month: b => m[b.id] || 0, open: b => `data-act="insBook" data-b="${b.id}"` })}`;
};
VIEWS.cats = () => {
  const ym = today().slice(0, 7), m = spendMonth(ym).byCat, [f, to] = monthBounds(ym);
  const inc = {}; live().forEach(e => { if (e.type === 'income' && e.date >= f && e.date <= to) inc[e.categoryId] = r2((inc[e.categoryId] || 0) + e.amount); });
  const cnt = c => live().filter(e => e.categoryId === c.id).length;
  const o = (mm) => ({ icon: true, count: cnt, month: c => mm[c.id] || 0, open: c => `data-act="catEntries" data-c="${c.id}"` });
  const byUse = list => list.slice().sort((a, b) => (m[b.id] || inc[b.id] || 0) - (m[a.id] || inc[a.id] || 0) || cnt(b) - cnt(a));
  return `${groupHead('catout', 'Spending')}${groupRows('catout', byUse(S.categories.filter(c => c.kind === 'out' && !c.bill)), o(m))}
    ${groupHead('catbill', 'Bill types')}${groupRows('catbill', byUse(S.categories.filter(c => c.bill)), o(m))}
    ${groupHead('catin', 'Income')}${groupRows('catin', byUse(S.categories.filter(c => c.kind === 'in')), o(inc))}`;
};

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
VIEWS.works = () => {
  const q = (ui.projQ || '').trim().toLowerCase(), pf = ui.projF || 'open', ym = today().slice(0, 7);
  const rows = S.works.map(w => ({ w, st: workStats(w.id) }));
  const nOpen = rows.filter(r => !r.w.closed).length, nDone = rows.length - nOpen;
  const list = rows.filter(r => pf === 'all' || (pf === 'open' ? !r.w.closed : r.w.closed)).filter(r => !q || (r.w.name + ' ' + (r.w.ref || '')).toLowerCase().includes(q))
    .sort((a, b) => { const la = a.st.entries.reduce((x, e) => (e.date > x ? e.date : x), ''), lb = b.st.entries.reduce((x, e) => (e.date > x ? e.date : x), ''); return (lb > la ? 1 : lb < la ? -1 : 0) || a.w.name.localeCompare(b.w.name); });
  const openRows = rows.filter(r => !r.w.closed), tot = r2(openRows.reduce((a, r) => a + r.st.total, 0)), pend = r2(openRows.reduce((a, r) => a + r.st.recPending, 0));
  return `
  <div class="chips" style="margin-bottom:8px">${[['open', 'Open', nOpen], ['done', 'Finished', nDone], ['all', 'All', rows.length]].map(([k, l, n]) => `<button class="chip ${pf === k ? 'on' : ''}" data-act="projF" data-v="${k}">${l} (${n})</button>`).join('')}</div>
  <div class="psum">Spent on open projects <b>${money(tot)}</b>${pend ? ` · To get back <b class="in">${money(pend)}</b>` : ''}</div>
  <div class="row" style="margin-bottom:10px">
    <input class="inp grow" placeholder="Search projects" value="${esc(ui.projQ || '')}" data-ui="projQ">
    <button class="btn primary" data-act="editWork">+ Project</button>
  </div>
  <div class="list">${list.length ? list.map(projRow).join('')
    : `<div class="empty">${q ? 'No match.' : pf === 'done' ? 'No finished projects.' : 'No projects yet. Tap + Project to group the costs of one job, site or event.'}</div>`}</div>`;
};

// Vehicle projects: fuel log from litres + odometer on entries
function vehicleHtml(st) {
  const es = st.entries.filter(e => e.type === 'expense' || e.type === 'recoverable');
  const reads = es.filter(e => e.odo > 0).sort((a, b) => a.odo - b.odo);
  const fills = es.filter(e => e.litres > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.odo || 0) - (b.odo || 0)));
  const litres = r2(fills.reduce((a, e) => a + e.litres, 0)), fuelCost = r2(fills.reduce((a, e) => a + e.amount, 0));
  const km = reads.length >= 2 ? reads[reads.length - 1].odo - reads[0].odo : 0;
  const usedL = r2(fills.filter(e => e.odo > reads[0]?.odo).reduce((a, e) => a + e.litres, 0));
  const kmpl = km && usedL ? km / usedL : 0, perKm = km ? st.total / km : 0;
  if (!fills.length && !reads.length) return `<section class="iv-card"><div class="iv-h">Vehicle</div><p class="muted small">When you add fuel for this project, type the <b>litres</b> and the <b>odometer</b> reading. You will see km per litre, cost per km and a fuel log here.</p></section>`;
  let prev = null; const log = fills.slice().map(e => { const r = { e, dkm: prev && e.odo && prev.odo ? e.odo - prev.odo : 0 }; if (e.odo) prev = e; return r; }).reverse().slice(0, 12);
  return `<section class="iv-card"><div class="iv-h">Vehicle</div>
    <div class="iv-tiles">
      <div class="iv-tile"><span class="iv-tl">Km per litre</span><b>${kmpl ? kmpl.toFixed(1) : '—'}</b><span class="iv-tm"><span>${kmpl ? 'average' : 'needs 2 readings'}</span></span></div>
      <div class="iv-tile"><span class="iv-tl">Cost per km</span><b>${perKm ? money(Math.round(perKm * 10) / 10) : '—'}</b><span class="iv-tm"><span>all costs</span></span></div>
      <div class="iv-tile"><span class="iv-tl">Km driven</span><b>${km ? km.toLocaleString('en-PK') : '—'}</b><span class="iv-tm"><span>${reads.length ? 'last ' + reads[reads.length - 1].odo.toLocaleString('en-PK') : ''}</span></span></div>
      <div class="iv-tile"><span class="iv-tl">Fuel</span><b>${litres} L</b><span class="iv-tm"><span>${litres ? money(Math.round(fuelCost / litres)) + ' / L' : ''}</span></span></div>
    </div>
    ${log.length ? `<div class="veh-log">${log.map(({ e, dkm }) => `<button class="veh-row" data-act="openEntry" data-id="${e.id}"><span>${fmtShort(e.date)}</span><span>${e.litres} L</span><span>${e.odo ? e.odo.toLocaleString('en-PK') + ' km' : '—'}</span><span>${dkm > 0 ? (dkm / e.litres).toFixed(1) + ' km/L' : ''}</span><b>${money(e.amount)}</b></button>`).join('')}</div>` : ''}
  </section>`;
}
// Project page: name, total, what needs doing, entries. Charts live one tap away (Breakdown).
VIEWS.work = (wid) => {
  const w = work(wid);
  if (!w) return '<div class="empty">Not found.</div>';
  const st = workStats(wid), withPeople = Math.max(0, r2(st.adv - st.viaStaff)), budget = Number(w.budget) || 0;
  const facts = [st.recPending ? `<div class="kv"><span>Still to get back</span><b class="in">${money(st.recPending)}</b></div>` : '',
    withPeople ? `<div class="kv"><span>Cash still with your people</span><b class="warn">${money(withPeople)}</b></div>` : '',
    budget ? `<div class="kv"><span>Estimate ${money(budget)}</span><b class="${st.total > budget ? 'out' : ''}">${st.total > budget ? money(r2(st.total - budget)) + ' over' : money(r2(budget - st.total)) + ' left'}</b></div>` : ''].filter(Boolean).join('');
  const ents = [...st.entries].sort(sortDesc);
  let lastM = '', hist = '';
  for (const e of ents) { const m = e.date.slice(0, 7); if (m !== lastM) { hist += `<div class="pj-month">${monthLabel(m)}</div>`; lastM = m; } hist += entryItem(e); }
  const openRec = live().some(e => e.type === 'recoverable' && e.workId === wid && recInfo(e).remaining > 0);
  return `<div class="phero">
    <span class="ico av lg" aria-hidden="true">${esc((w.name.trim()[0] || '?').toUpperCase())}</span>
    <div class="grow"><h2>${esc(w.name)}</h2>
      <div class="muted small">${[w.ref ? 'Ref ' + esc(w.ref) : '', w.closed ? 'Finished' : '', w.vehicle ? 'Vehicle' : ''].filter(Boolean).join(' · ')}</div>
      <div class="hlinks"><button class="link" data-act="editWork" data-id="${wid}">Edit</button><span>·</span><button class="link" data-act="shareWork" data-p="${wid}">Share</button><span>·</span><button class="link" data-act="printWork" data-p="${wid}">PDF</button></div></div>
  </div>
  <div class="pbal"><span class="lbl">Spent on this project</span><b>${money(st.total)}</b></div>
  ${facts ? `<div class="card pj-facts">${facts}</div>` : ''}
  <div class="pills pfit">
    <button class="pill primary" data-act="addToWork" data-p="${wid}">+ Spent</button>
    <button class="pill" data-act="giveForWork" data-p="${wid}">Gave to spend</button>
    ${openRec ? `<button class="pill" data-act="recoverWork" data-p="${wid}">Got paid back</button>` : ''}
  </div>
  ${st.entries.length ? `<button class="list-item card pj-more" data-act="go" data-v="workmore" data-p="${wid}"><div class="li-main"><div class="li-title">${w.vehicle ? 'Breakdown and fuel log' : 'Breakdown'}</div><div class="li-sub">${w.vehicle ? 'km per litre, cost per km, ' : ''}what it went on, month by month</div></div><span class="chev">›</span></button>` : ''}
  <div class="list">${hist || '<div class="empty">Nothing linked yet. Tap “+ Spent”, or pick this project on the Add screen.</div>'}</div>
  <div class="linkrow minor mt"><button class="link" data-act="toggleWorkDone" data-p="${wid}">${w.closed ? 'Reopen project' : 'Mark as finished'}</button></div>`;
};
VIEWS.workmore = (wid) => {
  const w = work(wid);
  if (!w) return '<div class="empty">Not found.</div>';
  const st = workStats(wid), ym = today().slice(0, 7), [f, to] = monthBounds(ym);
  const withPeople = Math.max(0, r2(st.adv - st.viaStaff));
  const month = r2(st.entries.filter(e => (e.type === 'expense' || e.type === 'recoverable') && e.date >= f && e.date <= to).reduce((a, e) => a + e.amount, 0));
  const kv = (k, v, cls = '') => `<div class="kv"><span>${k}</span><b class="${cls}">${v}</b></div>`;
  const byCat = {};
  for (const e of st.entries) if (e.type === 'expense' || e.type === 'recoverable') byCat[e.categoryId || '_none'] = r2((byCat[e.categoryId || '_none'] || 0) + e.amount);
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const top = cats.slice(0, cats.length > IV_SLOTS + 1 ? IV_SLOTS : IV_SLOTS + 1), rest = cats.slice(top.length), restV = r2(rest.reduce((a, c) => a + c[1], 0));
  const slices = top.map(([id, v], i) => ({ id, v, name: catName(id), color: id.startsWith('_') ? 'var(--c-other)' : `var(--c${(i % IV_SLOTS) + 1})` }));
  if (restV) slices.push({ id: '_rest', v: restV, name: rest.length + ' more', color: 'var(--c-other)' });
  const byM = {}; for (const e of st.entries) if (e.type === 'expense' || e.type === 'recoverable') byM[e.date.slice(0, 7)] = r2((byM[e.date.slice(0, 7)] || 0) + e.amount);
  const ms = Object.keys(byM).sort(), months = ms.length ? (() => { const out = []; for (let m = ms[0]; m <= ms[ms.length - 1]; m = shiftYm(m, 1)) out.push({ m, v: byM[m] || 0 }); return out.slice(-12); })() : [];
  return `<div class="iv-body">
    <div class="card pj-facts">
      ${kv('Spent in total', money(st.total))}
      ${kv(monthLabel(ym).split(' ')[0], money(month))}
      ${st.rec ? kv('My own money', money(st.own)) + kv('To be repaid to me', money(st.rec)) + kv('Still to get back', money(st.recPending), st.recPending ? 'in' : '') : ''}
      ${st.adv ? kv('Given to people to spend', money(st.adv)) + kv('Cash still with them', money(withPeople), withPeople ? 'warn' : '') : ''}
      ${Number(w.budget) ? kv('Estimate', `${money(w.budget)} · ${Math.round(st.total / w.budget * 100)}% used`, st.total > w.budget ? 'out' : '') : ''}
    </div>
    ${w.vehicle ? vehicleHtml(st) : ''}
    ${cats.length ? `<section class="iv-card"><div class="iv-h">What it went on</div>${cats.length > 1 ? `<div class="iv-donut-wrap">${ivDonut(slices, st.total)}</div>` : ''}
      <div class="iv-list">${slices.map(sl => `<div class="iv-row"><i class="iv-sw" style="background:${sl.color}"></i><span class="grow"><span class="iv-rn">${esc(sl.name)}</span></span><span class="iv-rv"><b>${money(sl.v)}</b><span>${Math.round(sl.v / st.total * 100)}%</span></span></div>`).join('')}</div></section>` : ''}
    ${months.length >= 2 ? `<section class="iv-card"><div class="iv-h">Month by month</div>${ivColumns(months, months[months.length - 1].m)}</section>` : ''}
  </div>`;
};

VIEWS.templates = () => `<div class="card flush">${S.templates.map(t => `<div class="list-item">
  <div class="li-main"><div class="li-title">${esc(t.name)}</div><div class="li-sub">${typeLabel(t.data.type)}${t.data.amount ? ' · ' + money(t.data.amount) : ''}</div></div>
  <button class="btn sm" data-act="renameTpl" data-id="${t.id}">Rename</button> <button class="btn sm danger" data-act="delTpl" data-id="${t.id}">Delete</button></div>`).join('') || '<div class="empty">No templates. On the Add screen, tick "Save as quick template".</div>'}</div>`;

function filteredEntries(F) {
  let list = S.entries.filter(e => F.drafts ? e.draft : !e.draft);
  if (!F.drafts) {
    if (F.month) list = list.filter(e => e.date.slice(0, 7) === F.month || (F.spentOnly && e.writtenOff && e.writtenOff.date.slice(0, 7) === F.month));
    else if (F.from) { const inR = d => d >= F.from && d <= F.to; list = list.filter(e => F.spentOnly && e.type === 'recoverable' ? (e.writtenOff && inR(e.writtenOff.date)) : inR(e.date)); }
    if (F.spentOnly) list = list.filter(e => e.type === 'expense' || (e.type === 'recoverable' && e.writtenOff && (!F.month || e.writtenOff.date.slice(0, 7) === F.month)) || (e.type === 'adjustment' && e.amount < 0));
    if (F.type) list = list.filter(e => e.type === F.type);
    if (F.book) list = list.filter(e => e.bookId === F.book);
    if (F.person) list = list.filter(e => e.personId === F.person || e.viaPersonId === F.person || e.spentOn === F.person);
    if (F.work) list = list.filter(e => e.workId === F.work);
    if (F.cat) list = list.filter(e => catOf(e) === F.cat);
    if (F.special && DC_PRED[F.special]) list = list.filter(DC_PRED[F.special]);
    if (F.type !== 'expected') list = list.filter(e => !(e.type === 'expected' && expectedInfo(e).closed));
  }
  if (F.q) { const q = F.q.toLowerCase(); list = list.filter(e => (entryTitle(e) + ' ' + entrySub(e) + ' ' + e.amount + ' ' + (e.txId || '') + ' ' + (e.ref || '')).toLowerCase().includes(q)); }
  list.sort(sortDesc);
  return list;
}
VIEWS.entries = () => {
  const F = ui.entryFilter || (ui.entryFilter = { month: today().slice(0, 7), type: '', book: '', person: '', work: '', q: '', drafts: false, spentOnly: false });
  const list = filteredEntries(F);
  const chip = (k, label) => `<button class="ef-chip on" data-act="efDrop" data-k="${k}" aria-label="Remove filter ${esc(label)}">${esc(label)}<span aria-hidden="true">×</span></button>`;
  const active = [];
  if (F.drafts) active.push(chip('drafts', 'Incomplete receipts'));
  if (F.spentOnly) active.push(chip('spentOnly', 'Own spending'));
  if (F.cat) active.push(chip('cat', catName(F.cat)));
  if (F.special) active.push(chip('special', DC_LBL[F.special] || F.special));
  if (F.type) active.push(chip('type', typeLabel(F.type)));
  if (F.book) active.push(chip('book', bookName(F.book)));
  if (F.person && person(F.person)) active.push(chip('person', person(F.person).name));
  if (F.work && work(F.work)) active.push(chip('work', work(F.work).name));
  const nMore = [F.type, F.book, F.person, F.work, F.cat].filter(Boolean).length;
  const selOn = !!ui.selMode, sel = ui.sel || (ui.sel = new Set());
  const vb = F.book && book(F.book) && book(F.book).vehicle ? book(F.book) : null;
  const live0 = list.filter(e => e.type !== 'expected');
  const outT = r2(live0.filter(e => entryFlow(e) === 'out').reduce((x, e) => x + Math.abs(e.type === 'recoverable' && F.spentOnly && e.writtenOff ? e.writtenOff.amount : e.amount), 0));
  const inT = r2(live0.filter(e => entryFlow(e) === 'in').reduce((x, e) => x + Math.abs(e.amount), 0));
  const period = F.drafts ? '' : F.month ? `<div class="ef-month"><button class="icon-btn" data-act="efMonth" data-n="-1" aria-label="Previous month">‹</button>
      <label class="ef-mlabel"><b>${monthLabel(F.month)}</b><input type="month" value="${esc(F.month)}" data-ef="month" aria-label="Pick month"></label>
      <button class="icon-btn" data-act="efMonth" data-n="1" aria-label="Next month" ${F.month >= today().slice(0, 7) ? 'disabled' : ''}>›</button></div>`
    : `<div class="ef-month"><span></span><b>${F.from ? esc(F.rangeLabel || fmtShort(F.from) + ' – ' + fmtShort(F.to)) : 'All dates'}</b><button class="link" data-act="efThisMonth">This month</button></div>`;
  return `<div class="ef-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input class="inp" type="search" placeholder="Search note, person, amount…" value="${esc(F.q)}" data-ef="q" aria-label="Search entries"></div>
  ${period}
  <div class="ef-chips">${F.drafts ? '' : `<button class="ef-chip filter ${nMore ? 'has' : ''}" data-act="efSheet"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>Filter${nMore ? ' · ' + nMore : ''}</button>`}${active.join('')}${F.month && !F.drafts ? `<button class="ef-chip" data-act="efAllTime">All dates</button>` : ''}</div>
  <div class="ef-sum"><span>${list.length} entr${list.length === 1 ? 'y' : 'ies'}</span>${list.length ? '<button class="link" data-act="exportEntries">Export</button>' : ''}${outT ? `<span>Out <b class="out">${money(outT)}</b></span>` : ''}${inT ? `<span>In <b class="in">${money(inT)}</b></span>` : ''}${active.length ? `<button class="link" data-act="clearEF">Clear all</button>` : ''}${list.length ? `<button class="link" data-act="selMode">${selOn ? 'Done' : 'Select'}</button>` : ''}</div>
  ${vb ? vehicleHtml({ entries: list, total: r2(list.filter(e => e.type === 'expense' || e.type === 'recoverable').reduce((a, e) => a + e.amount, 0)) }) : ''}
  ${selOn ? `<div class="selbar"><button class="link" data-act="selAll">${sel.size === list.length ? 'None' : 'All ' + list.length}</button><b>${sel.size} selected</b><button class="btn primary sm" data-act="bulkSheet" ${sel.size ? '' : 'disabled'}>Change…</button></div>` : ''}
  <div class="card flush">${list.length ? list.map(e => selOn ? entryItem(e).replace('class="list-item" data-act="openEntry"', `class="list-item selrow ${sel.has(e.id) ? 'on' : ''}" data-act="selToggle" aria-pressed="${sel.has(e.id)}"`) : entryItem(e)).join('') : `<div class="empty">No entries match.${active.length || F.q ? ' <button class="link" data-act="clearEF">Clear filters</button>' : ''}</div>`}</div>`;
};
function efSheetHtml() {
  const F = ui.entryFilter, types = [...TYPE_ORDER, 'recovery', 'adjustment'];
  const sel = (k, label, opts, none) => `<div class="field"><label>${label}</label><select data-ef="${k}" data-efsheet="1"><option value="">${none}</option>${opts}</select></div>`;
  const o = (list, v) => list.map(x => `<option value="${x.id}" ${v === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  return `${sheetHead('Filter entries')}
    ${sel('type', 'Type', types.map(t => `<option value="${t}" ${F.type === t ? 'selected' : ''}>${typeLabel(t)}</option>`).join(''), 'All types')}
    ${sel('cat', 'Category', o(S.categories, F.cat), 'All categories')}
    ${S.books.length ? sel('book', 'Area', o(S.books, F.book), 'All areas') : ''}
    ${S.people.length ? sel('person', 'Person', o(S.people, F.person), 'All people') : ''}
    ${S.works.length ? sel('work', 'Project / site', o(S.works, F.work), 'All projects') : ''}
    <label class="inline-check"><input type="checkbox" class="check" data-act="efSpent" ${F.spentOnly ? 'checked' : ''}> Only my own spending</label>
    <div class="btn-row mt"><button class="btn" data-act="efReset">Reset</button><button class="btn primary" data-act="closeSheet">Show ${'results'}</button></div>`;
}

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
  return `<div class="sec-title">Money coming in <button data-act="quickType" data-type="expected">+ Add</button></div>
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
    <button class="li-main" style="text-align:left" data-act="go" data-v="bill" data-p="${esc(billSid(e))}"><div class="li-title">${esc(entryTitle(e))}</div>
    <div class="li-sub ${od ? 'danger' : d <= 3 ? 'warn' : ''}">${od ? 'Overdue since ' + fmtShort(e.date) : d === 0 ? 'Due today' : 'Due ' + fmtShort(e.date)}${REPEAT_LBL[e.repeat] ? ' · ' + REPEAT_LBL[e.repeat] : ''}${e.estimated ? ' · estimate' : ''}</div></button>
    <div class="li-amt">${e.estimated ? '≈ ' : ''}${money(expectedInfo(e).rem)}<div><button class="btn sm" data-act="payExpected" data-id="${e.id}">Pay</button></div></div></div>`; };
  const unpaidHtml = unpaid.length ? `<div class="card flush">${unpaid.map(row).join('')}</div>`
    : `<div class="empty">${S.entries.some(e => e.type === 'expected' && e.direction === 'out') ? 'All bills paid ✓' : 'No bills yet. Add electricity, gas, internet, rent, or subscriptions like Netflix or ChatGPT.'}</div>`;
  const paidHtml = paid.length ? `<div class="card flush">${paid.map(e => entryItem(e)).join('')}</div>` : '<div class="empty">No bill payments yet.</div>';
  const counts = { unpaid: unpaid.length, paid: paid.length, mine: allBillSids().length };
  const ymNow = t.slice(0, 7);
  const leftM = r2(unpaid.filter(e => e.date <= ymNow + '-31').reduce((a, e) => a + expectedInfo(e).rem, 0));
  const paidM = r2(paid.filter(e => e.date.slice(0, 7) === ymNow).reduce((a, e) => a + e.amount, 0));
  const totM = r2(leftM + paidM), pct = totM ? Math.round(paidM / totM * 100) : 0;
  return `<div class="bsum">
    <div class="lbl">Bills this month</div>
    <div class="big">${money(totM)}</div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="bsum-sub"><span>${money(paidM)} paid</span><span>${overdue ? `<span class="danger">${overdue} overdue</span> · ` : ''}${money(leftM)} left</span></div>
  </div>
  <div class="bills-bar">
    <div class="chips">${[['unpaid', 'Unpaid'], ['paid', 'Paid'], ['mine', 'My bills']].map(([k, l]) => `<button class="chip ${filt === k ? 'on' : ''}" data-act="billFilt" data-v="${k}">${l}${counts[k] !== undefined ? ' (' + counts[k] + ')' : ''}</button>`).join('')}</div>
    <button class="btn primary sm" data-act="addBill" aria-label="Add bill">+ Add</button>
  </div>
  ${filt === 'unpaid' ? unpaidHtml : filt === 'paid' ? paidHtml : myBillsHtml()}
  ${filt === 'unpaid' ? incomeDueHtml() : ''}
  <p class="muted small mt">${filt === 'mine' ? 'Tap a bill to see every month: amounts, units, highest and lowest, and when you paid.' : 'Bill amount changes every month? The next bill is estimated from your history. Tap a bill to enter the real amount or see past months.'}</p>`;
}

// ---------------- Bank message → entry (share a bank SMS to Hisaab, or paste it) ----------------
const BANK_WORDS = /\s+(?:mobilink(?:\s+mfb)?|jazz\s*cash|easy\s*paisa|telenor(?:\s+bank)?|u\s*microfinance(?:\s+bank)?|khushhali(?:\s+bank)?|finca|hbl|mcb(?:\s+bank)?|ubl|meezan(?:\s+bank)?|allied(?:\s+bank)?|abl|bank\s+al[\s-]*falah|alfalah|faysal(?:\s+bank)?|askari(?:\s+bank)?|bop|nbp|national\s+bank|bank\s+al[\s-]*habib|habib\s+metro(?:\s+bank)?|js\s+bank|standard\s+chartered|soneri(?:\s+bank)?|summit(?:\s+bank)?|silk\s*bank|dubai\s+islamic(?:\s+bank)?|bank\s*islami|al\s*baraka|sadapay|nayapay|zindigi|mfb|bank)\s*$/i;
const MONTHS3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function titleCase(s) { return s.toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase()); }
function parseBankSms(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim(), r = { text };
  const am = text.match(/(?:PKR|Rs\.?|RS)\s*:?\s*([\d,]+(?:\.\d{1,2})?)/i) || text.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:PKR|Rs\.?)/i);
  if (am) r.amount = Math.round(parseFloat(am[1].replace(/,/g, '')) * 100) / 100;
  const outM = text.search(/\b(sent|debited|paid|transferred|withdrawn|withdrawal|purchase|spent|deducted|payment of|charged|bill payment)\b/i);
  const inM = text.search(/\b(received|credited|deposited|refund(?:ed)?)\b/i);
  r.dir = inM >= 0 && (outM < 0 || inM < outM) ? 'in' : 'out';
  const who = r.dir === 'out'
    ? text.match(/\b(?:sent|paid|transferred|transfer|payment)\s+(?:to|for)\s+(.+?)(?=\s+(?:from|via|on|at|using|through|A\/C|Acc(?:ount)?|IBAN|Ref|Tx|TID|Trx)\b|[.,;:]|$)/i) || text.match(/\bat\s+([A-Z][\w&' .-]{2,40}?)(?=\s+(?:on|via|from)\b|[.,;]|$)/)
    : text.match(/\b(?:received|credited)\b.*?\bfrom\s+(.+?)(?=\s+(?:to|into|in|on|via|at|A\/C|Acc(?:ount)?|IBAN|Ref|Tx|TID|Trx)\b|[.,;:]|$)/i) || text.match(/\bfrom\s+(.+?)(?=\s+(?:to|into|in|on|via|A\/C)\b|[.,;:]|$)/i);
  if (who) {
    let n = who[1].trim();
    for (let i = 0; i < 3; i++) n = n.replace(BANK_WORDS, '').trim();
    if (n && !/^(?:your|a\/c|account)\b/i.test(n) && n.length <= 50) r.party = /[a-z]/.test(n) ? n : titleCase(n);
  }
  const ac = text.match(/\b(?:A\/C|Acc(?:ount)?|card)\s*(?:no\.?|number|ending(?:\s+in)?)?\s*[*xX#.\-]*\s*(\d{3,6})\b/i);
  if (ac) r.digits = ac[1].slice(-4);
  let dm = text.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})\b/), d = null;
  if (dm) d = [dm[3], dm[2], dm[1]];
  else if ((dm = text.match(/\b(\d{1,2})[-\s]?([A-Za-z]{3})[a-z]*[-\s,]*(\d{2,4})\b/)) && MONTHS3[dm[2].toLowerCase()]) d = [dm[3], MONTHS3[dm[2].toLowerCase()], dm[1]];
  if (d) {
    const y = String(d[0]).length === 2 ? '20' + d[0] : String(d[0]), iso = `${y}-${String(d[1]).padStart(2, '0')}-${String(d[2]).padStart(2, '0')}`;
    if (/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(iso) && iso <= addDays(today(), 1)) r.date = iso;
  }
  const tm = text.match(/\b(\d{1,2}:\d{2})(?::\d{2})?\s*(am|pm)?\b/i); if (tm) r.time = tm[1] + (tm[2] ? ' ' + tm[2].toUpperCase() : '');
  const tx = text.match(/\b(?:Tx\s*ID|TID|Trx\s*ID|Txn\s*ID|Transaction\s*(?:ID|No\.?|#)|Ref(?:erence)?\s*(?:No\.?|#|ID)|RRN|STAN)\s*[:#.]?\s*([A-Z0-9][A-Z0-9-]{5,})/i);
  if (tx) r.txId = tx[1];
  const via = text.match(/\bvia\s+(RAAST|IBFT|1LINK|ATM|POS|Internet Banking|Mobile App|[A-Z]{3,10})\b/i); if (via) r.via = via[1].toUpperCase();
  return r;
}
function smsBillMatch(r) {
  const t = r.text.toLowerCase().replace(/\s+/g, '');
  return live().filter(e => e.type === 'expected' && e.direction === 'out' && !expectedInfo(e).closed)
    .find(e => (e.ref && t.includes(e.ref.replace(/\s+/g, '').toLowerCase())) || ((e.note || '').trim().length >= 3 && t.includes(e.note.trim().toLowerCase().replace(/\s+/g, ''))));
}
function openFromSms(raw) {
  if (sheetOpen) closeSheet();
  const r = parseBankSms(raw);
  if (!r.amount) { toast('No amount found in that message'); openFormWith({ type: 'expense' }); return; }
  if (r.txId) { const same = live().find(e => e.txId && e.txId === r.txId); if (same) { setTab('home'); openEntry(same.id); toast('Already added'); return; } }
  const accId = r.digits && S.settings.acctDigits && acc(S.settings.acctDigits[r.digits]) ? S.settings.acctDigits[r.digits] : '';
  const date = r.date || today();
  const sms = { amount: r.amount, dir: r.dir, party: r.party || '', digits: r.digits || '', date, time: r.time || '', txId: r.txId || '', via: r.via || '' };
  const bill = r.dir === 'out' ? smsBillMatch(r) : null;
  const p = r.party ? S.people.find(x => x.name.toLowerCase().includes(r.party.toLowerCase()) || r.party.toLowerCase().includes(x.name.toLowerCase().replace(/\s*\(.*\)$/, ''))) : null;
  const base = { amount: String(r.amount), date, txId: r.txId || '', sms };
  if (accId) { base.accountId = accId; base.paidFrom = 'a:' + accId; }
  if (bill) {
    openFormWith({ ...base, type: 'expense', categoryId: bill.categoryId || '', bookId: bill.bookId || areaForCat(bill.categoryId), note: bill.note || '', linkExpected: bill.id, ...(accId ? {} : bill.accountId ? { accountId: bill.accountId, paidFrom: 'a:' + bill.accountId } : {}) });
  } else if (p) {
    openFormWith({ ...base, type: r.dir === 'in' ? 'income' : 'expense', forId: p.id, forOpen: true, what: defaultWhat(p.id, r.dir) });
    applyWhat(); render();
  } else {
    openFormWith({ ...base, type: r.dir === 'in' ? 'income' : 'expense', note: r.party ? (r.dir === 'in' ? 'From ' : 'To ') + r.party : '' });
  }
}
function smsBanner(f) {
  const m = f.sms; if (!m) return '';
  const dup = live().find(e => !e.txId && Math.abs(e.amount - m.amount) < 0.01 && e.date === f.date && e.id !== f.editingId && e.type !== 'expected');
  const accKnown = m.digits && S.settings.acctDigits && S.settings.acctDigits[m.digits];
  return `<div class="sms-card"><div class="sms-top"><b>From your bank message</b><button class="link small" data-act="smsDismiss">Clear</button></div>
    <div class="sms-facts">${[money(m.amount) + (m.dir === 'in' ? ' received' : ' sent'), m.party ? (m.dir === 'in' ? 'from ' : 'to ') + esc(m.party) : '', fmtShort(m.date) + (m.time ? ' ' + esc(m.time) : ''), m.via ? esc(m.via) : '', m.digits ? 'A/C …' + esc(m.digits) : ''].filter(Boolean).join(' · ')}</div>
    ${m.digits && !accKnown ? `<div class="muted small">Pick the account for …${esc(m.digits)} once; next time it is chosen for you.</div>` : ''}
    ${dup ? `<div class="sms-dup">You already added <b>${money(dup.amount)}</b> “${esc(entryTitle(dup))}” on this day. <button class="btn sm" data-act="smsAttach" data-id="${dup.id}">That's this one</button></div>` : ''}
  </div>`;
}
async function pasteSms() {
  let txt = '';
  try { txt = await navigator.clipboard.readText(); } catch (e) { /* permission denied or not supported */ }
  if (!txt || !/\d/.test(txt)) {
    openSheet(`${sheetHead('Paste bank message')}<p class="muted small" style="margin-bottom:8px">Copy the payment SMS from your bank, then paste it here.</p>
      <textarea id="smsText" class="inp" rows="5" placeholder="PKR 12,000.00 sent to … Tx ID …"></textarea>
      <button class="btn primary block mt" data-act="smsFromBox">Fill the form</button>`);
    setTimeout(() => $('#smsText')?.focus(), 60); return;
  }
  openFromSms(txt);
}

// ---------------- Bill tracking (one page per bill: every month's amount, units, payment) ----------------
function billNameKey(e) { return 'n:' + (e.note || '').trim().toLowerCase() + '|' + (e.categoryId || '') + '|' + (e.bookId || ''); }
function billSid(e) { return e.seriesId || billNameKey(e); }
function billSeries(sid) { return S.entries.filter(e => e.type === 'expected' && e.direction === 'out' && !e.draft && billSid(e) === sid).sort((a, b) => (a.date < b.date ? -1 : 1)); }
function billUnitsOk(x) { return /electric|bijli|gas|water|wasa|sngpl|sui|lesco|fesco|iesco|mepco|gepco|pesco|hesco|qesco|k-?electric/i.test((x.note || '') + ' ' + (cat(x.categoryId)?.name || '')); }
function billCycles(sid) {
  return billSeries(sid).map(b => {
    const pays = live().filter(e => e.linkExpected === b.id && e.type === 'expense').sort((a, c) => (a.date < c.date ? -1 : 1));
    const paid = r2(pays.reduce((a, e) => a + e.amount, 0));
    const units = pays.reduce((a, e) => a + (Number(e.units) || 0), 0);
    const paidOn = pays.length ? pays[pays.length - 1].date : '';
    const xi = expectedInfo(b);
    return { b, ym: b.date.slice(0, 7), due: b.date, amount: b.amount, paid, pays, units, paidOn, late: paidOn && paidOn > b.date ? daysBetween(b.date, paidOn) : 0, open: !xi.closed, est: !!b.estimated };
  });
}
// Next bill: same month last year if known (bills follow the seasons), else the average of the last 3.
function billEstimate(sid, due) {
  const paid = billCycles(sid).filter(c => c.paid > 0);
  if (!paid.length) return null;
  const ly = paid.find(c => c.ym === shiftYm(due.slice(0, 7), -12));
  if (ly) return { v: Math.round(ly.paid / 10) * 10, why: 'same month last year' };
  const last = paid.slice(-3), v = last.reduce((a, c) => a + c.paid, 0) / last.length;
  return { v: Math.round(v / 10) * 10, why: last.length === 1 ? 'last bill' : `average of last ${last.length}` };
}
function allBillSids() {
  const m = new Map();
  for (const e of S.entries) if (e.type === 'expected' && e.direction === 'out' && !e.draft) { const k = billSid(e); if (!m.has(k) || m.get(k).date < e.date) m.set(k, e); }
  return [...m.entries()].map(([sid, latest]) => ({ sid, latest }));
}

VIEWS.bill = (sid) => {
  const cyc = billCycles(sid);
  if (!cyc.length) return '<div class="empty">This bill no longer exists.</div>';
  const t = today(), latest = cyc[cyc.length - 1].b, openC = cyc.find(c => c.open), x = openC ? openC.b : latest;
  const paid = cyc.filter(c => c.paid > 0), last12 = paid.slice(-12);
  const avg = last12.length ? last12.reduce((a, c) => a + c.paid, 0) / last12.length : 0;
  const hi = last12.reduce((a, c) => (!a || c.paid > a.paid ? c : a), null), lo = last12.reduce((a, c) => (!a || c.paid < a.paid ? c : a), null);
  const lastP = paid[paid.length - 1], prevP = paid[paid.length - 2];
  const ch = lastP && prevP && prevP.paid ? Math.round((lastP.paid - prevP.paid) / prevP.paid * 100) : null;
  const unitsRows = paid.filter(c => c.units > 0), rate = unitsRows.length ? unitsRows.reduce((a, c) => a + c.paid, 0) / unitsRows.reduce((a, c) => a + c.units, 0) : 0;
  const est = openC && openC.est ? billEstimate(sid, openC.due) : null;
  const sub = [cat(x.categoryId)?.name, book(x.bookId)?.name, REPEAT_LBL[x.repeat], acc(x.accountId) ? 'from ' + acc(x.accountId).name : ''].filter(Boolean).map(esc).join(' · ');
  const ref = x.ref ? `<div class="bl-ref"><span>Reference no.</span><b>${esc(x.ref)}</b><button class="btn sm" data-act="copyRef" data-v="${esc(x.ref)}">Copy</button></div>`
    : `<button class="link small" data-act="editEntry" data-id="${x.id}">+ Add reference / consumer no.</button>`;
  let now = '';
  if (openC) {
    const od = openC.due < t, d = daysBetween(t, openC.due);
    now = `<section class="iv-card bl-now ${od ? 'od' : ''}">
      <div class="iv-hero-top"><span>${monthLabel(openC.ym)} bill</span><span class="iv-delta ${od ? 'up' : ''}">${od ? 'Overdue ' + Math.abs(d) + 'd' : d === 0 ? 'Due today' : 'Due ' + fmtShort(openC.due)}</span></div>
      <div class="iv-hero-amt">${openC.est ? '≈ ' : ''}${money(expectedInfo(openC.b).rem)}</div>
      ${openC.est ? `<p class="iv-pace">Estimate${est ? ' from the ' + esc(est.why) : ''}. When the bill comes, enter the real amount.</p>` : ''}
      <div class="btn-row">${openC.est ? `<button class="btn" data-act="setBillAmt" data-id="${openC.b.id}">Enter bill amount</button>` : `<button class="btn" data-act="setBillAmt" data-id="${openC.b.id}">Change amount</button>`}<button class="btn primary" data-act="payExpected" data-id="${openC.b.id}">Pay</button></div>
    </section>`;
  } else now = `<div class="iv-pill iv-none">All paid ✓${x.repeat ? '' : ' · this bill does not repeat'}</div>`;
  const tiles = last12.length ? `<div class="iv-tiles">
      <div class="iv-tile"><span class="iv-tl">Average</span><b>${money(Math.round(avg))}</b><span class="iv-tm"><span>last ${last12.length} bill${last12.length > 1 ? 's' : ''}</span></span></div>
      <div class="iv-tile"><span class="iv-tl">Last bill</span><b>${money(lastP.paid)}</b><span class="iv-tm"><span>${monthLabel(lastP.ym).split(' ')[0]}</span>${ch === null ? '' : `<span class="${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}">${ch > 0 ? '▲' : ch < 0 ? '▼' : '='}${Math.abs(ch)}%</span>`}</span></div>
      ${last12.length > 1 ? `<div class="iv-tile"><span class="iv-tl">Highest</span><b>${money(hi.paid)}</b><span class="iv-tm"><span>${monthLabel(hi.ym)}</span></span></div>
      <div class="iv-tile"><span class="iv-tl">Lowest</span><b>${money(lo.paid)}</b><span class="iv-tm"><span>${monthLabel(lo.ym)}</span></span></div>` : ''}
      ${rate ? `<div class="iv-tile"><span class="iv-tl">Per unit</span><b>${money(Math.round(rate * 10) / 10)}</b><span class="iv-tm"><span>average</span></span></div>
      <div class="iv-tile"><span class="iv-tl">Units</span><b>${unitsRows[unitsRows.length - 1].units}</b><span class="iv-tm"><span>${monthLabel(unitsRows[unitsRows.length - 1].ym).split(' ')[0]}</span></span></div>` : ''}
    </div>` : '';
  const chart = paid.length >= 2 ? `<section class="iv-card"><div class="iv-h">Month by month</div>${ivColumns(last12.map(c => ({ m: c.ym, v: c.paid })), lastP.ym)}</section>` : '';
  const hist = cyc.slice().reverse().map(c => {
    const p0 = c.pays[c.pays.length - 1];
    const status = c.paid > 0 ? `Paid ${fmtShort(c.paidOn)}${c.late ? ` · <span class="warn">${c.late}d late</span>` : ''}` : c.open ? (c.due < t ? '<span class="danger">Overdue</span>' : 'Due ' + fmtShort(c.due)) : 'Closed without payment';
    const extra = [c.units ? c.units + ' units' : '', p0 && p0.txId ? 'Tx ' + esc(p0.txId) : ''].filter(Boolean).join(' · ');
    return `<button class="list-item" data-act="openEntry" data-id="${p0 ? p0.id : c.b.id}">
      <div class="li-main"><div class="li-title">${monthLabel(c.ym)}</div><div class="li-sub">${status}${extra ? ' · ' + extra : ''}</div></div>
      <div class="li-amt ${c.paid ? '' : 'muted'}">${c.paid ? money(c.paid) : (c.est ? '≈ ' : '') + money(c.amount)}</div></button>`;
  }).join('');
  return `<div class="iv-body">
    <div class="bl-head">${entryIcon(x)}<div class="grow"><div class="bl-sub">${sub}</div>${ref}</div></div>
    ${now}${tiles}${chart}
    <div class="iv-h" style="margin-top:6px">History</div>
    <div class="card flush">${hist}</div>
    <div class="btn-row mt"><button class="btn" data-act="editEntry" data-id="${x.id}">Edit bill</button>${openC ? `<a class="btn" href="${billCalUrl(openC.b)}" target="_blank" rel="noopener">Remind me in Calendar</a>` : ''}</div>
    ${!unitsRows.length && billUnitsOk(x) ? '<p class="iv-foot">Tip: type the units from the bill when you pay. You will see units and cost per unit here.</p>' : ''}
  </div>`;
};
function billCalUrl(b) {
  const rem = addDays(b.date, -2) < today() ? b.date : addDays(b.date, -2), d = rem.replace(/-/g, ''), d2 = addDays(rem, 1).replace(/-/g, '');
  const R = { weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY', '2m': 'FREQ=MONTHLY;INTERVAL=2', '3m': 'FREQ=MONTHLY;INTERVAL=3', '6m': 'FREQ=MONTHLY;INTERVAL=6', yearly: 'FREQ=YEARLY' }[b.repeat];
  const p = new URLSearchParams({ action: 'TEMPLATE', text: 'Pay ' + entryTitle(b), dates: d + '/' + d2, details: `Due ${fmtDate(b.date)}${b.ref ? '\nRef: ' + b.ref : ''}\nAbout ${money(b.amount)}. Record it in Hisaab after paying.` });
  if (R) p.set('recur', 'RRULE:' + R);
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}
function myBillsHtml() {
  const rows = allBillSids().map(({ sid, latest }) => {
    const cyc = billCycles(sid), paid = cyc.filter(c => c.paid > 0), l3 = paid.slice(-12);
    const avg = l3.length ? l3.reduce((a, c) => a + c.paid, 0) / l3.length : 0, lastP = paid[paid.length - 1];
    const spark = l3.length >= 2 ? (() => { const mx = Math.max(...l3.map(c => c.paid)); return `<span class="bl-spark" aria-hidden="true">${l3.slice(-6).map(c => `<i style="height:${Math.max(12, c.paid / mx * 100)}%"></i>`).join('')}</span>`; })() : '';
    return { latest, sid, avg, lastP, spark, open: cyc.some(c => c.open) };
  }).sort((a, b) => (b.open - a.open) || b.avg - a.avg);
  if (!rows.length) return '<div class="empty">No bills yet.</div>';
  return `<div class="card flush">${rows.map(r => `<button class="list-item" data-act="go" data-v="bill" data-p="${esc(r.sid)}">${entryIcon(r.latest)}
    <div class="li-main"><div class="li-title">${esc(entryTitle(r.latest))}</div><div class="li-sub">${r.avg ? 'avg ' + money(Math.round(r.avg)) : 'no payments yet'}${r.lastP ? ' · last ' + money(r.lastP.paid) : ''}${r.open ? '' : ' · stopped'}</div></div>
    ${r.spark}<span class="chev">›</span></button>`).join('')}</div>`;
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
// ---------------- Insights ----------------
// Each block uses the chart form that fits its job: a line for pace over time,
// a donut for share of the whole, tiles for a few areas, cards for projects,
// columns for months. Colours follow the entity (fixed slot order), text stays in text colours.
const IV_SLOTS = 5;
function dailyOwn(ym) {
  const dim = daysInMonth(ym), out = Array(dim).fill(0), [f, to] = monthBounds(ym);
  const add = (d, v) => { const i = Number(d.slice(8, 10)) - 1; if (i >= 0 && i < dim) out[i] = r2(out[i] + v); };
  for (const e of live()) {
    if (e.type === 'expense' && e.date >= f && e.date <= to) add(e.date, e.amount);
    if (e.type === 'recoverable' && e.writtenOff && e.writtenOff.date >= f && e.writtenOff.date <= to) add(e.writtenOff.date, e.writtenOff.amount);
    if (e.type === 'adjustment' && e.amount < 0 && e.date >= f && e.date <= to) add(e.date, -e.amount);
  }
  let c = 0; return out.map(v => (c = r2(c + v)));
}
function shortMoney(v) {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e7) return s + (a / 1e7).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, '') + ' cr';
  if (a >= 1e5) return s + (a / 1e5).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, '') + ' lac';
  if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return s + Math.round(a);
}
function ivPace(ym, curTotal) {
  const isNow = ym === today().slice(0, 7), dim = daysInMonth(ym);
  const cur = dailyOwn(ym), prevYm = shiftYm(ym, -1), prev = dailyOwn(prevYm);
  const upto = isNow ? Number(today().slice(8, 10)) : dim;
  const perDay = curTotal / Math.max(1, upto), proj = Math.round(perDay * dim);
  const prevTot = prev[prev.length - 1] || 0;
  const W = 320, H = 96, P = 4;
  const max = Math.max(1, isNow ? proj : 0, curTotal, prevTot);
  const x = d => P + (d - 1) / Math.max(1, dim - 1) * (W - 2 * P), y = v => H - P - v / max * (H - 2 * P);
  const path = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const prevPts = prev.slice(0, dim).concat(Array(Math.max(0, dim - prev.length)).fill(prevTot));
  const curPts = cur.slice(0, upto);
  const svg = `<svg class="iv-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Spending through the month"
    data-cur="${curPts.join(',')}" data-prev="${prevPts.join(',')}" data-dim="${dim}" data-ym="${ym}" data-prevym="${prevYm}">
    <line class="iv-base" x1="${P}" x2="${W - P}" y1="${H - P}" y2="${H - P}"/>
    ${prevTot ? `<path class="iv-prev" d="${path(prevPts)}"/>` : ''}
    ${isNow && upto < dim && curTotal ? `<path class="iv-proj" d="M${x(upto).toFixed(1)},${y(curTotal).toFixed(1)}L${x(dim).toFixed(1)},${y(proj).toFixed(1)}"/>` : ''}
    ${curPts.length ? `<path class="iv-cur" d="${path(curPts)}" pathLength="1"/><circle class="iv-dot" cx="${x(upto).toFixed(1)}" cy="${y(curTotal).toFixed(1)}" r="4"/>` : ''}
    <line class="iv-cross" x1="0" x2="0" y1="${P}" y2="${H - P}" style="display:none"/>
  </svg>`;
  const prevName = monthLabel(prevYm).split(' ')[0];
  const legend = `<div class="iv-legend"><span><i class="k-cur"></i>${isNow ? 'This month' : monthLabel(ym).split(' ')[0]}</span>${prevTot ? `<span><i class="k-prev"></i>${esc(prevName)}</span>` : ''}${isNow && upto < dim && curTotal ? `<span><i class="k-proj"></i>At this pace</span>` : ''}</div>`;
  return { svg, legend, perDay, proj, isNow, upto, dim, prevTot, prevName };
}
function ivDonut(slices, total) {
  const R = 42, C = 2 * Math.PI * R, gap = slices.length > 1 ? 2.2 : 0;
  let off = 0;
  const arcs = slices.map(s => {
    const len = Math.max(0, s.v / total * C - gap);
    const a = `<circle r="${R}" cx="60" cy="60" class="iv-arc" style="stroke:${s.color}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" data-tip="${esc(s.name)}: ${esc(money(s.v))} (${Math.round(s.v / total * 100)}%)"/>`;
    off += s.v / total * C; return a;
  }).join('');
  return `<svg class="iv-donut" viewBox="0 0 120 120" role="img" aria-label="Share of spending by category"><g transform="rotate(-90 60 60)">${arcs}</g>
    <text x="60" y="57" class="iv-dc-v">${esc(shortMoney(total))}</text><text x="60" y="73" class="iv-dc-l">spent</text></svg>`;
}
function ivColumns(months, ym) {
  const W = 320, H = 110, top = 18, bot = 18, n = months.length, bw = Math.min(34, (W - 16) / n - 10);
  const max = Math.max(1, ...months.map(m => m.v)), avgv = months.reduce((a, m) => a + m.v, 0) / n;
  const cx = i => 8 + (i + 0.5) * (W - 16) / n, hgt = v => v / max * (H - top - bot);
  const bars = months.map((m, i) => {
    const h = Math.max(m.v ? 3 : 0, hgt(m.v)), on = m.m === ym;
    return `<g><rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${(H - bot - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" class="iv-col ${on ? 'on' : ''}" data-tip="${esc(monthLabel(m.m))}: ${esc(money(m.v))}"/>
      ${on ? `<text x="${cx(i).toFixed(1)}" y="${(H - bot - h - 5).toFixed(1)}" class="iv-col-v">${esc(shortMoney(m.v))}</text>` : ''}
      <text x="${cx(i).toFixed(1)}" y="${H - 4}" class="iv-col-l ${on ? 'on' : ''}">${esc(monthLabel(m.m).slice(0, 3))}</text></g>`;
  }).join('');
  const ay = H - bot - hgt(avgv);
  return `<svg class="iv-cols" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending by month">
    <line class="iv-avg" x1="4" x2="${W - 4}" y1="${ay.toFixed(1)}" y2="${ay.toFixed(1)}"/>${bars}</svg>
    <div class="iv-legend"><span><i class="k-avg"></i>Average ${esc(money(Math.round(avgv)))}</span></div>`;
}
const ivInitials = n => { const w = String(n || '').replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(x => /^\p{L}/u.test(x)); return esc((w.slice(0, 2).map(x => x[0]).join('') || '?').toUpperCase()); };
function ivTabs(tab) {
  const t = (k, l) => `<button class="${tab === k ? 'on' : ''}" data-act="insTab" data-t="${k}" role="tab" aria-selected="${tab === k}">${l}</button>`;
  return `<div class="iv-tabs" role="tablist">${t('overview', 'Overview')}${t('projects', 'Projects')}${t('people', 'People')}</div>`;
}

VIEWS.insights = () => {
  const ym = insMonth || today().slice(0, 7), tab = ui.insTab || 'overview';
  const isNow = ym === today().slice(0, 7);
  const head = `<div class="iv-month">
    <button class="icon-btn" data-act="insMove" data-n="-1" aria-label="Previous month">‹</button>
    <b>${monthLabel(ym)}</b>
    <button class="icon-btn" data-act="insMove" data-n="1" aria-label="Next month" ${isNow ? 'disabled' : ''}>›</button></div>${ivTabs(tab)}`;
  const body = tab === 'projects' ? ivProjects(ym) : tab === 'people' ? ivPeople(ym) : ivOverview(ym);
  return head + `<div class="iv-body">${body}${tab === 'overview' && spendMonth(ym).total ? `<button class="btn block" data-act="shareMonth" data-ym="${ym}">Share ${monthLabel(ym).split(' ')[0]} summary on WhatsApp</button>` : ''}</div>`;
};

function ivOverview(ym) {
  const cur = spendMonth(ym), prev = spendMonth(shiftYm(ym, -1));
  const [f, to] = monthBounds(ym);
  if (!cur.total && !incomeIn(f, to)) return `<div class="iv-empty"><b>Nothing spent in ${monthLabel(ym)}</b><p>Add a few expenses and this page shows where your money goes, how fast you are spending, and what is above your usual.</p><button class="btn primary" data-act="jump" data-tab="add">+ Add an expense</button></div>`;
  const pace = ivPace(ym, cur.total);
  // compare like with like: this month so far vs the same days last month
  const prevSame = pace.isNow ? (dailyOwn(shiftYm(ym, -1))[Math.min(pace.upto, daysInMonth(shiftYm(ym, -1))) - 1] || 0) : prev.total;
  const ch = prevSame ? Math.round((cur.total - prevSame) / prevSame * 100) : null;
  const inc = incomeIn(f, to), saved = r2(inc - cur.total), rate = inc ? Math.round(saved / inc * 100) : null;
  const delta = ch === null ? '' : `<span class="iv-delta ${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}">${ch > 0 ? '▲' : ch < 0 ? '▼' : '='} ${Math.abs(ch)}% <span>vs ${esc(pace.prevName)}${pace.isNow ? ' same days' : ''}</span></span>`;
  const paceTxt = pace.isNow && pace.upto < pace.dim && cur.total
    ? `At this pace the month ends near <b>${money(pace.proj)}</b>${pace.prevTot ? ` · ${esc(pace.prevName)} was ${money(pace.prevTot)}` : ''}${pace.upto < 7 ? ' <span class="muted">(rough this early)</span>' : ''}`
    : '';
  const hero = `<section class="iv-hero">
    <div class="iv-hero-top"><span>Spent${pace.isNow ? ' so far' : ''}</span>${delta}</div>
    <div class="iv-hero-amt">${money(cur.total)}</div>
    ${pace.svg}${pace.legend}
    ${paceTxt ? `<p class="iv-pace">${paceTxt}</p>` : ''}
    <div class="iv-stats">
      <div><span>Income</span><b class="${inc ? 'in' : ''}">${money(inc)}</b></div>
      <div><span>Saved</span>${inc ? `<b class="${saved < 0 ? 'out' : ''}">${money(saved)}</b><small>${rate}% of income</small>` : `<b class="muted">—</b><small>add income to see</small>`}</div>
      <div><span>Per day</span><b>${money(Math.round(pace.perDay))}</b></div>
    </div></section>`;

  // budget: a ring, not another bar
  const bud = budgetRows(ym).rows, bt = bud.find(r => r.k === 'total'), over = bud.filter(r => r.state === 'over');
  let budget = '';
  if (bt || over.length) {
    const pct = bt ? Math.min(1, bt.pct) : 1, R = 22, C = 2 * Math.PI * R;
    budget = `<button class="iv-card iv-budget ${bt ? bt.state : 'over'}" data-act="go" data-v="budgets">
      <svg viewBox="0 0 56 56" class="iv-ring" aria-hidden="true"><circle cx="28" cy="28" r="${R}" class="iv-ring-bg"/><circle cx="28" cy="28" r="${R}" class="iv-ring-fg" stroke-dasharray="${(pct * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 28 28)"/><text x="28" y="32">${bt ? Math.round(bt.pct * 100) + '%' : '!'}</text></svg>
      <div class="grow"><b>${bt ? (bt.left >= 0 ? money(bt.left) + ' left' : money(-bt.left) + ' over budget') : 'Budget'}</b>
      <div class="muted small">${bt ? money(bt.spent) + ' of ' + money(bt.budget) : ''}${over.length ? `${bt ? ' · ' : ''}<span class="danger">${over.map(r => esc(r.label)).slice(0, 2).join(', ')}${over.length > 2 ? ' +' + (over.length - 2) : ''} over</span>` : ''}</div></div><span class="chev">›</span></button>`;
  }

  // categories: donut + legend list (labels carry identity, not colour alone)
  const past = [1, 2, 3].map(i => spendMonth(shiftYm(ym, -i)));
  const usual = id => r2(past.reduce((a, m) => a + (m.byCat[id] || 0), 0) / 3);
  const cats = Object.entries(cur.byCat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const top = cats.slice(0, cats.length > IV_SLOTS + 1 ? IV_SLOTS : IV_SLOTS + 1);
  const rest = cats.slice(top.length), restV = r2(rest.reduce((a, c) => a + c[1], 0));
  const slices = top.map(([id, v], i) => ({ id, v, name: catName(id), color: id.startsWith('_') ? 'var(--c-other)' : `var(--c${(i % IV_SLOTS) + 1})` }));
  if (restV) slices.push({ id: '_rest', v: restV, name: rest.length + ' more', color: 'var(--c-other)' });
  const showAll = ui.insAllCats;
  const catRow = (id, v, color) => {
    const a = usual(id), pctv = Math.round(v / cur.total * 100);
    const flag = a === 0 ? (past.some(m => m.total) ? '<span class="iv-flag new">new</span>' : '') : v > a * 1.3 && v - a >= 500 ? `<span class="iv-flag hot">${Math.round((v - a) / a * 100)}% above usual</span>` : '';
    return `<button class="iv-row" data-act="insCat" data-c="${esc(id)}"><i class="iv-sw" style="background:${color}"></i>
      <span class="grow"><span class="iv-rn">${esc(catName(id))}</span>${flag}${a ? `<span class="iv-sub">usual ${money(Math.round(a))}</span>` : ''}</span>
      <span class="iv-rv"><b>${money(v)}</b><span>${pctv}%</span></span></button>`;
  };
  const catList = slices.map(s => s.id === '_rest'
    ? (showAll ? rest.map(([id, v]) => catRow(id, v, 'var(--c-other)')).join('') + `<button class="iv-more" data-act="insAllCats">Show less</button>`
      : `<button class="iv-row" data-act="insAllCats"><i class="iv-sw" style="background:var(--c-other)"></i><span class="grow"><span class="iv-rn">${rest.length} more ${rest.length === 1 ? 'category' : 'categories'}</span></span><span class="iv-rv"><b>${money(restV)}</b><span>${Math.round(restV / cur.total * 100)}%</span></span></button>`)
    : catRow(s.id, s.v, s.color)).join('');
  const where = cur.total ? `<section class="iv-card"><div class="iv-h">Where it went <span>tap to see entries</span></div>
    <div class="iv-donut-wrap">${ivDonut(slices, cur.total)}</div><div class="iv-list">${catList}</div></section>` : '';

  // areas: a few tiles, each with its change from last month
  const books = Object.entries(cur.byBook).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const areas = books.length > 1 || (books.length === 1 && books[0][0] !== '_none') ? `<section class="iv-sec"><div class="iv-h">By area</div><div class="iv-tiles">${books.map(([id, v]) => {
    const pv = prev.byBook[id] || 0, d = pv ? Math.round((v - pv) / pv * 100) : null;
    return `<button class="iv-tile" data-act="insBook" data-b="${esc(id)}"><span class="iv-tl">${esc(id === '_none' ? 'No area' : id === '_unrec' ? 'Not recorded' : bookName(id))}</span><b>${money(v)}</b>
      <span class="iv-tm"><span>${Math.round(v / cur.total * 100)}% of spent</span>${d === null ? '' : `<span class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '▲' : d < 0 ? '▼' : '='}${Math.abs(d)}%</span>`}</span></button>`;
  }).join('')}</div></section>` : '';

  // how you paid: short pills
  const how = {};
  for (const e of live()) if (e.type === 'expense' && e.date >= f && e.date <= to) { const k = e.viaPersonId ? '_p' : (e.accountId || '_n'); how[k] = r2((how[k] || 0) + e.amount); }
  const howRows = Object.entries(how).sort((a, b) => b[1] - a[1]);
  const paid = howRows.length > 1 ? `<section class="iv-sec"><div class="iv-h">Paid with</div><div class="iv-pills">${howRows.map(([k, v]) => `<span class="iv-pill">${esc(k === '_p' ? 'Paid by others' : k === '_n' ? 'Before the app' : (acc(k)?.name || 'Account'))} <b>${money(v)}</b></span>`).join('')}</div></section>` : '';

  // bills: two numbers side by side
  const bOpen = live().filter(e => e.type === 'expected' && e.direction === 'out' && !expectedInfo(e).closed && e.date >= f && e.date <= to);
  const billIds = new Set(S.entries.filter(e => e.type === 'expected' && e.direction === 'out').map(e => e.id));
  const bPaid = r2(live().filter(e => e.linkExpected && billIds.has(e.linkExpected) && e.date >= f && e.date <= to).reduce((a, e) => a + e.amount, 0));
  const bLeft = r2(bOpen.reduce((a, e) => a + expectedInfo(e).rem, 0));
  const bills = bOpen.length || bPaid ? `<button class="iv-card iv-pair" data-act="jump" data-tab="bills"><div><span>Bills paid</span><b>${money(bPaid)}</b></div><div><span>Bills still to pay</span><b class="${bLeft ? 'out' : ''}">${money(bLeft)}</b>${bOpen.length ? `<small>${bOpen.length} open</small>` : ''}</div><span class="chev">›</span></button>` : '';

  const big = live().filter(e => e.type === 'expense' && e.date >= f && e.date <= to).sort((a, b) => b.amount - a.amount).slice(0, 3);
  const bigH = big.length ? `<section class="iv-sec"><div class="iv-h">Biggest expenses</div><div class="card flush">${big.map(e => entryItem(e)).join('')}</div></section>` : '';

  const months0 = [5, 4, 3, 2, 1, 0].map(i => { const m = shiftYm(ym, -i); return { m, v: spendMonth(m).total }; });
  const first = months0.findIndex(x => x.v > 0), months = first < 0 ? [] : months0.slice(first);
  const trend = months.length >= 2 ? `<section class="iv-card"><div class="iv-h">Month by month</div>${ivColumns(months, ym)}</section>` : '';

  return hero + budget + where + areas + paid + bills + bigH + trend +
    `<p class="iv-foot">Counts only your own money. Office money you will get back, loans and transfers are kept out, so they are on the Projects and People tabs.</p>`;
}

function ivProjects(ym) {
  if (!S.works.length) return `<div class="iv-empty"><b>Track a project, site or event</b><p>Group everything for one job, such as a building repair, a wedding or the govt vehicle, and see what it cost and what is still to come back.</p><button class="btn primary" data-act="editWork">+ Add a project</button></div>`;
  const rows = S.works.filter(w => !w.closed).map(w => ({ w, st: workStats(w.id) })).sort((a, b) => b.st.total - a.st.total);
  const tot = r2(rows.reduce((a, r) => a + r.st.total, 0)), pend = r2(rows.reduce((a, r) => a + r.st.recPending, 0)), done = S.works.length - rows.length;
  return `<div class="psum">Open projects <b>${money(tot)}</b>${pend ? ` · To get back <b class="in">${money(pend)}</b>` : ''}</div>
    <div class="list">${rows.map(projRow).join('') || '<div class="empty">No open projects.</div>'}</div>
    ${done ? `<button class="iv-more" data-act="go" data-v="works">${done} finished ›</button>` : ''}`;
}
// One row for a project: name, one useful fact (only if there is one), amount, ›
function projRow({ w, st }) {
  const fact = st.recPending ? `<span class="in">${money(st.recPending)} to get back</span>` : w.closed ? 'Finished' : '';
  return `<button class="list-item" data-act="go" data-v="work" data-p="${w.id}">
    <span class="ico av" aria-hidden="true">${esc((w.name.trim()[0] || '?').toUpperCase())}</span>
    <div class="li-main"><div class="li-title">${esc(w.name)}</div>${fact ? `<div class="li-sub">${fact}</div>` : ''}</div>
    <div class="li-amt">${money(st.total)}</div><span class="chev" aria-hidden="true">›</span></button>`;
}

function ivPeople(ym) {
  const [f, to] = monthBounds(ym);
  const pb = personBalances();
  const owed = Object.entries(pb).filter(([id, v]) => v > 0 && person(id)).sort((a, b) => b[1] - a[1]);
  const owe = Object.entries(pb).filter(([id, v]) => v < 0 && person(id)).sort((a, b) => a[1] - b[1]);
  const so = Object.entries(spentOnTotals(f, to)).filter(([id]) => person(id)).sort((a, b) => b[1] - a[1]);
  if (!owed.length && !owe.length && !so.length) return `<div class="iv-empty"><b>No money with people yet</b><p>When you lend, borrow, give money to someone to spend for you, or pay for family, it shows here: who owes you, whom you owe, and what you spent on each person.</p><button class="btn primary" data-act="jump" data-tab="people">Open People</button></div>`;
  const sum = l => r2(l.reduce((a, [, v]) => a + Math.abs(v), 0));
  const who = (list, cls) => list.slice(0, 4).map(([id, v]) => `<button class="iv-person" data-act="go" data-v="person" data-p="${id}"><span class="iv-av ${cls}">${ivInitials(person(id).name)}</span><span class="grow">${esc(person(id).name)}</span><b class="${cls}">${money(Math.abs(v))}</b></button>`).join('')
    + (list.length > 4 ? `<button class="iv-more" data-act="jump" data-tab="people">+ ${list.length - 4} more</button>` : '');
  const soMax = so.length ? so[0][1] : 1, soTot = sum(so);
  return `<div class="iv-pair2">
      ${owed.length ? `<section class="iv-card"><div class="iv-h">They owe you</div><div class="iv-big in">${money(sum(owed))}</div>${who(owed, 'in')}</section>` : ''}
      ${owe.length ? `<section class="iv-card"><div class="iv-h">You owe</div><div class="iv-big out">${money(sum(owe))}</div>${who(owe, 'out')}</section>` : ''}
      ${!owed.length || !owe.length ? `<div class="iv-pill iv-none">${!owed.length ? 'Nobody owes you' : 'You owe nobody'}${!owed.length && !owe.length ? ', and you owe nobody' : ''}</div>` : ''}
    </div>
    ${so.length ? `<section class="iv-card"><div class="iv-h">Spent on people in ${monthLabel(ym).split(' ')[0]} <span>not paid back</span></div>
      <div class="iv-big">${money(soTot)}</div>
      ${so.map(([id, v]) => `<button class="iv-person" data-act="spentOnList" data-p="${id}" data-ym="${ym}"><span class="iv-av">${ivInitials(person(id).name)}</span>
        <span class="grow"><span class="iv-rn">${esc(person(id).name)}</span></span><b>${money(v)}</b></button>`).join('')}</section>` : ''}
    <p class="iv-foot">Loans and money given to spend are not counted as your spending. Spending on family that is not paid back is.</p>`;
}

// One tooltip for every chart: per-mark tips, and a crosshair on the pace line.
(function ivTooltip() {
  let tip;
  const show = (html, cx, cy) => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'iv-tip'; document.body.appendChild(tip); }
    tip.innerHTML = html; tip.hidden = false;
    const w = tip.offsetWidth, x = Math.min(window.innerWidth - w - 8, Math.max(8, cx - w / 2));
    tip.style.left = x + 'px'; tip.style.top = Math.max(8, cy - tip.offsetHeight - 14) + 'px';
  };
  const hide = () => { if (tip) tip.hidden = true; document.querySelectorAll('.iv-spark .iv-cross').forEach(l => (l.style.display = 'none')); };
  const move = ev => {
    const t = ev.target;
    const mark = t.closest && t.closest('[data-tip]');
    if (mark && mark.closest('.iv-body')) { show(esc(mark.dataset.tip), ev.clientX, ev.clientY); return; }
    const sp = t.closest && t.closest('.iv-spark');
    if (sp) {
      const r = sp.getBoundingClientRect(), dim = Number(sp.dataset.dim), cur = sp.dataset.cur ? sp.dataset.cur.split(',').map(Number) : [], prev = sp.dataset.prev ? sp.dataset.prev.split(',').map(Number) : [];
      const d = Math.min(dim, Math.max(1, Math.round((ev.clientX - r.left) / r.width * (dim - 1)) + 1));
      const cross = sp.querySelector('.iv-cross'), px = 4 + (d - 1) / Math.max(1, dim - 1) * 312;
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.style.display = '';
      const lines = [`<b>Day ${d}</b>`];
      if (d <= cur.length) lines.push(`${esc(monthLabel(sp.dataset.ym).split(' ')[0])}: ${esc(money(cur[d - 1]))}`);
      if (prev.length && prev.some(v => v)) lines.push(`${esc(monthLabel(sp.dataset.prevym).split(' ')[0])}: ${esc(money(prev[d - 1] || 0))}`);
      show(lines.join('<br>'), ev.clientX, r.top);
      return;
    }
    hide();
  };
  document.addEventListener('pointermove', move, { passive: true });
  document.addEventListener('pointerdown', move, { passive: true });
  document.addEventListener('scroll', hide, { passive: true, capture: true });
})();

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

VIEWS.security = () => {
  const on = !!S.settings.pinHash;
  return `<div class="card">
  ${on ? `<p style="margin-bottom:12px">PIN lock is <b>on</b> (${S.settings.pinLen || 4} digits). The app locks when opened and after ${S.settings.lockAfter} seconds away.</p>
    <div class="btn-row"><button class="btn" data-act="setPin">Change PIN</button><button class="btn danger" data-act="removePin">Turn off</button></div>`
  : `<p style="margin-bottom:12px">Lock the app with a 4 or 6 digit PIN. If you forget it, the only way back in is erasing data on this phone and restoring a backup.</p>
    <button class="btn primary block" data-act="setPin">Set PIN</button>`}
  </div>
  ${on ? `<div class="card"><div class="row"><div class="grow"><b>Fingerprint</b><div class="muted small">${S.settings.bioId ? 'On. Your PIN still works.' : 'Unlock with your fingerprint instead of typing the PIN.'}</div></div>
    ${S.settings.bioId ? '<button class="btn sm" data-act="bioOff">Turn off</button>' : '<button class="btn sm primary" data-act="bioOn">Turn on</button>'}</div></div>` : ''}`;
};

// ---------------- How to use (plain guide with examples) ----------------
const HELP = [
  ['Start here', [
    ['What is Hisaab for?', `<p>Hisaab keeps <b>your own spending</b> separate from money that only passes through your hands: loans, money the office will pay back, money you give someone to spend for you. So "Spent" always shows what really came out of your pocket.</p>`],
    ['First 5 minutes', `<ol><li>Open <b>☰ → Accounts</b> and type how much is in Cash, Bank, Easypaisa, JazzCash today.</li><li>Open <b>People</b> and add your family, friends, colleagues and the office. Pick the right type for each (see <b>Which type to choose for a person</b>).</li><li>Open <b>☰ → Areas</b> and add parts of your life you want totals for, e.g. <i>Home, Office, Car, Govt vehicle, Cat</i>.</li><li>Set up <b>☰ → Backup</b> so you never lose your records.</li></ol>`],
    ['The 4 tabs at the bottom', `<p><b>Home</b>: what you spent this period, alerts, recent entries.<br><b>People</b>: everyone you deal with and who owes whom.<br><b>+</b>: add anything.<br><b>Bills</b>: monthly bills, paid and unpaid, and money you are waiting for.<br><b>Insights</b>: where your money went.</p><p><b>☰</b> (top left of Home) has everything else: budgets, accounts, backup, settings. <b>🔥</b> (top right) is your streak.</p>`]
  ]],
  ['Everyday spending', [
    ['Add something I paid for myself', `<p><b>+</b> → type the amount → pick a category → <b>Save</b>. Nothing else is needed.</p><p class="ex">Example: Fuel Rs 4,500 from cash. Type 4500, tap <b>Fuel</b>, Paid from <b>Cash</b>, Save.</p>`],
    ['The Add screen', `<p>The arrows at the top choose the kind: <b class="in">↓ Income</b>, <b class="out">↑ Expense</b>, <b style="color:var(--move)">⇅ Transfer</b> between your own accounts. Type the amount, write a short note, pick the day (Today, Yesterday, 2 days ago or Pick), tap a category tile, then <b>✓</b>. An expense needs a category.</p><p>The chips change the account, area and project. Choosing a project fills in its usual area, and the category tiles move what you use most in that area or project to the front. A due bill shows as a tile with a <b>DUE</b> mark.</p><p>Keypad: <b>⌫</b> deletes, hold it to clear. <b>+</b> and <b>−</b> add up items. <b>Person</b> moves the amount to someone (loan, money for family); <b>Mine</b> brings it back.</p><p><b>⋯</b> top right: receipt photo, snap now and fill later, paste bank SMS, <b>Not paid yet</b>, save and add another. Closing with an amount typed asks before throwing it away.</p>`],
    ['Money I spend for work and claim later', `<p>Open <b>☰ → Areas</b>, edit the area (for example Govt vehicle, Govt residence or Office) and tick <b>Official: I pay now and claim it back later</b>, then choose the person you claim it from.</p><p>From then on every expense in that area is saved as a <b>claim</b> from that person. A green chip shows "Claim from …"; tap it when you paid from your own pocket.</p><p>That person's page shows <b>Official claims</b> (split by area) apart from <b>Personal</b> money such as a loan to them or a payment they asked you to make. When the money comes, tap <b>They paid back</b>.</p><p class="ex">Example: vehicle repair Rs 20,000 paid through your driver. Area Govt vehicle is official, claimed from the officer who reimburses you. The officer's page shows Official claims Rs 20,000 · Govt vehicle.</p>`],
    ['Fix several entries at once', `<p><b>All entries → Select</b>, tap the entries (or <b>All</b>), then <b>Change…</b> to set the area, project, category or who pays it back for all of them. Tick <b>Official claim</b> to turn them into claims.</p><p>To combine two areas or categories, edit one and use <b>Merge</b>. An area for work that ends (a house repair) can be <b>turned into a project</b> from the same place.</p>`],
    ['Check your data', `<p>When something makes your totals wrong, Home shows <b>Check your data</b>: accounts below zero, "Before Hisaab" used for recent payments, expenses without a category or area, a bill already paid but not linked, phone numbers in the wrong format. Each item opens where you fix it.</p>`],
    ['Several items in one entry', `<p>Type them with +: <b>1200+350+80</b>. The app adds them up and shows the total.</p>`],
    ['Keep a receipt photo', `<p>On the Add screen tap <b>⋯ → Snap receipt now, fill details later</b> to take the photo now and add the details later. Or tap <b>⋯ → Attach receipt photo</b> while adding. To send it to someone, open the entry → <b>Share receipt</b>.</p>`],
    ['Something I enter often (fuel, milk)', `<p>Nothing to set up: after you enter it twice it appears on Home under <b>Add again</b>. Tap it, check the amount, Save. To keep one there always, open any such entry → <b>Pin to Home</b>. <b>Edit</b> next to Add again removes pins. <b>Copy for today</b> in any entry repeats it once.</p>`],
    ['Area: Home, Office, Car…', `<p>The Area chip under the amount fills itself from the category: Fuel goes where you usually put fuel (e.g. Car), Grocery goes to Home. It never copies the area of your last entry. With no history it stays <b>None</b>; change it in one tap.</p><p class="ex">Example: Fuel for the govt vehicle → Area <i>Govt vehicle</i>. Next time you tap Fuel, Govt vehicle is already filled.</p>`],
    ['I saved or deleted something by mistake', `<p>Right after saving, tap <b>Undo</b> in the message at the bottom. Later, open the entry → <b>Edit</b> or <b>Delete</b>. Deleted entries wait 30 days in <b>☰ → Recently deleted</b>: tap <b>Restore</b> to bring one back.</p>`]
  ]],
  ['Family, friends and loans', [
    ['I spent on a family member (not coming back)', `<p>Open the person in <b>People</b> → <b>I gave / paid</b> → amount → <b>Not coming back</b> → category chip → ✓. Or on <b>+</b> type the amount and tap the <b>people key</b> on the keypad to pick the person.</p><p class="ex">Example: Ali's school fee Rs 6,500. It counts as your spending, and Insights → <b>Spent on people</b> shows how much went to Ali this month. Ali owes you nothing.</p>`],
    ['I lent money', `<p>Open the person in <b>People</b> → <b>I gave / paid</b> → <b>Coming back</b> → Save. (Same from + → amount → <b>people key</b>.) Their page shows "owes you".</p><p class="ex">Example: Lent Kashif Rs 10,000. People shows Kashif owes you Rs 10,000.</p>`],
    ['I borrowed money', `<p>Open the person → <b>I received</b> → <b>Lending me</b> → Save. (Same from + → <b>↓ Income</b> → amount → <b>people key</b>.) Their page shows "you owe".</p>`],
    ['I am paying back what I owe', `<p>Open the person → <b>I gave / paid</b> → <b>Paying back what I owe</b> (shown only when you owe them).</p>`],
    ['Someone paid me back', `<p>Open the person → <b>I received</b> → <b>Paying me back</b>. Or tap <b>Settle up</b> on their page: it fills the exact amount.</p>`],
    ['A friend paid for me (I owe him)', `<p>Open the friend in <b>People</b> → <b>I received</b> → <b>Paid for me</b>, then enter the amount and pick what it was. The account chip shows <b>Paid by</b> the friend. It counts as your spending and shows that you owe him.</p><p class="ex">Example: Kashif paid your dinner Rs 1,200 → Spent +1,200, you owe Kashif Rs 1,200.</p>`],
    ['I gave someone money to buy things for me', `<p>Open the person → <b>I gave / paid</b> → <b>To spend for me</b>.</p><p>When they tell you what they bought: <b>+</b> → amount → category → tap the account chip and pick that person (listed under "Money I gave them to spend"). Or on their page → <b>I received</b> → <b>They spent some of it for me</b>.</p><p>When they return the change: their page → <b>I received</b> → <b>Returning unused money</b>.</p><p class="ex">Example: Gave your brother Rs 5,000 for groceries. He spent Rs 4,200 and returned Rs 800. Spent shows Rs 4,200, and your brother's balance returns to zero.</p>`],
    ['Which type to choose for a person', `<p>The type only decides which option is already selected when you add money for them. You can change it on any entry.</p><p><b>Family / relative</b>: money you spend on them is not paid back (fees, gifts, treats).<br><b>Friend</b>: money you give is a loan that comes back.<br><b>Spends money for me</b>: you hand them cash to buy things or pay for work for you; they bring back bills or the change.<br><b>Office / company (pays me back)</b>: you spend on their work and they reimburse you.<br><b>Other</b>: shops, landlord, anyone else.</p><p class="ex">Example: Your brother → Family. Your driver who buys fuel with your cash → Spends money for me. Your department → Office / company.</p>`],
    ['See everything with one person', `<p>Open <b>People</b> → tap the name. You see what they owe or you owe, what's still to get back, what you spent on them, and the full history by month.</p>`],
    ['Send a statement on WhatsApp', `<p>Open the person → <b>Share</b> → WhatsApp message or PDF.</p>`],
    ['They promised to pay by a date', `<p>Open the person → <b>Edit</b> → <b>Payment promised by</b>. Home reminds you when the date passes.</p>`]
  ]],
  ['Office money', [
    ['I paid for office work and will be reimbursed', `<p>Open <b>Office</b> in People → <b>I gave / paid</b> → amount → <b>Coming back</b> (already selected for an office) → category and note chips → ✓. Or on <b>+</b> type the amount and tap the <b>people key</b>. It does not count as your spending.</p><p class="ex">Example: Office roof repair Rs 25,000. Office page shows "To get back Rs 25,000".</p>`],
    ['I paid for office work and will NOT be reimbursed', `<p>Same, but choose <b>Not coming back</b>. It counts as your spending, tagged Office.</p>`],
    ['The office paid me back', `<p>Open Office in People → <b>I received</b> → <b>Paying back items</b> → Save. Then check which items the money covers. Each item closes on its own; a part payment leaves the rest open. If they paid more than the items, the extra reduces what they owe.</p>`],
    ['I will never get it back', `<p>Open the item → <b>Won't get it back</b>. From then on it counts as your own spending.</p>`],
    ['Group costs of one job or site', `<p><b>☰ → Projects</b> → add one (e.g. "Canal bank repair"). Then pick it on the <b>Project</b> line under Area when adding entries (it shows once you have an open project, and always starts at None). The project page shows the total, your own share vs what will be repaid, what it went on, month by month, and cash still with your people. Add an <b>Estimate / budget</b> (Edit) to see how much of it is used. On the project page: <b>+ Spent</b>, <b>Gave to spend</b> (cash to someone for this project), <b>Got paid back</b>, and entries by month with filters. <b>Mark as finished</b> when done.</p>`]
  ]],
  ['Bills', [
    ['Add a monthly bill', `<p><b>Bills → + Add</b> → pick the type (Electricity, Gas, Internet…) → amount → due date → <b>How often: Every month</b>.</p>`],
    ['Track a vehicle (fuel, km per litre)', `<p>Make a project for the vehicle (e.g. "Govt vehicle") and tick <b>This is a vehicle</b>. When you add fuel with that project, type the <b>litres</b> and the <b>odometer</b> reading. The project page then shows km per litre, cost per km, km driven and a fuel log. Repairs on the same project count in the cost per km.</p>`],
    ['My bill amount changes every month', `<p>Pay it once with the real amount. From then on the next bill is <b>estimated</b> (≈) from your history: the same month last year if known, else the average of the last 3. When the bill arrives, open it in <b>Bills</b> and tap <b>Enter bill amount</b>, or just type the real amount when you tap Pay.</p><p>Tap any bill to see every month: average, highest, lowest, last bill vs the one before, units and cost per unit, and whether you paid late.</p><p class="ex">Example: LESCO was Rs 21,500 in March and Rs 6,100 in July. Next March the estimate starts from last March.</p>`],
    ['Reference no. and transaction ID', `<p>Add the <b>Reference / consumer no.</b> from the printed bill once (edit the bill). When you pay, tap <b>Copy</b> and paste it in your bank app.</p><p>After paying, add the bank's <b>Transaction ID</b> and, for electricity, gas or water, the <b>units</b>. Search in All entries finds both.</p>`],
    ['Add a payment from a bank SMS', `<p>Long-press the bank or wallet SMS → <b>Share</b> → <b>Hisaab</b> (the app must be installed to the home screen). Or copy the SMS and on the Add screen tap the <b>receipt icon</b> at the top (or <b>⋯ → Paste bank SMS</b>).</p><p>The amount, date, name, account and transaction ID fill in. Pick the account once for each A/C number; next time it is picked for you. If it matches a bill, the bill is marked paid. Sharing the same SMS twice will not add it twice.</p>`],
    ['I paid a bill from the + button', `<p>When a bill is due within a week, <b>Paying a bill?</b> appears in the form. Tap the bill: the amount fills in and the bill is marked paid. No double counting.</p>`],
    ['Money I am waiting for (TA, arrears)', `<p><b>Bills → Money coming in → + Add</b>. Or <b>+ → ↓ Income</b> → <b>⋯ → Not received yet</b>. It is listed in Bills under <b>Money coming in</b>; when it arrives tap <b>Received</b>.</p>`]
  ]],
  ['Seeing where money went', [
    ['Spending for a week, month or custom dates', `<p>On Home tap the period name (<b>This month ▾</b>) → This week, Last week, Last month, a past month or Custom dates. Use ‹ › to step back and forward.</p>`],
    ['Export to Excel or PDF', `<p><b>☰ → All entries</b> → set the month and filters → <b>Export</b> → Excel file (.csv) or PDF. An account's statement has its own <b>Export</b> under the account name. In Insights, <b>Share summary on WhatsApp</b> sends the month in a few lines.</p>`],
    ['What Insights shows', `<p>Three tabs. Swipe months with ‹ ›.</p><p><b>Overview</b>: how much you spent, a line showing your pace through the month against last month, where the month will end, income and saved, budget, a ring of categories (tap one for its entries), areas with their change from last month, bills, biggest expenses and month by month.<br><b>Projects</b>: each project or site with what it cost, your own share vs what will be repaid, what is still to get back, and cash still with your people.<br><b>People</b>: who owes you, whom you owe, and what you spent on each person.</p><p class="ex">Tip: touch any chart to see the exact amount.</p>`],
    ['Set a budget', `<p><b>☰ → Budgets</b> → <b>Set a monthly budget</b> for all spending, or <b>+ Budget for a category or area</b> (e.g. Fuel Rs 8,000). The line on each bar shows how far through the month you are: if the bar passes it, you are spending too fast.</p>`],
    ['What is the 🔥 streak?', `<p>Days in a row with something recorded. On a day with no spending tap <b>Nothing spent today</b>. Hollow dots are missed days: tap one to fill it in.</p>`]
  ]],
  ['Cash, bank and accounts', [
    ['Moving money between my accounts', `<p><b>+ → Transfer</b> → from → to → amount. Example: ATM withdrawal from Bank to Cash. It is not spending.</p>`],
    ['My cash or bank does not match', `<p><b>☰ → Accounts</b> → tap the account. Its statement shows every entry with the balance after it, month by month, so you can compare with your bank app. If it still differs, tap <b>Fix balance</b>, type what is really there, and one adjustment entry corrects it.</p>`],
    ['Old loans from before I used Hisaab', `<p>Add them as normal and, in Paid from / From account, choose <b>Old amount, from before I used Hisaab</b>. The person's balance updates without changing your cash.</p>`]
  ]],
  ['Keeping your data safe', [
    ['Where is my data kept?', `<p>On this phone, inside the browser you opened Hisaab with. Another browser, another phone, or an Incognito tab starts empty. Clearing Chrome's "site data" erases it. That's why backup matters.</p>`],
    ['Turn on automatic backup', `<p><b>☰ → Backup &amp; restore → Google Drive</b>. After that every change is saved to the "Hisaab Backups" folder in your Drive. The ☰ menu shows "Backed up today" when it's working.</p><p>Drive keeps one file per day for the last 15 days, so you can go back to an earlier day. Backup runs while the app is open; changes made offline are sent the next time you open it online. If changes wait more than a day, Home shows <b>Changes not backed up</b>: tap it. If Google asks you to sign in again, Home shows <b>Backup paused</b>: tap it once.</p>`],
    ['I see the Welcome screen and my entries are gone', `<p>Don't enter new balances yet. First, open Hisaab the same way as before (same icon, same browser, same link). If it's still empty, on the Welcome screen tap <b>Restore from backup</b> and choose Google Drive or your backup file.</p>`],
    ['Lock the app with a PIN or fingerprint', `<p><b>☰ → App lock → Set PIN</b>: type 4 digits (or tap "Use 6 digits"), then type it again. It moves on by itself, no OK button. Then you can turn on <b>fingerprint</b>. <b>☰ → Lock now</b> locks it straight away.</p><p>After 5 wrong tries the keypad waits 30 seconds. A forgotten PIN can't be recovered: erase data on the phone and restore your backup.</p>`]
  ]],
  ['Settings', [
    ['Bigger text, dark mode, currency', `<p><b>☰ → Preferences</b>: Appearance (same as phone, light, dark), Text size, Currency symbol, Number style (12,50,000 or 1,250,000).</p>`],
    ['Shortcuts on my home screen', `<p>Long-press the Hisaab icon for <b>Add expense</b>, <b>Bills</b> and <b>People</b>.</p>`],
    ['Add or rename categories and areas', `<p><b>☰ → Categories</b> or <b>☰ → Areas</b>. You can also tap <b>+ New</b> right in the form.</p>`]
  ]],
  ['Words used', [
    ['Spent', `<p>Only your own money: things you paid for yourself or others without getting it back, plus items written off. Loans, office claims and transfers are not counted.</p>`],
    ['To get back / owes you', `<p>Money that will come back to you, from a person or the office.</p>`],
    ['You owe', `<p>Money you borrowed, or that someone paid for you.</p>`],
    ['Account, Category, Area, For whom', `<p><b>Account</b>: where money sits (Cash, Bank). <b>Category</b>: what it was. <b>Area</b>: which part of life. <b>For whom</b>: the person it was for.</p>`]
  ]]
];
VIEWS.help = () => `<input class="inp" placeholder="Search help, e.g. loan, bill, backup" data-hq="1" style="margin-bottom:12px">
  <div id="helpBody">${HELP.map(([sec, items]) => `<div class="hsec"><div class="sec-title">${sec}</div>${items.map(([q, a]) => `<details class="hq"><summary>${q}</summary><div class="ha">${a}</div></details>`).join('')}</div>`).join('')}</div>
  <div class="empty" id="helpNone" hidden>Nothing found. Try another word.</div>
  <p class="muted small mt">Still stuck? Open the screen you're on and try it with a small amount. Undo takes it back.</p>`;
function filterHelp(q) {
  q = q.trim().toLowerCase(); let any = false;
  $$('#helpBody .hsec').forEach(sec => {
    let secAny = false;
    sec.querySelectorAll('.hq').forEach(d => { const hit = !q || d.textContent.toLowerCase().includes(q); d.hidden = !hit; d.open = !!q && hit; if (hit) secAny = true; });
    sec.hidden = !secAny; if (secAny) any = true;
  });
  $('#helpNone').hidden = any;
}

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

function confirmBox(title, msgHtml, okText = 'Confirm', danger = false, cancelText = 'Cancel') {
  return new Promise(res => {
    openSheet(`${sheetHead(esc(title))}<p style="margin-bottom:16px">${msgHtml}</p>
      <div class="btn-row"><button class="btn" data-act="closeSheet">${esc(cancelText)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-act="confirmOk">${esc(okText)}</button></div>`);
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
  if (e.personId) dl(e.type === 'recoverable' ? 'Get back from' : 'Person', esc(person(e.personId)?.name || '—'));
  if (e.bookId) dl('Area', esc(book(e.bookId)?.name || '—'));
  if (e.categoryId) dl('Category', `${esc(cat(e.categoryId)?.name || '—')} <button class="link small" data-act="catEntries" data-c="${e.categoryId}">all ›</button>`);
  if (e.workId) dl('Project', esc(work(e.workId)?.name || '—'));
  if (e.dueDate) dl('Return by', fmtDate(e.dueDate));
  if (REPEAT_LBL[e.repeat]) dl('Repeats', REPEAT_LBL[e.repeat]);
  if (e.note && e.note.trim().toLowerCase() !== entryTitle(e).trim().toLowerCase()) dl('Note', esc(e.note));
  const actions = [], minor = [];
  if (!e.draft && ['expense', 'income', 'recoverable', 'transfer', 'lent', 'advance'].includes(e.type)) minor.push(`<button class="link" data-act="copyEntry" data-id="${e.id}">Copy for today</button>`);
  if (!e.draft && e.type === 'expense') { const pinned = S.templates.some(t => t.name.toLowerCase() === entryTitle(e).toLowerCase()); minor.push(`<button class="link" data-act="pinEntry" data-id="${e.id}">${pinned ? 'Unpin' : 'Pin to Home'}</button>`); }
  if (e.receipt && navigator.share) minor.push(`<button class="link" data-act="shareReceipt" data-id="${e.id}">Share receipt</button>`);
  let extra = '';
  if (e.type === 'recoverable' && !e.draft) {
    const ri = recInfo(e);
    dl('Status', `<span class="badge ${ri.status}">${STATUS_LBL[ri.status] || ri.status}</span>`);
    dl('Paid back', money(ri.recovered));
    if (ri.writtenOff) dl('Written off', `${money(ri.writtenOff)} on ${fmtDate(e.writtenOff.date)}`);
    dl('Remaining', `<b>${money(ri.remaining)}</b>`);
    const recs = live().filter(x => x.type === 'recovery' && (x.allocations || []).some(a => a.id === e.id));
    if (recs.length) extra += `<div class="sec-title">Paid back so far</div><div class="card flush">${recs.map(r => { const a = r.allocations.find(a => a.id === e.id); return `<button class="list-item" data-act="openEntry" data-id="${r.id}"><div class="li-main"><div class="li-title">${fmtDate(r.date)}</div><div class="li-sub">${esc(acc(r.accountId)?.name || '')}</div></div><div class="li-amt in">${money(a.amount)}</div></button>`; }).join('')}</div>`;
    if (ri.remaining > 0) { actions.push(`<button class="btn primary" data-act="recoverOne" data-id="${e.id}">They paid back</button>`); minor.push(`<button class="link" data-act="writeOff" data-id="${e.id}">Won't get it back</button>`); }
    if (e.writtenOff) minor.push(`<button class="link" data-act="undoWriteOff" data-id="${e.id}">Undo write-off</button>`);
  }
  if (e.type === 'recovery') {
    extra += `<div class="sec-title">Applied to</div><div class="card flush">${(e.allocations || []).map(a => { const r = S.entries.find(x => x.id === a.id); return `<div class="list-item"><div class="li-main"><div class="li-title">${r ? esc(entryTitle(r)) : 'Deleted item'}</div><div class="li-sub">${r ? fmtDate(r.date) : ''}</div></div><div class="li-amt">${money(a.amount)}</div></div>`; }).join('') || '<div class="empty">None</div>'}</div>`;
  }
  if (e.type === 'expected' && !e.draft) {
    const xi = expectedInfo(e);
    dl('Settled so far', money(xi.got));
    dl('Remaining', money(xi.rem));
    if (!xi.closed) { actions.push(`<button class="btn primary" data-act="payExpected" data-id="${e.id}">${e.direction === 'out' ? 'Pay' : 'Receive'}</button>`); minor.push(`<button class="link" data-act="closeExp" data-id="${e.id}">Mark done</button>`); }
    else if (e.closed) actions.push(`<button class="btn" data-act="reopenExp" data-id="${e.id}">Reopen</button>`);
  }
  if (e.linkExpected) { const x = S.entries.find(y => y.id === e.linkExpected); if (x) dl(x.direction === 'out' ? 'For bill' : 'For expected', esc(entryTitle(x)) + ' · ' + monthLabel(x.date.slice(0, 7))); }
  if (e.ref) dl('Reference no.', `${esc(e.ref)} <button class="link small" data-act="copyRef" data-v="${esc(e.ref)}">Copy</button>`);
  if (e.txId) dl('Transaction ID', `${esc(e.txId)} <button class="link small" data-act="copyRef" data-v="${esc(e.txId)}">Copy</button>`);
  if (e.units) dl('Units used', String(e.units) + (e.amount ? ' · ' + money(Math.round(e.amount / e.units * 10) / 10) + ' per unit' : ''));
  if (TYPES[e.type]) actions.push(`<button class="btn ${e.draft ? 'primary' : ''}" data-act="editEntry" data-id="${e.id}">${e.draft ? 'Complete' : 'Edit'}</button>`);
  minor.push(`<button class="link danger" data-act="deleteEntry" data-id="${e.id}">Delete</button>`);
  if (e.history && e.history.length) {
    extra += `<div class="sec-title">Edit history</div><div class="card small">${e.history.map(h => `<div style="margin-bottom:6px"><b>${new Date(h.at).toLocaleString('en-GB')}</b><br>${Object.entries(h.changes).map(([k, [a, b]]) => `${esc(k)}: ${esc(fmtHist(k, a))} → ${esc(fmtHist(k, b))}`).join('<br>')}</div>`).join('')}</div>`;
  }
  openSheet(`${sheetHead(esc(entryTitle(e)))}<div class="card">${rows.join('')}</div>
    ${e.receipt ? `<div class="card"><img class="full" id="detailImg" alt="Receipt"></div>` : ''}
    ${extra}<div class="btn-row mt">${actions.join('')}</div><div class="linkrow minor">${minor.join('<span>·</span>')}</div>`);
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
  const ok = await confirmBox('Delete entry', `Delete "${esc(entryTitle(e))}" of ${money(e.amount)}?${linked ? ' Linked payments will be kept.' : ''} You can restore it from ☰ → Recently deleted for 30 days.`, 'Delete', true);
  if (!ok) return;
  const relink = linked ? S.entries.filter(x => x.linkExpected === id).map(x => x.id) : [];
  S.trash = [{ ...e, deletedAt: new Date().toISOString(), relink }, ...(S.trash || [])].slice(0, 300);
  S.entries = S.entries.filter(x => x.id !== id);
  if (linked) S.entries.forEach(x => { if (x.linkExpected === id) delete x.linkExpected; });
  if (e.linkExpected) { const x = S.entries.find(y => y.id === e.linkExpected); if (x && x.closed && expectedInfo(x).rem > 0) x.closed = false; }
  await save();
  closeSheet();
  toast('Deleted');
  render();
}

VIEWS.trash = () => {
  const T = S.trash || [];
  if (!T.length) return '<div class="empty">Nothing here. Deleted entries stay here for 30 days, then they are removed for good.</div>';
  return `<p class="muted small" style="margin:0 2px 10px">Kept for 30 days after you delete them.</p>
  <div class="list">${T.map(e => { const left = Math.max(0, 30 - daysBetween(e.deletedAt.slice(0, 10), today()));
    return `<div class="list-item">${entryIcon(e)}<div class="li-main"><div class="li-title">${esc(entryTitle(e))}</div><div class="li-sub">${fmtShort(e.date)} · ${typeLabel(e.type)} · ${left} day${left === 1 ? '' : 's'} left</div></div>
      <div class="li-amt">${money(e.amount)}<div><button class="btn sm" data-act="restoreTrash" data-id="${e.id}">Restore</button></div></div></div>`; }).join('')}</div>
  <button class="btn danger block mt" data-act="emptyTrash">Delete all forever</button>`;
};
async function restoreTrash(id) {
  const x = (S.trash || []).find(t => t.id === id); if (!x) return;
  if (S.entries.some(e => e.id === id)) { S.trash = S.trash.filter(t => t.id !== id); await save(); render(); return; }
  const { deletedAt, relink, ...e } = x;
  if (e.workId && !work(e.workId)) e.workId = ''; if (e.personId && !person(e.personId)) e.personId = '';
  S.entries.push(e);
  (relink || []).forEach(rid => { const p = S.entries.find(y => y.id === rid); if (p && !p.linkExpected) p.linkExpected = e.id; });
  if (e.linkExpected) afterExpectedPayment(e.linkExpected);
  S.trash = S.trash.filter(t => t.id !== id);
  await save(); toast('Restored'); render();
}

// Recovery allocation
function openRecovery(ids, pre) {
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
  if (pre) {
    $('#rcAmt').value = pre.amount; autoDistribute();
    if (pre.accountId && $('#rcAcc')) $('#rcAcc').value = pre.accountId;
    if (pre.date) $('#rcDate').value = pre.date;
    if (pre.note) $('#rcNote').value = pre.note;
    recState.afterForm = !!pre.after; recState.returnTo = pre.returnTo || null;
  }
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
  else if (diff > 0) el.innerHTML = `<span class="warn">${money(diff)} more than the items. ${$('#rcPerson') && $('#rcPerson').value ? 'It will reduce what they owe you.' : 'It will be saved as income.'}</span>`;
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
  if (extra > 0 && personId && person(personId)) S.entries.push({ id: uid(), type: 'received', amount: extra, date, accountId, personId, note: 'Paid with items' + (note ? ': ' + note : ''), createdAt: now, history: [] });
  else if (extra > 0) S.entries.push({ id: uid(), type: 'income', amount: extra, date, accountId, note: 'Extra with recovery' + (note ? ': ' + note : ''), categoryId: '', createdAt: now, history: [] });
  S.settings.last.accountId = accountId;
  ui.sel.clear();
  await save();
  closeSheet();
  toast('Saved. Remaining amount updated');
  if (recState.afterForm) {
    const ret = recState.returnTo; recState.afterForm = false; recState.returnTo = null; resetForm();
    if (ret) { tab = ret.tab; stack = ret.stack; cur = ret.cur; render(); } else if (stack.length) stepBack(); else setTab('home');
  } else render();
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
  const kind0 = p?.kind || (fromField === 'forId' && form.dir === 'out' ? 'family' : 'friend');
  openSheet(`${sheetHead(p ? 'Edit person' : 'New person')}
    <div class="field"><label>Name</label><input id="pName" value="${esc(p?.name || '')}" placeholder="Name, or office/company"></div>
    <div class="field"><label>Who is this?</label><input type="hidden" id="pKind" value="${kind0}">
      <div class="chips kindchips">${Object.entries(PERSON_KINDS).map(([k, v]) => `<button type="button" class="chip ${kind0 === k ? 'on' : ''}" data-act="pickKind" data-v="${k}">${v}</button>`).join('')}</div>
      <div class="type-hint" id="pKindHint" style="margin-top:8px">${KIND_HINT[kind0]}</div></div>
    <div class="field"><label>WhatsApp / phone (optional)</label><div class="phone-in">${'contacts' in navigator && navigator.contacts && 'select' in navigator.contacts ? '<button type="button" class="cbook" data-act="pickContact" aria-label="Choose from phone contacts"><svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="10" r="2.6"/><path d="M8 17c.6-2 2.1-3 4-3s3.4 1 4 3M3 7h2M3 12h2M3 17h2"/></svg></button>' : ''}<input id="pPhone" type="tel" value="${esc(p?.phone || '')}" placeholder="03xx xxxxxxx"></div></div>
    ${p ? `<div class="field"><label>Payment promised by (optional, clear to remove)</label><input id="pDue" type="date" value="${esc(p.dueDate || '')}"></div>` : ''}
    <div class="btn-row">${p ? `<button class="btn danger" data-act="deletePerson" data-id="${p.id}">Delete</button>` : ''}<button class="btn primary" data-act="savePerson" data-id="${p?.id || ''}">Save</button></div>`);
  setTimeout(() => $('#pName')?.focus(), 50);
}
async function savePerson(id) {
  const name = $('#pName').value.trim();
  if (!name) { toast('Enter a name'); return; }
  if (S.people.some(p => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) { toast('A person with this name exists'); return; }
  const data = { name, kind: $('#pKind').value, phone: normPhone($('#pPhone').value) };
  if ($('#pDue')) data.dueDate = $('#pDue').value || '';
  let pid = id;
  if (id) Object.assign(person(id), data);
  else { pid = uid(); S.people.push({ id: pid, ...data }); }
  await save();
  closeSheet();
  const fromForm = editorReturnField && cur.v === 'add';
  if (fromForm) { form[editorReturnField] = pid; if (editorReturnField === 'forId') { form.what = defaultWhat(pid, form.dir); applyWhat(); } }
  editorReturnField = null;
  toast('Saved');
  if (!id && !fromForm && cur.v === 'people') { go('person', pid); return; }
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
  openSheet(`${sheetHead(w ? 'Edit project' : 'New project / site')}
    <div class="field"><label>Name</label><input id="wName" value="${esc(w?.name || '')}" placeholder="e.g. Office repair, Wedding, Site name"></div>
    <div class="field"><label>Reference (optional)</label><input id="wRef" value="${esc(w?.ref || '')}" placeholder="Estimate or project no."></div>
    <div class="field"><label>Estimate / budget (optional)</label><input id="wBudget" inputmode="decimal" value="${w?.budget ? esc(String(w.budget)) : ''}" placeholder="Total you expect to spend"></div>
    <label class="inline-check"><input type="checkbox" class="check" id="wVehicle" ${w?.vehicle ? 'checked' : ''}> This is a vehicle (fuel log: litres, km, km per litre)</label>
    ${w ? `<label class="inline-check"><input type="checkbox" class="check" id="wClosed" ${w.closed ? 'checked' : ''}> Finished (hide from the Add screen)</label>` : ''}
    <div class="btn-row">${w ? `<button class="btn danger" data-act="deleteWork" data-id="${w.id}">Delete</button>` : ''}<button class="btn primary" data-act="saveWork" data-id="${w?.id || ''}">Save</button></div>`);
  setTimeout(() => $('#wName')?.focus(), 50);
}
async function saveWork(id) {
  const name = $('#wName').value.trim();
  if (!name) { toast('Enter a name'); return; }
  const bud = evalAmount($('#wBudget')?.value || ''); const data = { name, ref: $('#wRef').value.trim(), budget: bud > 0 ? bud : 0, vehicle: !!$('#wVehicle')?.checked };
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
  if (used) { toast(`Used in ${used} entries. Mark it finished instead.`); return; }
  if (!(await confirmBox('Delete project', 'Delete this project?', 'Delete', true))) return;
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
    ${kind === 'book' ? (() => { const hint = x && !x.official ? areaClaimHint(x.id) : '', cf = x?.claimFrom || hint;
      return `<label class="inline-check"><input type="checkbox" class="check" id="sOfficial" ${x?.official || hint ? 'checked' : ''} onchange="document.getElementById('sClaimRow').hidden=!this.checked"> Official: I pay now and claim it back later</label>
      <div class="field" id="sClaimRow" ${x?.official || hint ? '' : 'hidden'}><label>Claimed back from</label><select id="sClaimFrom"><option value="">Choose a person</option>${S.people.slice().sort((a, b) => (a.kind === 'org' ? -1 : 0) - (b.kind === 'org' ? -1 : 0) || a.name.localeCompare(b.name)).map(p => `<option value="${p.id}" ${cf === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <p class="muted small">New entries in this area are recorded as a claim from this person. You can switch it off for any entry.</p></div>
      ${hint && !x.official ? '<p class="muted small">Most entries in this area are claimed back, so this is ticked for you.</p>' : ''}
      <label class="inline-check"><input type="checkbox" class="check" id="sVehicle" ${x?.vehicle ? 'checked' : ''}> Track fuel &amp; km (car, bike, generator)</label>`; })() : ''}
    ${x && (kind === 'book' || kind === 'catout' || kind === 'catin' || kind === 'catbill') ? (() => { const others = arr.filter(o => o.id !== x.id && (kind === 'book' || o.kind === x.kind));
      return others.length ? `<details class="more-acts"><summary>Merge${kind === 'book' ? ' or turn into a project' : ''}</summary>
        <div class="field"><label>Merge into</label><div class="row-inline"><select id="sMerge">${others.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select><button class="btn" data-act="mergeSimple" data-kind="${kind === 'book' ? 'book' : 'cat'}" data-id="${x.id}">Merge</button></div></div>
        ${kind === 'book' ? `<div class="field"><label>Turn into a project (for work that ends, e.g. a house repair)</label><div class="row-inline"><select id="sToArea"><option value="">Entries keep no area</option>${others.map(o => `<option value="${o.id}">Area: ${esc(o.name)}</option>`).join('')}</select><button class="btn" data-act="areaToProject" data-id="${x.id}">Turn into project</button></div></div>` : ''}
      </details>` : ''; })() : ''}
    <div class="btn-row">${x ? `<button class="btn danger" data-act="deleteSimple" data-kind="${kind}" data-id="${x.id}">Delete</button>` : ''}<button class="btn primary" data-act="saveSimple" data-kind="${kind}" data-id="${x?.id || ''}">Save</button></div>`);
  setTimeout(() => $('#sName')?.focus(), 50);
}
async function saveSimple(kind, id) {
  const name = $('#sName').value.trim();
  if (!name) { toast('Enter a name'); return; }
  if (kind === 'book') {
    const opt = { name, official: !!$('#sOfficial')?.checked, claimFrom: $('#sOfficial')?.checked ? ($('#sClaimFrom')?.value || '') : '', vehicle: !!$('#sVehicle')?.checked };
    if (opt.official && !opt.claimFrom) { toast('Choose who you claim it from'); return; }
    if (id) Object.assign(book(id), opt); else S.books.push({ id: uid(), ...opt });
  }
  else {
    const usedC = new Set(S.categories.map(c => c.color)), color = $('#sColor') ? $('#sColor').value : (id && cat(id) ? cat(id).color : (PALETTE.find(c => !usedC.has(c)) || PALETTE[S.categories.length % PALETTE.length]));
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

// ---------------- v41: official claims, data checks, bulk edit, merge ----------------
const isClaim = e => e.type === 'recoverable' && !!e.claim;
function claimArea(bid) { const b = book(bid); return b && b.official && b.claimFrom && person(b.claimFrom) ? b : null; }
function claimOn(f) { return f.type === 'expense' && !f.forId && !f.viaFor && !f.linkExpected && !f.claimOff && !!claimArea(f.bookId); }
function claimSplit(pid) {
  const am = allocMap(); let claims = 0; const by = {};
  live().forEach(e => { if (isClaim(e) && e.personId === pid) { const r = recInfo(e, am).remaining; if (r > 0) { claims += r; const k = e.bookId && book(e.bookId) ? book(e.bookId).name : 'Other'; by[k] = r2((by[k] || 0) + r); } } });
  return { claims: r2(claims), by };
}
function firstAccDate() { let d = ''; for (const e of live()) if (e.accountId && !e.oldEntry && e.type !== 'expected' && (!d || e.date < d)) d = e.date; return d; }
function normPhone(s) {
  const raw = String(s || '').trim(); let d = raw.replace(/\D/g, '');
  if (!d) return raw;
  if (d.startsWith('0092')) d = d.slice(4); else if (d.startsWith('920')) d = d.slice(3); else if (d.startsWith('92')) d = d.slice(2); else if (d.startsWith('0')) d = d.slice(1);
  return /^3\d{9}$/.test(d) ? '+92' + d : raw;
}
const nm4 = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 4);
function billMatch(e) {
  if (!e || e.type !== 'expense' || e.linkExpected) return null;
  return live().filter(x => x.type === 'expected' && x.direction === 'out' && !expectedInfo(x).closed && Math.abs(daysBetween(x.date, e.date)) <= 15)
    .find(x => {
      const rem = expectedInfo(x).rem || x.amount, near = Math.abs(e.amount - rem) <= Math.max(1, rem * 0.25);
      const same = (x.categoryId && x.categoryId === e.categoryId) || (nm4(x.note).length >= 3 && nm4(x.note).slice(0, 3) === nm4(e.note).slice(0, 3));
      return near && same;
    }) || null;
}
const DC_PRED = {
  nocat: e => e.type === 'expense' && !e.categoryId && !e.draft,
  noarea: e => (e.type === 'expense' || isClaim(e)) && !e.bookId && !e.draft,
  old: e => { const fd = firstAccDate(); return !!(e.oldEntry && fd && e.date >= fd); },
  future: e => e.type !== 'expected' && e.date > today()
};
const DC_LBL = { nocat: 'No category', noarea: 'No area', old: 'Before Hisaab, dated after start', future: 'Future date' };
function dataChecks() {
  const out = [], ab = accountBalances(), L = live();
  if (L.length < 3) return out;
  const neg = S.accounts.filter(a => (ab[a.id] || 0) < 0), noOpen = S.accounts.every(a => !Number(a.opening));
  if (neg.length || noOpen) out.push({ t: neg.length ? `${neg.map(a => a.name).join(', ')} below zero` : 'Opening balances not set', s: 'Enter what each account held on your first day', act: 'data-act="go" data-v="accounts"' });
  for (const k of ['old', 'nocat', 'noarea', 'future']) {
    if (k === 'noarea' && !S.books.length) continue;
    const l = L.filter(DC_PRED[k]); if (!l.length) continue;
    const sum = money(r2(l.reduce((a, e) => a + e.amount, 0)));
    const t = { old: `${l.length} marked "Before Hisaab" but dated after you started`, nocat: `${l.length} expense${l.length > 1 ? 's' : ''} without a category`, noarea: `${l.length} without an area`, future: `${l.length} dated in the future` }[k];
    const s = { old: `${sum} never left any account. Open each and choose the account.`, nocat: `${sum} missing from category totals`, noarea: `${sum} missing from area totals`, future: 'Check the date' }[k];
    out.push({ t, s, act: `data-act="dcList" data-k="${k}"` });
  }
  const used = new Set();
  L.filter(e => e.type === 'expense' && !e.linkExpected).forEach(e => { const x = billMatch(e); if (x && !used.has(x.id)) { used.add(x.id); out.push({ t: `${entryTitle(x)} bill looks paid`, s: `${entryTitle(e)} · ${money(e.amount)} on ${fmtShort(e.date)}. Tap to link them.`, act: `data-act="dcLink" data-x="${x.id}" data-e="${e.id}"` }); } });
  const ph = S.people.filter(p => p.phone && normPhone(p.phone) !== p.phone);
  if (ph.length) out.push({ t: `${ph.length} phone number${ph.length > 1 ? 's' : ''} to tidy`, s: `${ph.map(p => p.name).join(', ')}. Tap to save as +92…`, act: 'data-act="dcPhones"' });
  return out;
}
VIEWS.datacheck = () => {
  const l = dataChecks();
  return `<p class="muted small" style="margin:0 2px 10px">These make your totals wrong. Each one opens where you can fix it.</p>
    ${l.length ? l.map(x => `<button class="alert" ${x.act}><span class="grow"><b>${esc(x.t)}</b><br><span class="small">${esc(x.s)}</span></span>›</button>`).join('') : '<div class="empty">All clear. Your data has nothing to fix.</div>'}`;
};
function bulkTargets() { return [...(ui.sel || [])].map(id => S.entries.find(e => e.id === id)).filter(Boolean); }
function bulkSheet() {
  const n = bulkTargets().length; if (!n) { toast('Select entries first'); return; }
  const o = (list, none, keep = true) => `${keep ? '<option value="__keep">Keep as is</option>' : ''}${none ? `<option value="">${none}</option>` : ''}${list.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}`;
  openSheet(`${sheetHead(`Change ${n} entr${n === 1 ? 'y' : 'ies'}`)}
    ${S.books.length ? `<div class="field"><label>Area</label><select id="bkBook">${o(S.books, 'No area')}</select></div>` : ''}
    ${S.works.length ? `<div class="field"><label>Project</label><select id="bkWork">${o(S.works.filter(w => !w.closed), 'No project')}</select></div>` : ''}
    <div class="field"><label>Category</label><select id="bkCat">${o(S.categories.filter(c => !c.bill && c.kind === 'out'), '')}</select></div>
    <div class="field"><label>Who pays it back</label><select id="bkWho"><option value="__keep">Keep as is</option><option value="__own">Nobody: my own spending</option>${S.people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
    <label class="inline-check"><input type="checkbox" class="check" id="bkClaim"> Official claim (paid for work, claimed later)</label>
    <p class="muted small">Entries already partly paid back keep their person. Area, project and category apply to expenses and money to get back.</p>
    <div class="btn-row mt"><button class="btn" data-act="closeSheet">Cancel</button><button class="btn primary" data-act="bulkApply">Apply</button></div>`);
}
async function bulkApply() {
  const B = $('#bkBook')?.value ?? '__keep', W = $('#bkWork')?.value ?? '__keep', C = $('#bkCat').value, P = $('#bkWho').value, official = $('#bkClaim').checked;
  const am = allocMap(), now = new Date().toISOString(); let n = 0, skipped = 0;
  for (const e of bulkTargets()) {
    const before = { type: e.type, bookId: e.bookId, workId: e.workId, categoryId: e.categoryId, personId: e.personId, claim: !!e.claim };
    const spend = e.type === 'expense' || e.type === 'recoverable';
    if (spend && B !== '__keep') e.bookId = B;
    if (spend && W !== '__keep') e.workId = W;
    if (spend && C !== '__keep' && C) e.categoryId = C;
    if (P !== '__keep') {
      const untouched = e.type !== 'recoverable' || recInfo(e, am).remaining === e.amount;
      if (P === '__own') { if (e.type === 'recoverable' && untouched && !e.oldEntry && (e.accountId || e.viaPersonId)) { e.type = 'expense'; delete e.personId; delete e.claim; } else if (e.type === 'recoverable') skipped++; }
      else if (spend && untouched) { e.type = 'recoverable'; e.personId = P; delete e.spentOn; if (official) e.claim = true; else delete e.claim; }
      else skipped++;
    } else if (e.type === 'recoverable' && official) e.claim = true;
    const after = { type: e.type, bookId: e.bookId, workId: e.workId, categoryId: e.categoryId, personId: e.personId, claim: !!e.claim };
    const ch = {}; for (const k in after) if ((before[k] || '') !== (after[k] || '')) ch[k] = [before[k] || '', after[k] || ''];
    if (Object.keys(ch).length) { e.history = [...(e.history || []), { at: now, changes: ch }]; n++; }
  }
  await save(); closeSheet(); ui.selMode = false; ui.sel = new Set();
  toast(`${n} changed${skipped ? ` · ${skipped} skipped (already paid back or no account)` : ''}`); render();
}
async function mergeInto(kind, id, target) {
  if (!target || target === id) { toast('Choose where to merge it'); return; }
  const isBook = kind === 'book', key = isBook ? 'bookId' : 'categoryId', arr = isBook ? S.books : S.categories;
  const from = arr.find(x => x.id === id), to = arr.find(x => x.id === target); if (!from || !to) return;
  const n = S.entries.filter(e => e[key] === id).length;
  if (!(await confirmBox(`Merge "${from.name}" into "${to.name}"?`, `${n} entr${n === 1 ? 'y moves' : 'ies move'} to "${to.name}" and "${from.name}" is removed.`, 'Merge'))) return;
  S.entries.forEach(e => { if (e[key] === id) e[key] = target; });
  S.templates.forEach(t => { if (t.data && t.data[key] === id) t.data[key] = target; });
  const abc = S.settings.areaByCat || {};
  if (isBook) { for (const c in abc) if (abc[c] === id) abc[c] = target; if (S.budgets.book[id]) { S.budgets.book[target] = (S.budgets.book[target] || 0) + S.budgets.book[id]; delete S.budgets.book[id]; } S.books = S.books.filter(b => b.id !== id); }
  else { if (abc[id] && !abc[target]) abc[target] = abc[id]; delete abc[id]; if (S.budgets.cat[id]) { S.budgets.cat[target] = (S.budgets.cat[target] || 0) + S.budgets.cat[id]; delete S.budgets.cat[id]; } S.categories = S.categories.filter(c => c.id !== id); }
  await save(); closeSheet(); toast('Merged'); render();
}
async function areaToProject(id) {
  const b = book(id); if (!b) return;
  const to = $('#sToArea')?.value || '', n = S.entries.filter(e => e.bookId === id).length;
  if (!(await confirmBox(`Turn "${b.name}" into a project?`, `${n} entr${n === 1 ? 'y goes' : 'ies go'} to the new project "${b.name}"${to ? ` with area "${bookName(to)}"` : ' with no area'}. The area is removed.`, 'Turn into project'))) return;
  let w = S.works.find(x => x.name.toLowerCase() === b.name.toLowerCase());
  if (!w) { w = { id: uid(), name: b.name, closed: false, ref: '' }; S.works.push(w); }
  S.entries.forEach(e => { if (e.bookId === id) { e.bookId = to; if (!e.workId) e.workId = w.id; } });
  const abc = S.settings.areaByCat || {}; for (const c in abc) if (abc[c] === id) delete abc[c];
  delete S.budgets.book[id]; S.books = S.books.filter(x => x.id !== id);
  await save(); closeSheet(); toast('Now a project'); render();
}
function projectArea(wid) {
  const n = {}; let best = '', bv = 0;
  live().forEach(e => { if (e.workId === wid && e.bookId && book(e.bookId)) { n[e.bookId] = (n[e.bookId] || 0) + 1; if (n[e.bookId] > bv) { bv = n[e.bookId]; best = e.bookId; } } });
  return best;
}
function areaClaimHint(bid) {
  // An area whose entries are usually claimed back from one person: suggest marking it official
  const l = live().filter(e => e.bookId === bid && (e.type === 'expense' || e.type === 'recoverable'));
  const c = l.filter(e => e.type === 'recoverable'); if (l.length < 3 || c.length / l.length < 0.6) return '';
  const n = {}; c.forEach(e => { n[e.personId] = (n[e.personId] || 0) + 1; });
  return Object.entries(n).sort((a, b) => b[1] - a[1])[0][0];
}


// ---------------- App updates ----------------
// An installed app on Android resumes from memory instead of reloading, so it can keep showing an old version.
// On start and whenever it comes back to the screen, compare with the version on the server and offer a one-tap update.
const APP_BUILD = 'hisaab-v41.1';
let updShown = false, updLast = 0;
async function checkForUpdate() {
  if (!location.protocol.startsWith('http') || updShown || Date.now() - updLast < 60000) return;
  updLast = Date.now();
  try {
    const t = await fetch('sw.js?check=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.text() : '');
    const v = (t.match(/VERSION = '([^']+)'/) || [])[1];
    if (v && v !== APP_BUILD) showUpdateBar(v);
  } catch (e) { /* offline */ }
}
function showUpdateBar(v) {
  updShown = true;
  const bar = document.createElement('div');
  bar.className = 'updbar'; bar.setAttribute('role', 'status');
  bar.innerHTML = `<span>A new version of Hisaab is ready</span><button type="button" class="btn primary sm" id="updNow">Update</button>`;
  document.body.appendChild(bar);
  bar.querySelector('#updNow').onclick = async () => {
    if (cur.v === 'add' && evalAmount(form.amount || '') > 0 && !(await confirmBox('Update now?', 'The entry you are typing will not be saved.', 'Update'))) return;
    bar.querySelector('#updNow').textContent = 'Updating…';
    try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) { await reg.update(); } } catch (e) { /* ignore */ }
    try { const keys = await caches.keys(); await Promise.all(keys.filter(k => k !== v).map(k => caches.delete(k))); } catch (e) { /* ignore */ }
    location.reload();
  };
}

// ---------------- Sharing & reports ----------------
function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('920')) d = '92' + d.slice(3);
  else if (d.startsWith('0')) d = '92' + d.slice(1);
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
  const say = l => ({ 'You gave': 'I gave you', 'Advance given': 'Advance to you', 'You paid back': 'I paid you', 'They lent you': 'You gave me', 'They paid back': 'You paid me', 'They paid for you': 'You spent for me', 'You paid for them': 'I paid on your behalf', 'Written off': 'Waived' }[l.label] || (l.label.startsWith('Paid back:') ? 'You repaid' : l.label));
  const body = last.map(l => `${fmtShort(l.date)}: ${say(l)} ${money(Math.abs(l.v))}${l.e.note && !l.label.startsWith('Paid back:') ? ' (' + l.e.note + ')' : ''}`).join('\n');
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
    lines.map(l => [fmtDate(l.date), esc(l.label) + (l.e.note && !l.label.startsWith('Paid back:') ? ' — ' + esc(l.e.note) : '') + (work(l.e.workId) ? ' [' + esc(work(l.e.workId).name) + ']' : ''), money(l.v, true), money(l.bal)]),
    bal > 0 ? `${esc(p.name)} owes ${money(bal)}` : bal < 0 ? `Owed to ${esc(p.name)}: ${money(-bal)}` : 'Settled');
}
function workText(wid) {
  const w = work(wid); const st = workStats(wid);
  const lines = [...st.entries].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-20).map(e => `${fmtShort(e.date)} · ${typeLabel(e.type)} · ${entryTitle(e)} · ${money(e.amount)}`);
  return `Project: ${w.name}${w.ref ? ' (' + w.ref + ')' : ''}\nAs of ${fmtDate(today())}\nTotal spent: ${money(st.total)}\nTo be repaid: ${money(st.rec)} (still to get back ${money(st.recPending)})\nAdvances given: ${money(st.adv)}\n\n${lines.join('\n')}`;
}
function printWork(wid) {
  const w = work(wid); const st = workStats(wid); const am = allocMap();
  printHTML(`Project report: ${w.name}`, `${w.ref ? 'Ref: ' + esc(w.ref) + ' · ' : ''}as of ${fmtDate(today())}`,
    [{ t: 'Date' }, { t: 'Type' }, { t: 'Detail' }, { t: 'Status' }, { t: 'Amount', n: 1 }],
    [...st.entries].sort((a, b) => (a.date < b.date ? -1 : 1)).map(e => [fmtDate(e.date), esc(typeLabel(e.type)), esc(entryTitle(e)) + (person(e.viaPersonId) ? ' (paid by ' + esc(person(e.viaPersonId).name) + ')' : ''), e.type === 'recoverable' ? recInfo(e, am).status : '', money(e.amount)]),
    `Total spent ${money(st.total)} · To be repaid ${money(st.rec)} · Still to get back ${money(st.recPending)} · Given to spend ${money(st.adv)}`);
}

function monthSummaryText(ym) {
  const [f, to] = monthBounds(ym), sp = spendMonth(ym), inc = incomeIn(f, to), prev = spendMonth(shiftYm(ym, -1));
  const top = Object.entries(sp.byCat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const areas = Object.entries(sp.byBook).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const ch = prev.total ? Math.round((sp.total - prev.total) / prev.total * 100) : null;
  const lines = [`*Hisaab · ${monthLabel(ym)}*`, `Spent: ${money(sp.total)}${ch === null ? '' : ` (${ch >= 0 ? '+' : ''}${ch}% vs ${monthLabel(shiftYm(ym, -1)).split(' ')[0]})`}`];
  if (inc) lines.push(`Income: ${money(inc)}`, `Saved: ${money(r2(inc - sp.total))}`);
  if (top.length) lines.push('', '*Top categories*', ...top.map(([id, v]) => `• ${catName(id)}: ${money(v)}`));
  if (areas.length > 1) lines.push('', '*By area*', ...areas.map(([id, v]) => `• ${bookName(id)}: ${money(v)}`));
  return lines.join('\n');
}

// ---------------- Export (Excel CSV / PDF) ----------------
function exportRows(opts) {
  if (opts.acc) {
    const id = opts.acc, ym = ui.accMonth || today().slice(0, 7), [f, to] = monthBounds(ym);
    const rows = live().filter(e => accEffect(e, id) !== 0 && e.date >= f && e.date <= to).sort((x, y) => (x.date < y.date ? -1 : 1));
    return { label: `${acc(id)?.name || 'Account'} · ${monthLabel(ym)}`, file: `hisaab-${(acc(id)?.name || 'account').toLowerCase().replace(/\W+/g, '-')}-${ym}`, list: rows, sign: e => accEffect(e, id) };
  }
  const F = ui.entryFilter || { month: today().slice(0, 7) };
  const list = filteredEntries(F).slice().reverse();
  const lbl = F.month ? monthLabel(F.month) : F.from ? (F.rangeLabel || F.from + ' – ' + F.to) : 'All dates';
  return { label: `Entries · ${lbl}`, file: `hisaab-${F.month || (F.from ? F.from + '_' + F.to : 'all')}`, list, sign: e => { const fl = entryFlow(e); return fl === 'in' ? e.amount : fl === 'out' ? -e.amount : 0; } };
}
function exportSheet(opts = {}) {
  ui.exportOpts = opts;
  const r = exportRows(opts);
  openSheet(`${sheetHead('Export')}<p class="muted small" style="margin-bottom:12px">${esc(r.label)} · ${r.list.length} entr${r.list.length === 1 ? 'y' : 'ies'}</p>
    <button class="btn primary block" data-act="exportCsv">Excel file (.csv)</button>
    <button class="btn block mt" data-act="exportPdf">PDF / print</button>
    <p class="muted small mt">The Excel file opens in Excel, Google Sheets or WPS. For PDF, choose “Save as PDF” in the print screen.</p>`);
}
async function exportCsv() {
  const r = exportRows(ui.exportOpts || {});
  const q = v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const head = ['Date', 'Type', 'Detail', 'Category', 'Area', 'Project', 'Person', 'Account', 'Out', 'In', 'Note', 'Transaction ID'];
  const lines = [head.join(',')].concat(r.list.map(e => { const v = r.sign(e); return [e.date, typeLabel(e.type), entryTitle(e), e.categoryId ? catName(e.categoryId) : '', e.bookId ? bookName(e.bookId) : '', work(e.workId)?.name || '', person(e.personId || e.viaPersonId || e.spentOn)?.name || '', acc(e.accountId)?.name || '', v < 0 ? -v : '', v > 0 ? v : '', e.note || '', e.txId || ''].map(q).join(','); }));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), name = r.file + '.csv';
  let shared = false;
  try { const file = new File([blob], name, { type: 'text/csv' }); if (navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) { await navigator.share({ files: [file], title: name }); shared = true; } } catch (e) { if (e && e.name === 'AbortError') return; }
  if (!shared) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); }
  closeSheet(); toast('Exported ' + name);
}
function exportPdf() {
  const r = exportRows(ui.exportOpts || {});
  let o = 0, i = 0; r.list.forEach(e => { const v = r.sign(e); if (v < 0) o = r2(o - v); else i = r2(i + v); });
  closeSheet();
  printHTML(r.label, `as of ${fmtDate(today())}`, [{ t: 'Date' }, { t: 'Detail' }, { t: 'Type' }, { t: 'Out', n: 1 }, { t: 'In', n: 1 }],
    r.list.map(e => { const v = r.sign(e); return [fmtDate(e.date), esc(entryTitle(e)) + (e.txId ? ' <small>(' + esc(e.txId) + ')</small>' : ''), esc(typeLabel(e.type)), v < 0 ? money(-v) : '', v > 0 ? money(v) : '']; }),
    `Out ${money(o)} · In ${money(i)} · ${r.list.length} entries`);
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
// ---------------- App lock: PIN keypad + fingerprint ----------------
let pinBuf = '', pinMode = null; // null = unlock, { step, first, len } = setting a PIN
const LOCK_MAX = 5, LOCK_WAIT = 30;
function lockFails() { try { return JSON.parse(localStorage.getItem('hisaab_pinfail') || '{"n":0,"until":0}'); } catch (e) { return { n: 0, until: 0 }; } }
function setLockFails(v) { try { localStorage.setItem('hisaab_pinfail', JSON.stringify(v)); } catch (e) { /* ignore */ } }
const B64 = { enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))), dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)) };
async function bioAvailable() {
  const secure = location.protocol === 'https:' || location.hostname === 'localhost';
  try { return secure && !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { return false; }
}
async function bioEnable() {
  try {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: 'Hisaab' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'Hisaab', displayName: 'Hisaab' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' }, timeout: 60000 } });
    if (!cred) return false;
    S.settings.bioId = B64.enc(cred.rawId); await save(); return true;
  } catch (e) { return false; }
}
async function bioUnlock() {
  if (!S.settings.bioId || $('#lock').hidden || pinMode) return;
  try {
    const ok = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), allowCredentials: [{ type: 'public-key', id: B64.dec(S.settings.bioId) }], userVerification: 'required', timeout: 60000 } });
    if (ok) unlockNow();
  } catch (e) { lockMsg('Use your PIN'); }
}
function lockMsg(t, bad) { const m = $('#lockMsg'); m.textContent = t || ''; m.classList.toggle('bad', !!bad); }
function unlockNow() {
  $('#lock').hidden = true; pinBuf = ''; lastHidden = 0; setLockFails({ n: 0, until: 0 });
  if (pendingRestore) { pendingRestore = false; openDriveRestore(); }
  else if (pendingAutoSync) { pendingAutoSync = false; maybeAutoSync(); }
}
function showLock() {
  pinBuf = ''; pinMode = null;
  $('#lockTitle').textContent = 'Enter your PIN';
  lockMsg('');
  $('#lockAlt').textContent = 'Forgot PIN?'; $('#lockAlt').dataset.act = 'forgotPin'; $('#lockAlt').style.visibility = '';
  $('#lock').hidden = false;
  drawKeypad(); drawPin(); lockCooldown();
  if (S.settings.bioId && !document.hidden) setTimeout(bioUnlock, 250);
}
function drawKeypad() {
  const left = pinMode ? `<button class="kp-txt" data-act="cancelPinSet">Cancel</button>`
    : S.settings.bioId ? `<button class="kp-bio" data-act="bioUnlock" aria-label="Unlock with fingerprint"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 11v3a8 8 0 0 1-1 4M8.5 8.5A5 5 0 0 1 17 12v1a14 14 0 0 1-.6 4M7 12a5 5 0 0 1 .3-1.7M5 18.5A12 12 0 0 0 7 13.5M15.5 20.5c.3-1 .5-2 .5-3M3.5 9.5a9.5 9.5 0 0 1 17 0M12 3a9 9 0 0 1 6 2.3M6 5.3A9 9 0 0 1 9 3.5"/></svg></button>`
    : '<span></span>';
  $('#keypad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(k => `<button data-act="pinKey" data-k="${k}">${k}</button>`).join('')
    + left + `<button data-act="pinKey" data-k="0">0</button><button class="kp-txt" data-act="pinKey" data-k="⌫" aria-label="Delete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 5H9l-6 7 6 7h12zM18 9l-6 6M12 9l6 6"/></svg></button>`;
}
function pinLenNow() { return pinMode ? pinMode.len : (S.settings.pinLen || 0); }
function drawPin() {
  const n = pinLenNow() || Math.max(4, pinBuf.length);
  $('#pinDots').innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < pinBuf.length ? 'f' : ''}"></i>`).join('');
}
function lockCooldown() {
  const f = lockFails(), left = Math.ceil((f.until - Date.now()) / 1000);
  const kp = $('#keypad'); if (!kp) return false;
  if (left > 0 && !pinMode) {
    kp.classList.add('off'); lockMsg(`Too many tries. Wait ${left} s`, true);
    clearTimeout(lockCooldown._t); lockCooldown._t = setTimeout(lockCooldown, 1000); return true;
  }
  if (kp.classList.contains('off')) { kp.classList.remove('off'); lockMsg(''); }
  return false;
}
async function pinKey(k) {
  if ($('#lock').hidden || (!pinMode && lockCooldown())) return;
  if (k === '⌫') pinBuf = pinBuf.slice(0, -1);
  else if (pinBuf.length < 8) pinBuf += k;
  drawPin();
  if (pinMode) { if (pinBuf.length === pinMode.len) setTimeout(pinSetStep, 120); return; }
  const need = S.settings.pinLen || 0;
  if (pinBuf.length >= 4 && (!need || pinBuf.length === need)) {
    const h = await hashPin(pinBuf, S.settings.pinSalt);
    if (h === S.settings.pinHash) unlockNow();
    else if (need || pinBuf.length === 8) failPin();
  }
}
function failPin() {
  const box = $('.lock-box');
  box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
  pinBuf = ''; drawPin();
  if (pinMode) return;
  const f = lockFails(); f.n++;
  if (f.n >= LOCK_MAX) { f.until = Date.now() + LOCK_WAIT * 1000; f.n = 0; setLockFails(f); lockCooldown(); return; }
  setLockFails(f);
  lockMsg(`Wrong PIN · ${LOCK_MAX - f.n} ${LOCK_MAX - f.n === 1 ? 'try' : 'tries'} left`, true);
  if (navigator.vibrate) navigator.vibrate(80);
}
function startSetPin(len = 4) {
  pinMode = { step: 1, first: '', len }; pinBuf = '';
  $('#lockTitle').textContent = 'Choose a PIN';
  lockMsg(`${len} digits`);
  $('#lockAlt').textContent = len === 4 ? 'Use 6 digits instead' : 'Use 4 digits instead'; $('#lockAlt').dataset.act = 'pinLenSwap'; $('#lockAlt').style.visibility = '';
  $('#lock').hidden = false;
  drawKeypad(); drawPin();
}
async function pinSetStep() {
  if (!pinMode || pinBuf.length !== pinMode.len) return;
  if (pinMode.step === 1) {
    pinMode = { ...pinMode, step: 2, first: pinBuf }; pinBuf = '';
    $('#lockTitle').textContent = 'Type it again'; lockMsg('To confirm'); $('#lockAlt').style.visibility = 'hidden';
    drawPin(); return;
  }
  if (pinBuf !== pinMode.first) { const len = pinMode.len; failPin(); startSetPin(len); lockMsg('PINs did not match. Choose again.', true); return; }
  S.settings.pinSalt = uid();
  S.settings.pinHash = await hashPin(pinBuf, S.settings.pinSalt);
  S.settings.pinLen = pinBuf.length;
  await save();
  pinMode = null; pinBuf = '';
  $('#lock').hidden = true; setLockFails({ n: 0, until: 0 });
  render();
  if (!S.settings.bioId && await bioAvailable() && await confirmBox('Use fingerprint too?', 'Unlock Hisaab with your fingerprint. Your PIN still works.', 'Use fingerprint')) {
    toast(await bioEnable() ? 'PIN and fingerprint set' : 'PIN set. Fingerprint not available.'); render();
  } else toast('PIN set');
}
let lastHidden = 0;
document.addEventListener('visibilitychange', () => {
  if (S && document.hidden && S.settings.drive.connected && S.settings.driveDirty && tokenValid()) { clearTimeout(driveTimer); driveBackup(false); }
  if (!S || !S.settings.pinHash) return;
  if (document.hidden) lastHidden = Date.now();
  else if (lastHidden && Date.now() - lastHidden > S.settings.lockAfter * 1000) showLock();
  else if (!$('#lock').hidden && S.settings.bioId && !pinMode) setTimeout(bioUnlock, 250);
});

// ---------------- Event handling ----------------
const ACT = {
  jump: el => { const t = el.dataset.tab; if (t === 'bills') ui.billFilter = 'unpaid'; jump(t); },
  tab: el => { const t = el.dataset.tab; if (t === 'people') ui.peopleSeg = 'people'; if (t === 'bills') ui.billFilter = 'unpaid';
    const ret = t === 'add' && cur.v !== 'add' && S.settings.onboarded ? { tab, stack: [...stack], cur: { ...cur } } : null;
    setTab(t); if (ret && ret.cur.v !== 'home') form.returnTo = ret; },
  go: el => go(el.dataset.v, el.dataset.p || null),
  back: () => { if (stack.length) history.back(); else back(); },
  goPending: el => {
    if (el.dataset.seg === 'rec') { ui.peopleF = 'owed'; ui.peopleQ = ''; jump('people'); }
    else { ui.billFilter = 'unpaid'; jump('bills'); }
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
    if (!form.bookTouched) form.bookId = areaForCat(form.categoryId);
    render();
  },
  toggleAddMore: async () => { S.settings.addMore = !S.settings.addMore; await saveRaw(); render(); },
  toggleAlerts: () => { ui.allAlerts = !ui.allAlerts; render(); },
  prefSheet: el => openPrefSheet(el.dataset.k),
  pickKind: el => { $('#pKind').value = el.dataset.v; $$('#sheet .kindchips .chip').forEach(c => c.classList.toggle('on', c === el)); $('#pKindHint').textContent = KIND_HINT[el.dataset.v] || ''; },
  addAgain: el => { const d = JSON.parse(el.dataset.d); openFormWith({ type: 'expense', ...d }); },
  openMenu: () => openMenu(),
  closeMenu: () => closeMenu('tap'),
  streakOpen: () => openSheet(`${sheetHead('Recording streak')}${streakHtml()}`),
  streakDay: el => {
    const d = el.dataset.d, ok = coveredDays().has(d), ns = (S.settings.noSpend || []).includes(d);
    if (ok && !ns) { ui.entryFilter = { month: '', from: d, to: d, rangeLabel: fmtDate(d), type: '', book: '', person: '', work: '', q: '', drafts: false, spentOnly: false }; go('entries'); return; }
    openSheet(`${sheetHead(fmtDate(d))}<p class="muted" style="margin-bottom:12px">${ns ? 'Marked as a day with no spending.' : 'Nothing recorded for this day.'}</p>
      <button class="btn primary block" data-act="addForDay" data-d="${d}">Add spending for this day</button>
      ${ns ? `<button class="btn block mt" data-act="unNoSpend" data-d="${d}">Unmark</button>` : `<button class="btn block mt" data-act="noSpend" data-d="${d}">Nothing spent that day</button>`}`);
  },
  addForDay: el => { closeSheet(); openFormWith({ date: el.dataset.d }); },
  noSpend: async el => {
    const d = el.dataset.d; S.settings.noSpend = [...new Set([...(S.settings.noSpend || []), d])].sort().slice(-400);
    await saveRaw(); closeSheet(); toast(d === today() ? 'Marked: nothing spent today' : 'Marked: nothing spent ' + fmtShort(d)); render();
    if (d !== today()) openSheet(`${sheetHead('Recording streak')}${streakHtml()}`);
  },
  unNoSpend: async el => { S.settings.noSpend = (S.settings.noSpend || []).filter(x => x !== el.dataset.d); await saveRaw(); closeSheet(); render(); },
  editBudget: el => openBudgetSheet(el.dataset.k || '', el.dataset.id || ''),
  saveBudget: async () => {
    const key = $('#bFor').value, amt = evalAmount($('#bAmt').value || '0');
    if (!key) { toast('Choose what the budget is for'); return; }
    if (!(amt >= 0)) { toast('Enter an amount'); return; }
    const [k, id] = key.split(':'); const B = S.budgets;
    if (k === 'total') B.total = amt; else { B[k] = B[k] || {}; if (amt > 0) B[k][id] = amt; else delete B[k][id]; }
    await save(); closeSheet(); toast(amt > 0 ? 'Budget saved' : 'Budget removed'); render();
  },
  removeBudget: async el => {
    const k = el.dataset.k, id = el.dataset.id, B = S.budgets;
    if (k === 'total') B.total = 0; else if (B[k]) delete B[k][id];
    await save(); closeSheet(); toast('Budget removed'); render();
  },
  setPref: async el => {
    const k = el.dataset.k, v = el.dataset.v, st = S.settings;
    if (k === 'theme') st.theme = v;
    if (k === 'text') st.textSize = Number(v);
    if (k === 'cur') st.currency = v;
    if (k === 'num') st.numStyle = v;
    await saveRaw(); closeSheet(); render();
  },
  toggleNum: async () => { S.settings.numStyle = S.settings.numStyle === 'intl' ? 'lakh' : 'intl'; await saveRaw(); render(); },
  pickSwatch: el => { $('#sColor').value = el.dataset.c; $$('#sheet .swatch').forEach(b => b.classList.toggle('on', b === el)); },
  goEntries: el => {
    const f = el.dataset.filter;
    ui.entryFilter = { month: today().slice(0, 7), type: '', book: '', person: '', work: '', q: '', drafts: f === 'draft', spentOnly: f === 'spent' };
    if (f === '' || f === 'draft') ui.entryFilter.month = f === 'draft' ? '' : today().slice(0, 7);
    if (f === 'spent' && cur.v === 'home') { const per = periodOf(curPeriod()); Object.assign(ui.entryFilter, { month: '', from: per.from, to: per.to, rangeLabel: per.label, book: el.dataset.book && !el.dataset.book.startsWith('_') ? el.dataset.book : '' }); }
    go('entries');
  },
  clearEF: () => { ui.entryFilter = null; render(); },
  dcList: el => { ui.entryFilter = { month: '', from: '', to: '', type: '', book: '', person: '', work: '', q: '', drafts: false, spentOnly: false, special: el.dataset.k }; go('entries'); },
  dcLink: async el => { const e = S.entries.find(x => x.id === el.dataset.e), x = S.entries.find(y => y.id === el.dataset.x); if (!e || !x) return; e.linkExpected = x.id; e.history = [...(e.history || []), { at: new Date().toISOString(), changes: { linkExpected: ['', x.id] } }]; afterExpectedPayment(x.id); await save(); toast('Linked to the bill'); render(); },
  dcPhones: async () => { S.people.forEach(p => { if (p.phone) p.phone = normPhone(p.phone); }); await save(); toast('Phone numbers tidied'); render(); },
  selMode: () => { ui.selMode = !ui.selMode; ui.sel = new Set(); render(); },
  selToggle: el => { const s = ui.sel || (ui.sel = new Set()), id = el.dataset.id; if (s.has(id)) s.delete(id); else s.add(id); el.classList.toggle('on', s.has(id)); el.setAttribute('aria-pressed', s.has(id)); const b = $('.selbar b'); if (b) b.textContent = s.size + ' selected'; const c = $('.selbar [data-act="bulkSheet"]'); if (c) c.disabled = !s.size; },
  selAll: () => { const l = filteredEntries(ui.entryFilter); ui.sel = ui.sel && ui.sel.size === l.length ? new Set() : new Set(l.map(e => e.id)); render(); },
  bulkSheet: () => bulkSheet(),
  bulkApply: () => bulkApply(),
  mergeSimple: el => mergeInto(el.dataset.kind, el.dataset.id, $('#sMerge')?.value),
  areaToProject: el => areaToProject(el.dataset.id),
  toggleClaim: () => { form.claimOff = !form.claimOff; render(); },
  toggleClaimFlag: () => { form.claim = !form.claim; render(); },
  dateQuick: el => { form.date = addDays(today(), -Number(el.dataset.n)); render(); },
  kp: el => { if (kpHeld) { kpHeld = false; return; } kpPress(el.dataset.k); },
  noteOpen: () => { ui.noteOpen = true; render(); setTimeout(() => $('.addnote')?.focus(), 30); },
  addMoreSheet: () => addMoreSheet(),
  setLater: () => { closeSheet(); if (formLocked()) return; form.later = true; deriveType(); render(); },
  pDir: el => { if (el.disabled || formLocked() || form.dir === el.dataset.v) return; form.dir = el.dataset.v; if (form.forId) { form.what = defaultWhat(form.forId, form.dir); applyWhat(); } else { form.kind = form.dir === 'in' ? 'person' : 'back'; form.viaFor = true; deriveType(); } render(); },
  toMe: () => { if (formLocked()) return; const keep = { amount: form.amount, date: form.date, note: form.note }; Object.assign(form, { forId: '', what: '', viaFor: false, forcedType: '', recoverFrom: '', forOpen: false, kind: form.dir === 'in' ? 'income' : 'me' }, keep); applyWhat(); render(); },
  toPersonPick: () => {
    if (!S.people.length) { openPersonEditor(null, 'forId'); return; }
    openSheet(`${sheetHead(form.dir === 'in' ? 'Money from whom?' : 'Money for whom?')}<p class="muted small" style="margin:-4px 0 10px">The amount you typed is kept.</p><div class="optlist">${S.people.slice().sort((a, b) => a.name.localeCompare(b.name)).map(p => `<button class="opt prow" data-act="setFor" data-id="${p.id}"><span class="ico av">${esc((p.name.trim()[0] || '?').toUpperCase())}</span><span>${esc(p.name)}</span></button>`).join('')}</div>
      <button class="btn block mt" data-act="forNew">+ New person</button>`);
  },
  shareMonth: el => openWhatsApp('', monthSummaryText(el.dataset.ym)),
  copyEntry: el => {
    const e = S.entries.find(x => x.id === el.dataset.id); if (!e) return;
    closeSheet();
    openFormWith({ type: e.type, amount: String(e.amount), date: today(), note: e.note || '', categoryId: e.categoryId || '', bookId: e.bookId || '', workId: e.workId || '',
      paidFrom: e.viaPersonId ? 'p:' + e.viaPersonId : e.accountId ? 'a:' + e.accountId : '', accountId: e.accountId || '', toAccountId: e.toAccountId || '',
      personId: e.type === 'recoverable' ? '' : (e.personId || ''), recoverFrom: e.type === 'recoverable' ? (e.personId || '') : e.type === 'expense' ? (e.spentOn || '') : '' });
    toast('Copied. Check the amount and Save.');
  },
  shareReceipt: async el => {
    const e = S.entries.find(x => x.id === el.dataset.id); if (!e || !e.receipt) return;
    try { const d = await loadImg(e.receipt); const blob = d instanceof Blob ? d : await (await fetch(d)).blob(); const f = new File([blob], `receipt-${e.date}.jpg`, { type: blob.type || 'image/jpeg' }); await navigator.share({ files: [f], title: entryTitle(e) }); } catch (err) { if (!err || err.name !== 'AbortError') toast('Could not share the photo'); }
  },
  exportEntries: () => exportSheet({}),
  exportCsv: () => exportCsv(),
  exportPdf: () => exportPdf(),
  restoreTrash: el => restoreTrash(el.dataset.id),
  emptyTrash: async () => {
    if (!(await confirmBox('Delete forever', `Remove ${S.trash.length} deleted entr${S.trash.length === 1 ? 'y' : 'ies'} for good? This cannot be undone.`, 'Delete forever', true))) return;
    for (const x of S.trash) if (x.receipt) { try { await DB.del('img', x.receipt); delete imgCache[x.receipt]; } catch (e) { /* ignore */ } }
    S.trash = []; await save(); toast('Emptied'); render();
  },
  accMonth: el => { if (el.disabled) return; ui.accMonth = shiftYm(ui.accMonth || today().slice(0, 7), Number(el.dataset.n)); if (ui.accMonth > today().slice(0, 7)) ui.accMonth = today().slice(0, 7); render(); },
  exportAcc: el => exportSheet({ acc: el.dataset.id }),
  openUnassigned: () => { ui.recFilter = 'open'; ui.recPerson = '_none'; go('pending'); },
  pinEdit: () => { ui.pinEdit = !ui.pinEdit; render(); },
  unpin: async el => { S.templates = S.templates.filter(t => t.id !== el.dataset.id); if (!S.templates.length) ui.pinEdit = false; await save(); render(); },
  pinEntry: async el => {
    const e = S.entries.find(x => x.id === el.dataset.id); if (!e) return;
    const name = entryTitle(e), have = S.templates.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (have) { S.templates = S.templates.filter(t => t !== have); await save(); closeSheet(); toast('Removed from Add again'); render(); return; }
    S.templates.push({ id: uid(), name, data: { type: e.type, amount: String(e.amount), paidFrom: e.viaPersonId ? 'p:' + e.viaPersonId : e.accountId ? 'a:' + e.accountId : '', accountId: e.accountId || '', bookId: e.bookId || '', categoryId: e.categoryId || '', workId: e.workId || '', note: e.note || '' } });
    await save(); closeSheet(); toast('Pinned to Add again on Home'); render();
  },
  allCats: () => { ui.allCats = !ui.allCats; render(); },
  catEntries: el => { ui.entryFilter = { month: today().slice(0, 7), type: '', book: '', person: '', work: '', q: '', drafts: false, spentOnly: false, cat: el.dataset.c }; go('entries'); },
  pasteSms: () => pasteSms(),
  smsFromBox: () => { const t = $('#smsText').value; closeSheet(); openFromSms(t); },
  smsDismiss: () => { form.sms = null; render(); },
  smsAttach: async el => {
    const x = S.entries.find(e => e.id === el.dataset.id); if (!x || !form.sms) return;
    if (form.sms.txId) { x.txId = form.sms.txId; x.history = [...(x.history || []), { at: new Date().toISOString(), changes: { txId: ['', form.sms.txId] } }]; }
    if (form.sms.digits && x.accountId) S.settings.acctDigits = { ...(S.settings.acctDigits || {}), [form.sms.digits]: x.accountId };
    await save(); form.sms = null; setTab('home'); toast(form.txId ? 'Transaction ID added to the existing entry' : 'Kept the existing entry'); openEntry(x.id);
  },
  copyRef: async el => { const v = (el.dataset.v || '').replace(/\s+/g, ''); try { await navigator.clipboard.writeText(v); toast('Copied ' + v); } catch (e) { toast(v); } },
  setBillAmt: el => {
    const x = S.entries.find(e => e.id === el.dataset.id); if (!x) return;
    openSheet(`${sheetHead('Amount on this bill')}<p class="muted small" style="margin-bottom:10px">${esc(entryTitle(x))} · ${monthLabel(x.date.slice(0, 7))}</p>
      <div class="field"><label>Amount</label><input id="billAmt" inputmode="decimal" value="${x.estimated ? '' : x.amount}" placeholder="${x.amount}"></div>
      <div class="field"><label>Due date</label><input type="date" id="billDue" value="${x.date}"></div>
      <div class="btn-row mt"><button class="btn" data-act="closeSheet">Cancel</button><button class="btn primary" data-act="saveBillAmt" data-id="${x.id}">Save</button></div>`);
    setTimeout(() => $('#billAmt')?.focus(), 60);
  },
  saveBillAmt: async el => {
    const x = S.entries.find(e => e.id === el.dataset.id); if (!x) return;
    const v = evalAmount($('#billAmt').value || ''), d = $('#billDue').value;
    if (!(v > 0)) { toast('Enter the amount on the bill'); return; }
    const ch = {}; if (v !== x.amount) ch.amount = [x.amount, v]; if (d && d !== x.date) ch.date = [x.date, d];
    x.amount = v; if (d) x.date = d; x.estimated = false;
    if (Object.keys(ch).length) x.history = [...(x.history || []), { at: new Date().toISOString(), changes: ch }];
    await save(); closeSheet(); toast('Bill amount saved'); render();
  },
  efDrop: el => { const F = ui.entryFilter, k = el.dataset.k; F[k] = (k === 'drafts' || k === 'spentOnly') ? false : ''; if (k === 'drafts' && !F.month && !F.from) F.month = today().slice(0, 7); render(); },
  efMonth: el => { if (el.disabled) return; const F = ui.entryFilter; F.month = shiftYm(F.month || today().slice(0, 7), Number(el.dataset.n)); render(); },
  efAllTime: () => { const F = ui.entryFilter; F.month = ''; F.from = ''; F.to = ''; render(); },
  efThisMonth: () => { const F = ui.entryFilter; F.month = today().slice(0, 7); F.from = ''; F.to = ''; render(); },
  efSheet: () => openSheet(efSheetHtml()),
  efSpent: el => { ui.entryFilter.spentOnly = el.checked; render(); },
  efReset: () => { const F = ui.entryFilter; Object.assign(F, { type: '', book: '', person: '', work: '', cat: '', spentOnly: false }); openSheet(efSheetHtml()); render(); },
  seg: el => { ui.pendingSeg = el.dataset.seg; render(); },
  openEntry: el => openEntry(el.dataset.id),
  editEntry: el => editEntry(el.dataset.id),
  deleteEntry: el => deleteEntry(el.dataset.id),
  closeSheet: () => closeSheet(),
  confirmOk: () => { const r = confirmBox._res; confirmBox._res = null; closeSheet(); if (r) r(true); },
  openInsights: () => { ui.insTab = 'overview'; go('insights'); insMonth = insYm(); render(); },
  insTab: el => { ui.insTab = el.dataset.t; ui.insAllCats = false; render(); window.scrollTo(0, 0); },
  insAllCats: () => { ui.insAllCats = !ui.insAllCats; render(); },
  insClosed: () => { ui.insClosed = !ui.insClosed; render(); },
  insBook: el => {
    const ym = insMonth || today().slice(0, 7), b = el.dataset.b;
    ui.entryFilter = { month: ym, type: '', book: b.startsWith('_') ? '' : b, person: '', work: '', q: '', drafts: false, spentOnly: true };
    go('entries');
  },
  perStep: el => {
    const P = curPeriod(), d = +el.dataset.d, t = today();
    if (P.k === 'week') { const ns = addDays(P.start, 7 * d); if (ns <= weekStart(t)) P.start = ns; }
    else if (P.k === 'month') { const ny = shiftYm(P.ym, d); if (ny <= t.slice(0, 7)) P.ym = ny; }
    render();
  },
  perPick: () => {
    const t = today(), cy = t.slice(0, 7), P = curPeriod(), per = periodOf(P);
    const opts = [['w0', 'This week'], ['w1', 'Last week'], ['m0', 'This month'], ['m1', 'Last month']];
    openSheet(`${sheetHead('Show spending for')}
      <div class="optlist">${opts.map(([k, l]) => `<button class="opt ${per.label === l ? 'on' : ''}" data-act="perSet" data-v="${k}">${l}</button>`).join('')}</div>
      <div class="sec-title">A past month</div>
      <div class="row"><input class="inp grow" type="month" id="perMonth" max="${cy}" value="${P.k === 'month' ? P.ym : cy}"><button class="btn" data-act="perMonthGo">Show</button></div>
      <div class="sec-title">Custom dates</div>
      <div class="two"><div class="field"><label>From</label><input type="date" id="perFrom" value="${P.k === 'custom' ? P.from : cy + '-01'}"></div><div class="field"><label>To</label><input type="date" id="perTo" value="${P.k === 'custom' ? P.to : t}"></div></div>
      <button class="btn block" data-act="perCustom">Show these dates</button>`);
  },
  perSet: el => {
    const t = today(), v = el.dataset.v;
    ui.period = v === 'w0' ? { k: 'week', start: weekStart(t) } : v === 'w1' ? { k: 'week', start: addDays(weekStart(t), -7) } : v === 'm1' ? { k: 'month', ym: shiftYm(t.slice(0, 7), -1) } : { k: 'month', ym: t.slice(0, 7) };
    closeSheet(); render();
  },
  perMonthGo: () => { const v = $('#perMonth').value; if (!v) return; ui.period = { k: 'month', ym: v > today().slice(0, 7) ? today().slice(0, 7) : v }; closeSheet(); render(); },
  perCustom: () => {
    let f = $('#perFrom').value, to = $('#perTo').value;
    if (!f || !to) { toast('Pick both dates'); return; }
    if (f > to) [f, to] = [to, f];
    ui.period = { k: 'custom', from: f, to }; closeSheet(); render();
  },
  undoSave: async () => {
    if (!undoSnap) return;
    S = JSON.parse(undoSnap); undoSnap = null;
    await save(); toast('Undone'); render();
  },
  peopleF: el => { ui.peopleF = el.dataset.v; render(); },
  pickBillSug: el => {
    const name = el.dataset.name, ex = S.categories.find(c => c.bill && c.name.toLowerCase() === name.toLowerCase());
    let id = ex && ex.id;
    if (!id) { id = uid(); S.categories.push({ id, name, kind: 'out', bill: true, color: '#868e96' }); }
    ACT.pickCat({ dataset: { id } });
  },
  settleUp: el => {
    const pid = el.dataset.p, bal = personBalances()[pid] || 0;
    if (!bal) return;
    openForPerson(pid, bal > 0 ? 'in' : 'out');
    form.amount = String(Math.round(Math.abs(bal))); render();
  },

  sharePerson: el => { const pid = el.dataset.p; openSheet(`${sheetHead('Share statement')}<button class="btn block" data-act="shareWA" data-p="${pid}">WhatsApp message</button><button class="btn block mt" data-act="printPerson" data-p="${pid}">PDF / print</button>`); },
  pickContact: async () => {
    try {
      const [c] = await navigator.contacts.select(['name', 'tel'], { multiple: false });
      if (!c) return;
      if (c.name && c.name[0] && !$('#pName').value.trim()) $('#pName').value = c.name[0];
      if (c.tel && c.tel[0]) $('#pPhone').value = c.tel[0].replace(/[^\d+]/g, '');
    } catch (e) { toast(window.top !== window ? 'Contacts open only in the installed app' : 'Allow Contacts for this app, then try again'); }
  },
  setPDir: el => { if (el.disabled || formLocked() || form.dir === el.dataset.v) return; form.dir = el.dataset.v; form.kind = 'person'; deriveType(); render(); },
  setDir: el => {
    if (el.disabled || formLocked() || form.dir === el.dataset.v) return;
    form.dir = el.dataset.v; form.kind = form.dir === 'out' ? 'me' : form.dir === 'in' ? 'income' : ''; form.later = false;
    Object.assign(form, { forId: '', what: '', viaFor: false, forcedType: '', recoverFrom: '' });
    deriveType(); render();
  },
  setFor: el => {
    if (el.disabled || formLocked()) return;
    const id = el.dataset.id || '';
    if (form.dir === 'move') form.dir = 'out';
    form.forId = id; form.what = id ? defaultWhat(id, form.dir) : ''; form.forOpen = !!id;
    closeSheet(); applyWhat(); render();
  },
  setDate: el => { form.date = el.dataset.v; render(); },
  useBill: el => {
    const x = S.entries.find(e => e.id === el.dataset.id); if (!x) return;
    const xi = expectedInfo(x);
    Object.assign(form, { linkExpected: x.id, categoryId: x.categoryId || form.categoryId, bookId: x.bookId || form.bookId, note: x.note || form.note });
    if (!form.amount) form.amount = String(xi.rem);
    if (x.accountId && acc(x.accountId)) { form.paidFrom = 'a:' + x.accountId; }
    deriveType(); render();
  },
  unlinkBill: () => { form.linkExpected = null; render(); },
  setWhat: el => {
    if (el.disabled || formLocked()) return;
    if (el.dataset.v === 'paidforme') { const id = form.forId; Object.assign(form, { dir: 'out', kind: 'me', forId: '', what: '', viaFor: false, forcedType: '', forOpen: false, recoverFrom: '', paidFrom: 'p:' + id }); deriveType(); render(); toast('Record what they paid for. You will owe them.'); return; }
    form.what = el.dataset.v; applyWhat(); render();
  },
  forOpen: () => { form.forOpen = true; render(); },
  personMoney: el => openForPerson(el.dataset.p, el.dataset.dir),
  forOther: () => {
    openSheet(`${sheetHead(form.dir === 'in' ? 'From whom?' : 'For whom?')}<div class="optlist">${S.people.slice().sort((a, b) => a.name.localeCompare(b.name)).map(p => `<button class="opt ${form.forId === p.id ? 'on' : ''}" data-act="setFor" data-id="${p.id}">${esc(p.name)} <span class="muted small">· ${esc(PERSON_KINDS[p.kind] || '')}</span></button>`).join('') || '<p class="muted">No people yet.</p>'}</div>
      <button class="btn block mt" data-act="forNew">+ New person</button>`);
  },
  spentOnList: el => { const ym = el.dataset.ym || today().slice(0, 7); ui.entryFilter = { month: ym, type: 'expense', book: '', person: el.dataset.p, work: '', q: '', drafts: false, spentOnly: false }; go('entries'); },
  forNew: () => { closeSheet(); openPersonEditor(null, 'forId'); },
  setKind: el => {
    if (el.disabled || formLocked() || form.kind === el.dataset.v) return;
    form.kind = el.dataset.v; deriveType(); render();
  },
  toggleLater: el => { if (formLocked()) return; form.later = el.checked; deriveType(); render(); },
  setField: el => { form[el.dataset.k] = el.dataset.val; if (el.dataset.k === 'direction') form.categoryId = ''; render(); },
  saveForm: () => saveForm(),
  saveNext: () => { if (sheetOpen) closeSheet(); saveForm(true); },
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
  wRestore: async () => { S.settings.onboarded = true; wiz = null; await saveRaw(); setTab('home'); go('backup'); },
  wSkip: async () => { S.settings.onboarded = true; wiz = null; await save(); setTab('home'); },
  wSample: async () => { S = sampleState(); await DB.clear('img'); await saveRaw(); wiz = null; resetForm(); setTab('home'); toast('Sample data loaded. Tap around!'); },
  clearSample: async () => {
    if (!(await confirmBox('Start fresh', 'Remove all sample data and set up with your own accounts?', 'Start fresh'))) return;
    const keep = { googleClientId: S.settings.googleClientId, numStyle: S.settings.numStyle, theme: S.settings.theme, textSize: S.settings.textSize, currency: S.settings.currency };
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
  pickReceipt: () => { if (sheetOpen) closeSheet(); $('#fileReceipt').click(); },
  removeReceipt: () => { if (sheetOpen) closeSheet(); form.receipt = ''; form.receiptData = ''; render(); },
  snap: () => { if (sheetOpen) closeSheet(); $('#fileSnap').click(); },
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
    const pre = { type: x.direction === 'out' ? 'expense' : 'income', amount: String(xi.rem), categoryId: x.categoryId || '', bookId: x.bookId || areaForCat(x.categoryId), note: x.note || '', linkExpected: x.id };
    if (x.accountId && acc(x.accountId)) { pre.paidFrom = 'a:' + x.accountId; pre.accountId = x.accountId; }
    openFormWith(pre);
  },
  closeExp: async el => { const x = S.entries.find(e => e.id === el.dataset.id); if (!x) return; closeExpected(x); await save(); closeSheet(); toast('Marked done'); render(); },
  reopenExp: async el => { const x = S.entries.find(e => e.id === el.dataset.id); if (!x) return; x.closed = false; await save(); closeSheet(); render(); },
  toggleExpClosed: () => { ui.expShowClosed = !ui.expShowClosed; render(); },
  shareWA: el => { closeSheet(); const p = person(el.dataset.p); openWhatsApp(p.phone, personStatementText(p.id)); },
  printPerson: el => { closeSheet(); printPerson(el.dataset.p); },
  shareWork: el => openWhatsApp('', workText(el.dataset.p)),
  addToWork: el => openFormWith({ type: 'expense', workId: el.dataset.p }),
  giveForWork: el => { openFormWith({ type: 'expense', workId: el.dataset.p, forOpen: true, what: 'spend' }); },
  recoverWork: el => openRecovery(live().filter(e => e.type === 'recoverable' && e.workId === el.dataset.p && recInfo(e).remaining > 0).map(e => e.id), { returnTo: { tab, stack: [...stack], cur: { ...cur } } }),
  toggleWorkDone: async el => { const w = work(el.dataset.p); if (!w) return; w.closed = !w.closed; await save(); toast(w.closed ? 'Marked as finished' : 'Reopened'); render(); },
  projF: el => { ui.projF = el.dataset.v; render(); },
  pjF: el => { ui.pjF = el.dataset.v; render(); },
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
  cancelPinSet: () => { pinMode = null; pinBuf = ''; $('#lock').hidden = true; drawKeypad(); },
  pinLenSwap: () => startSetPin(pinMode && pinMode.len === 4 ? 6 : 4),
  bioUnlock: () => bioUnlock(),
  bioOn: async () => { toast(await bioEnable() ? 'Fingerprint unlock is on' : 'Fingerprint not available on this phone'); render(); },
  bioOff: async () => { S.settings.bioId = ''; await save(); toast('Fingerprint unlock is off'); render(); },
  removePin: async () => {
    if (!(await confirmBox('Turn off PIN', 'Anyone with your phone will be able to open the app.', 'Turn off', true))) return;
    S.settings.pinHash = ''; S.settings.pinSalt = ''; S.settings.pinLen = 0; S.settings.bioId = ''; await save(); toast('PIN turned off'); render();
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
  if (undoSnap && !e.target.closest('.tundo')) { $('#toast').classList.remove('show'); undoSnap = null; }
  const fromMenu = menuOpen && !!e.target.closest('#menuPanel [data-act]');
  if (fromMenu) closeMenu('item');
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.closest('#lock') === null && !$('#lock').hidden && el.dataset.act !== 'forgotPin') return;
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'INPUT' && el.type === 'checkbox') { fn(el); return; }
  e.preventDefault();
  fn(el);
  if (fromMenu) setTimeout(() => { if (reuseHist) { reuseHist = false; dropHist(); } }, 0);
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.f) {
    const k = t.dataset.f;
    form[k] = t.type === 'checkbox' ? t.checked : t.value;
    if (k === 'amount') updateAmtPreview();
    if (k === 'paidFromWho') return;
    if (k === 'bookId') form.bookTouched = true;
    if (k === 'personId' && form.type === 'lent') { render(); return; }
    if (k === 'saveTpl') render();
    return;
  }
  if (t.dataset.hq) { filterHelp(t.value); return; }
  if (t.dataset.ui) {
    ui[t.dataset.ui] = t.value;
    if (t.dataset.ui === 'peopleQ') { const pos = t.selectionStart; render(); const n = $('[data-ui="peopleQ"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
    else render();
    return;
  }
  if (t.dataset.ef) {
    ui.entryFilter[t.dataset.ef] = t.value;
    if (t.dataset.efsheet) { render(); return; }
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
  if (t.dataset.f === 'paidFromWho') { form.paidFrom = t.value ? 'p:' + t.value : 'ask'; render(); return; }
  if (t.dataset.f === 'date' && t.classList.contains('dpick')) { form.date = t.value || today(); render(); return; }
  if (t.dataset.f === 'workId' && t.value === '__new') { t.value = form.workId || ''; openWorkEditor(null, true); return; }
  if (t.dataset.f && (t.closest('.achips') || t.closest('.dchips'))) { // v40 chips: store and redraw so the chip shows the new choice
    const k = t.dataset.f; form[k] = k === 'date' ? (t.value || today()) : t.value;
    if (k === 'bookId') { form.bookTouched = true; form.claimOff = false; }
    if (k === 'workId' && t.value && !form.bookTouched) { const pa = projectArea(t.value); if (pa) form.bookId = pa; }
    render(); return;
  }
  if (t.dataset.f && t.tagName === 'SELECT') {
    form[t.dataset.f] = t.value;
    if (t.dataset.f === 'paidFrom') { render(); return; }
    if (t.dataset.f === 'accountId') return;
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
  if (e.key === 'Enter' && cur.v === 'add' && e.target.dataset && e.target.dataset.f === 'amount') { e.preventDefault(); saveForm(); return; }
  // Add screen keypad from a physical keyboard (when not typing in another field)
  const tg = e.target, typing = tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT');
  if (cur.v === 'add' && !sheetOpen && !typing && $('.keypad2') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const k = e.key === 'Backspace' ? '⌫' : e.key === 'Delete' ? 'C' : e.key;
    if (/^[0-9.+\-]$/.test(k) || k === '⌫' || k === 'C') { e.preventDefault(); kpPress(k); }
    else if (k === 'Enter') { e.preventDefault(); saveForm(); }
  }
});
// Hold ⌫ to clear the amount
let kpHold = null, kpHeld = false;
document.addEventListener('pointerdown', e => {
  const b = e.target.closest && e.target.closest('.kp[data-k="⌫"]'); if (!b) return;
  kpHeld = false; clearTimeout(kpHold);
  kpHold = setTimeout(() => { kpHeld = true; kpPress('C'); if (navigator.vibrate) try { navigator.vibrate(15); } catch (_) {} }, 500);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => document.addEventListener(t, () => clearTimeout(kpHold), true));

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
  if (!d.email) { try { const j = await (await gapi('GET', `${DRV}/about?fields=user(emailAddress)`)).json(); if (j.user && j.user.emailAddress) d.email = j.user.emailAddress; } catch (e) { /* email is optional */ } }
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
  const qs = new URLSearchParams(location.search), shared = (qs.get('text') || qs.get('title')) ? [qs.get('title'), qs.get('text'), qs.get('url')].filter(Boolean).join(' ') : '';
  if (shared) history.replaceState({ h: 0 }, '', location.pathname);
  if (!qs.get('go') && !ar && !shared) restoreNav();
  render();
  let skip = false;
  try {
    const t = Number(sessionStorage.getItem('hisaab_skiplock') || 0);
    sessionStorage.removeItem('hisaab_skiplock');
    skip = !!ar && t > 0 && Date.now() - t < 3 * 60 * 1000;
  } catch (e) { /* ignore */ }
  const goParam = new URLSearchParams(location.search).get('go');
  if (goParam && S.settings.onboarded && ['add', 'bills', 'people'].includes(goParam)) { history.replaceState({ h: 0 }, '', location.pathname); setTab(goParam); }
  if (shared && S.settings.onboarded) openFromSms(shared);
  if (S.settings.pinHash && !skip) showLock();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  setTimeout(checkForUpdate, 2500);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (ar) await handleAuthReturn(ar);
  else maybeAutoSync();
}
window.Hisaab = { get S() { return S; }, accountBalances, personBalances, personLines, summary, recInfo, expectedInfo, evalAmount, ownSpending, workStats };
init();
