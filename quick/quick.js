/* Quick Expense — a phone-first companion to the Household Finance app.
   It lives on the same origin, so it shares localStorage (state + sync token)
   with the full app: log an expense here and it lands in the same private gist,
   syncing to every device. Appends are pull-merge-push so a quick entry on the
   phone never clobbers edits made on the desktop. */
"use strict";

const STORAGE_KEY = "household-finance-v2";
const SYNC_KEY = "household-finance-sync";
const GIST_FILE = "household-finance-state.json";
const GIST_DESCRIPTION = "Household Finance sync state";
const GH_API = "https://api.github.com";
const OWNERS = ["Garrett", "Lizzie", "Joint"];
const CLASSES = ["Need", "Want", "Savings"];
const STARTER_CATEGORIES = [
  ["Housing", "Need"], ["Utilities", "Need"], ["Groceries", "Need"],
  ["Dining Out", "Want"], ["Transportation", "Need"], ["Insurance", "Need"],
  ["Medical", "Need"], ["Pets", "Need"], ["Subscriptions", "Want"],
  ["Personal - Garrett", "Want"], ["Personal - Lizzie", "Want"], ["Gifts", "Want"],
  ["Travel", "Want"], ["Household", "Need"], ["Debt Payments", "Need"],
  ["Savings", "Savings"], ["Misc", "Want"],
];
const DEFAULT_CLASS_BY_NAME = Object.fromEntries(STARTER_CATEGORIES);

function freshState() {
  let n = 0;
  return {
    household: "Garrett & Lizzie",
    taxRate: 0,
    categories: STARTER_CATEGORIES.map(([name, cls]) => ({ id: `seed-${++n}`, name, limit: 0, class: cls })),
    spending: [], income: [], oneTimeIncome: [], bills: [], debts: [], goals: [],
    updatedAt: 0,
  };
}

let state;
try { state = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { state = null; }
if (!state || typeof state !== "object") state = freshState();
for (const k of ["categories", "spending", "income", "oneTimeIncome", "bills", "debts", "goals"]) {
  if (!Array.isArray(state[k])) state[k] = [];
}
if (typeof state.updatedAt !== "number") state.updatedAt = 0;
if (typeof state.taxRate !== "number") state.taxRate = 0;
if (!state.categories.length) state.categories = freshState().categories;
state.categories.forEach((c) => { if (!CLASSES.includes(c.class)) c.class = DEFAULT_CLASS_BY_NAME[c.name] || "Need"; });

let syncCfg;
try { syncCfg = JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch { syncCfg = {}; }
const saveSyncCfg = () => localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg));
const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
const isConnected = () => Boolean(syncCfg.token && syncCfg.gistId);
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtMoney = (v) => (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Theme: honor the toggle the full app saved (same origin, same key).
{
  const t = localStorage.getItem("household-finance-theme");
  if (t) document.documentElement.dataset.theme = t;
}

// ---------- Gist helpers (same contract as the full app) ----------

function ghHeaders(t) {
  return { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
}
async function ghVerifyToken(t) {
  const r = await fetch(`${GH_API}/user`, { headers: ghHeaders(t) });
  if (r.status === 401) throw new Error("Token rejected — it needs the 'gist' scope.");
  if (!r.ok) throw new Error(`GitHub error ${r.status}`);
  return (await r.json()).login;
}
async function ghFindOrCreateGist(t) {
  const l = await fetch(`${GH_API}/gists?per_page=100`, { headers: ghHeaders(t) });
  if (!l.ok) throw new Error(`Listing gists failed (${l.status})`);
  const ex = (await l.json()).find((g) => g.files && GIST_FILE in g.files);
  if (ex) return ex.id;
  const c = await fetch(`${GH_API}/gists`, {
    method: "POST",
    headers: { ...ghHeaders(t), "Content-Type": "application/json" },
    body: JSON.stringify({ description: GIST_DESCRIPTION, public: false, files: { [GIST_FILE]: { content: "{}" } } }),
  });
  if (!c.ok) throw new Error(`Creating the gist failed (${c.status})`);
  return (await c.json()).id;
}
async function ghPull() {
  const r = await fetch(`${GH_API}/gists/${syncCfg.gistId}`, { headers: ghHeaders(syncCfg.token) });
  if (r.status === 401) throw new Error("Token no longer valid — reconnect.");
  if (!r.ok) throw new Error(`Pull failed (${r.status})`);
  const c = (await r.json()).files?.[GIST_FILE]?.content;
  if (!c) return null;
  try { return JSON.parse(c); } catch { return null; }
}
async function ghPush(content) {
  const r = await fetch(`${GH_API}/gists/${syncCfg.gistId}`, {
    method: "PATCH",
    headers: { ...ghHeaders(syncCfg.token), "Content-Type": "application/json" },
    body: JSON.stringify({ files: { [GIST_FILE]: { content } } }),
  });
  if (!r.ok) throw new Error(`Push failed (${r.status})`);
}

function buildPayload() {
  return JSON.stringify({
    version: 2, updatedAt: state.updatedAt ?? Date.now(), household: state.household,
    taxRate: state.taxRate ?? 0,
    categories: state.categories, spending: state.spending, income: state.income,
    oneTimeIncome: state.oneTimeIncome, bills: state.bills, debts: state.debts, goals: state.goals,
  });
}

function adoptRemote(remote) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  state = {
    household: String(remote.household ?? "Garrett & Lizzie"),
    taxRate: typeof remote.taxRate === "number" ? remote.taxRate : 0,
    categories: arr(remote.categories), spending: arr(remote.spending),
    income: arr(remote.income), oneTimeIncome: arr(remote.oneTimeIncome),
    bills: arr(remote.bills), debts: arr(remote.debts), goals: arr(remote.goals),
    updatedAt: typeof remote.updatedAt === "number" ? remote.updatedAt : Date.now(),
  };
  state.income.forEach((r) => { if (!r.frequency) r.frequency = "Monthly"; });
  if (!state.categories.length) state.categories = freshState().categories;
  state.categories.forEach((c) => { if (!CLASSES.includes(c.class)) c.class = DEFAULT_CLASS_BY_NAME[c.name] || "Need"; });
  persist();
}

// ---------- Sync ----------

let badgeState = "ok"; // ok | syncing | error

function setBadge() {
  const b = $("syncBadge");
  if (!isConnected()) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = badgeState === "syncing" ? "⟳ Syncing…" : badgeState === "error" ? "⚠ Not synced" : "☁ Synced";
  b.className = "sync-badge" + (badgeState === "error" ? " err" : "");
}

// Append merge: pull latest, adopt it if newer, make sure our new expense rows
// are in it, then push. So the phone never overwrites desktop edits it hadn't seen.
async function syncAppend(newRows) {
  const rows = Array.isArray(newRows) ? newRows : [newRows];
  badgeState = "syncing"; setBadge();
  const remote = await ghPull();
  if (remote && (remote.updatedAt ?? 0) > (state.updatedAt ?? 0)) {
    adoptRemote(remote);
    for (const nr of rows) if (!state.spending.some((s) => s.id === nr.id)) state.spending.push(nr);
  }
  state.updatedAt = Date.now();
  persist();
  await ghPush(buildPayload());
  syncCfg.lastSyncedStamp = state.updatedAt;
  syncCfg.lastSyncedAt = new Date().toISOString();
  saveSyncCfg();
  badgeState = "ok"; setBadge();
}

// Gross-up: spread tax across the taxable lines (or all lines if none marked)
// and fold each line's share in. Same rule as the full app.
function computeSplit(d) {
  const lines = d.lines.map((l) => ({ ...l, amt: +l.amount || 0 }));
  const marked = lines.filter((l) => l.taxable);
  const baseLines = marked.length ? marked : lines;
  const baseSum = baseLines.reduce((s, l) => s + l.amt, 0);
  const taxTotal = d.taxMode === "amount" ? (+d.taxValue || 0) : baseSum * ((+d.taxValue || 0) / 100);
  const out = lines.map((l) => {
    const tax = baseLines.includes(l) && baseSum > 0 ? taxTotal * (l.amt / baseSum) : 0;
    return { ...l, tax, total: l.amt + tax };
  });
  const subtotal = lines.reduce((s, l) => s + l.amt, 0);
  return { lines: out, subtotal, taxTotal, grandTotal: subtotal + taxTotal };
}

// ---------- UI ----------

function fillSelects() {
  const cat = $("category");
  cat.innerHTML = state.categories.map((c) => `<option>${esc(c.name)}</option>`).join("");
  const groceries = [...cat.options].find((o) => o.value === "Groceries");
  if (groceries) groceries.selected = true;
  const acc = $("account");
  acc.innerHTML = OWNERS.map((o) => `<option ${o === "Joint" ? "selected" : ""}>${o}</option>`).join("");
}

function renderRecent() {
  const list = $("recentList");
  const rows = [...state.spending].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  if (!rows.length) { list.innerHTML = `<li class="q-empty">No expenses yet.</li>`; return; }
  list.innerHTML = rows.map((r) => `<li>
    <span class="q-r-main">
      <span class="q-r-desc">${esc(r.desc || r.category)}</span>
      <span class="q-r-cat">${esc(r.category)} · ${esc(r.date)}</span>
    </span>
    <span class="q-r-amt">${fmtMoney(r.amount)}</span>
  </li>`).join("");
}

function toast(msg, kind = "ok") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "q-toast " + kind;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

function renderSyncArea() {
  const area = $("syncArea");
  if (isConnected()) {
    const when = syncCfg.lastSyncedAt ? new Date(syncCfg.lastSyncedAt).toLocaleString() : "not yet";
    area.innerHTML = `
      <div>Syncing as <strong>${esc(syncCfg.login || "?")}</strong>. Last synced ${esc(when)}.</div>
      <div class="muted">Every expense you add here syncs to the shared household copy.</div>
      <button class="q-btn ghost" id="qDisconnect">Disconnect this phone</button>`;
    $("qDisconnect").addEventListener("click", () => {
      if (!confirm("Stop syncing on this phone? Entries still save here, they just won't sync until you reconnect.")) return;
      syncCfg = {}; saveSyncCfg(); setBadge(); renderSyncArea();
    });
  } else {
    area.innerHTML = `
      <div class="muted">Connect with the same GitHub account you used in the full app, and expenses added here sync to your shared household.</div>
      <input id="qToken" type="password" placeholder="GitHub token (gist scope)" autocomplete="off" style="font:inherit;font-size:16px;padding:11px;border-radius:10px;border:1px solid var(--axis);background:var(--page);color:var(--text-primary);width:100%;" />
      <button class="q-btn primary" id="qConnect">Connect</button>
      <div class="muted"><a href="https://github.com/settings/tokens/new?scopes=gist&description=Household%20Finance%20sync" target="_blank" rel="noopener">Create a token →</a> or just set up sync once in the full app on this phone.</div>`;
    $("qConnect").addEventListener("click", async () => {
      const tok = $("qToken").value.trim();
      if (!tok) return alert("Paste your GitHub token first.");
      const btn = $("qConnect"); btn.disabled = true; btn.textContent = "Connecting…";
      try {
        const login = await ghVerifyToken(tok);
        const gistId = await ghFindOrCreateGist(tok);
        syncCfg = { token: tok, gistId, login, lastSyncedStamp: 0 };
        saveSyncCfg();
        const remote = await ghPull();
        if (remote && (remote.updatedAt ?? 0) > (state.updatedAt ?? 0)) adoptRemote(remote);
        else { state.updatedAt = Date.now(); persist(); await ghPush(buildPayload()); syncCfg.lastSyncedStamp = state.updatedAt; }
        syncCfg.lastSyncedAt = new Date().toISOString(); saveSyncCfg();
        badgeState = "ok"; setBadge();
        fillSelects(); renderRecent(); renderSyncArea();
        toast("Connected & synced ✓");
      } catch (e) {
        alert("Couldn't connect: " + (e.message || e));
        btn.disabled = false; btn.textContent = "Connect";
      }
    });
  }
}

// ---------- Init ----------

$("date").value = new Date().toISOString().slice(0, 10);
fillSelects();
renderRecent();
renderSyncArea();
setBadge();

// Optimistic save + sync for one or more rows, shared by single and split.
async function commitRows(rows) {
  rows.forEach((r) => state.spending.push(r));
  persist();
  renderRecent();
  const many = rows.length > 1;
  if (isConnected()) {
    try {
      await syncAppend(rows);
      renderRecent();
      toast(many ? `Saved & synced ${rows.length} lines ✓` : "Saved & synced ✓");
    } catch (e) {
      state.updatedAt = Date.now(); persist(); // mark dirty for a later sync
      badgeState = "error"; setBadge();
      toast("Saved on phone — will sync later", "warn");
    }
  } else {
    state.updatedAt = Date.now(); persist();
    toast(many ? `Saved ${rows.length} lines on this phone` : "Saved on this phone");
  }
}

$("expForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const amount = +$("amount").value;
  const desc = $("desc").value.trim();
  if (!(amount > 0) || !desc) return;
  const rec = {
    id: uid(),
    date: $("date").value || new Date().toISOString().slice(0, 10),
    desc, category: $("category").value, account: $("account").value, amount,
  };
  $("amount").value = "";
  $("desc").value = "";
  $("amount").focus();
  await commitRows([rec]);
});

// ---------- Split receipt (phone) ----------

let splitDraft = freshSplit();
function freshSplitLine() {
  const cat = state.categories.find((c) => c.name === "Groceries")?.name || state.categories[0]?.name || "";
  return { id: uid(), desc: "", category: cat, amount: "", taxable: false };
}
function freshSplit() {
  return {
    date: new Date().toISOString().slice(0, 10),
    account: "Joint", taxMode: "rate", taxValue: state.taxRate || 0,
    lines: [freshSplitLine(), freshSplitLine()],
  };
}

function splitLinesHtml(d) {
  const cats = state.categories.map((c) => c.name);
  return d.lines.map((l) => `<div class="q-splitline" data-line="${l.id}">
    <input class="sp-desc" placeholder="(optional) e.g. Paper towels" value="${esc(l.desc)}">
    <div class="q-splitrow">
      <select class="sp-cat">${cats.map((n) => `<option ${n === l.category ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
      <input class="sp-amt" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="${l.amount}">
      <label class="sp-taxwrap"><input type="checkbox" class="sp-tax" ${l.taxable ? "checked" : ""}> tax</label>
      <button type="button" class="sp-del" title="Remove">✕</button>
    </div>
    <div class="sp-withtax muted"></div>
  </div>`).join("");
}

function renderSplit() {
  const d = splitDraft;
  $("splitSection").innerHTML = `<div class="q-form">
    <div class="q-row">
      <div class="q-field"><label>Date</label><input id="spDate" type="date" value="${d.date}"></div>
      <div class="q-field"><label>Account</label><select id="spAccount">${OWNERS.map((o) => `<option ${o === d.account ? "selected" : ""}>${o}</option>`).join("")}</select></div>
    </div>
    <div id="spLines">${splitLinesHtml(d)}</div>
    <button type="button" class="q-btn ghost" id="spAdd">＋ Add line</button>
    <div class="q-field"><label>Tax</label>
      <div style="display:flex;gap:8px">
        <select id="spTaxMode" style="flex:0 0 auto">
          <option value="rate" ${d.taxMode === "rate" ? "selected" : ""}>Rate %</option>
          <option value="amount" ${d.taxMode === "amount" ? "selected" : ""}>Amount $</option>
        </select>
        <input id="spTaxValue" type="number" step="0.01" min="0" inputmode="decimal" value="${d.taxValue}">
      </div>
    </div>
    <div class="rc-summary" id="spSummary"></div>
    <button type="button" class="q-add" id="spSave">Save receipt</button>
  </div>`;
  bindSplit();
  updateSplitPreview();
}

function readSplitFromDom() {
  const s = $("splitSection");
  splitDraft.date = s.querySelector("#spDate").value;
  splitDraft.account = s.querySelector("#spAccount").value;
  splitDraft.taxMode = s.querySelector("#spTaxMode").value;
  splitDraft.taxValue = s.querySelector("#spTaxValue").value;
  splitDraft.lines = [...s.querySelectorAll("#spLines .q-splitline")].map((el) => ({
    id: el.dataset.line,
    desc: el.querySelector(".sp-desc").value,
    category: el.querySelector(".sp-cat").value,
    amount: el.querySelector(".sp-amt").value,
    taxable: el.querySelector(".sp-tax").checked,
  }));
}

function updateSplitPreview() {
  const s = $("splitSection");
  const comp = computeSplit(splitDraft);
  comp.lines.forEach((l) => {
    const cell = s.querySelector(`.q-splitline[data-line="${l.id}"] .sp-withtax`);
    if (cell) cell.textContent = l.amt > 0 ? `with tax ${fmtMoney(l.total)}` : "";
  });
  s.querySelector("#spSummary").innerHTML =
    `Subtotal ${fmtMoney(comp.subtotal)} · Tax ${fmtMoney(comp.taxTotal)} · <strong>Total ${fmtMoney(comp.grandTotal)}</strong>`;
}

function bindSplit() {
  const s = $("splitSection");
  s.querySelector("#spLines").addEventListener("input", () => { readSplitFromDom(); updateSplitPreview(); });
  s.querySelector("#spLines").addEventListener("change", () => { readSplitFromDom(); updateSplitPreview(); });
  s.querySelector("#spTaxMode").addEventListener("change", () => { readSplitFromDom(); updateSplitPreview(); });
  s.querySelector("#spTaxValue").addEventListener("input", () => { readSplitFromDom(); updateSplitPreview(); });
  s.querySelector("#spAdd").addEventListener("click", () => {
    readSplitFromDom();
    splitDraft.lines.push(freshSplitLine());
    renderSplit();
  });
  s.querySelector("#spLines").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".sp-del");
    if (!btn) return;
    readSplitFromDom();
    const id = btn.closest(".q-splitline").dataset.line;
    splitDraft.lines = splitDraft.lines.filter((l) => l.id !== id);
    if (!splitDraft.lines.length) splitDraft.lines = [freshSplitLine()];
    renderSplit();
  });
  s.querySelector("#spSave").addEventListener("click", async () => {
    readSplitFromDom();
    const comp = computeSplit(splitDraft);
    const valid = comp.lines.filter((l) => l.amt > 0);
    if (!valid.length) return alert("Add at least one line with an amount.");
    const date = splitDraft.date || new Date().toISOString().slice(0, 10);
    const rows = valid.map((l) => ({
      id: uid(), date, desc: l.desc.trim() || l.category,
      category: l.category, account: splitDraft.account,
      amount: Math.round(l.total * 100) / 100,
    }));
    splitDraft = freshSplit();
    renderSplit();
    await commitRows(rows);
  });
}

// Mode toggle
document.querySelectorAll(".q-mode").forEach((b) => b.addEventListener("click", () => {
  const mode = b.dataset.mode;
  document.querySelectorAll(".q-mode").forEach((x) => x.classList.toggle("active", x === b));
  $("singleSection").hidden = mode !== "single";
  $("splitSection").hidden = mode !== "split";
}));
renderSplit();

// If already connected, refresh from the cloud on open so categories and the
// recent list reflect what was set up elsewhere.
if (isConnected()) {
  (async () => {
    badgeState = "syncing"; setBadge();
    try {
      const remote = await ghPull();
      if (remote && (remote.updatedAt ?? 0) > (state.updatedAt ?? 0)) {
        adoptRemote(remote);
        fillSelects();
        renderRecent();
      }
      badgeState = "ok"; setBadge();
    } catch {
      badgeState = "error"; setBadge();
    }
  })();
}
