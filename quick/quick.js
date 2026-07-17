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
const STARTER_CATEGORIES = [
  "Housing", "Utilities", "Groceries", "Dining Out", "Transportation",
  "Insurance", "Medical", "Pets", "Subscriptions", "Personal - Garrett",
  "Personal - Lizzie", "Gifts", "Travel", "Household", "Debt Payments",
  "Savings", "Misc",
];

function freshState() {
  let n = 0;
  return {
    household: "Garrett & Lizzie",
    categories: STARTER_CATEGORIES.map((name) => ({ id: `seed-${++n}`, name, limit: 0 })),
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
if (!state.categories.length) state.categories = freshState().categories;

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
    categories: state.categories, spending: state.spending, income: state.income,
    oneTimeIncome: state.oneTimeIncome, bills: state.bills, debts: state.debts, goals: state.goals,
  });
}

function adoptRemote(remote) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  state = {
    household: String(remote.household ?? "Garrett & Lizzie"),
    categories: arr(remote.categories), spending: arr(remote.spending),
    income: arr(remote.income), oneTimeIncome: arr(remote.oneTimeIncome),
    bills: arr(remote.bills), debts: arr(remote.debts), goals: arr(remote.goals),
    updatedAt: typeof remote.updatedAt === "number" ? remote.updatedAt : Date.now(),
  };
  state.income.forEach((r) => { if (!r.frequency) r.frequency = "Monthly"; });
  if (!state.categories.length) state.categories = freshState().categories;
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

// Append merge: pull latest, adopt it if newer, make sure our new expense is in
// it, then push. So the phone never overwrites desktop edits it hadn't seen.
async function syncAppend(newExpense) {
  badgeState = "syncing"; setBadge();
  const remote = await ghPull();
  if (remote && (remote.updatedAt ?? 0) > (state.updatedAt ?? 0)) {
    adoptRemote(remote);
    if (!state.spending.some((s) => s.id === newExpense.id)) state.spending.push(newExpense);
  }
  state.updatedAt = Date.now();
  persist();
  await ghPush(buildPayload());
  syncCfg.lastSyncedStamp = state.updatedAt;
  syncCfg.lastSyncedAt = new Date().toISOString();
  saveSyncCfg();
  badgeState = "ok"; setBadge();
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

$("expForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const amount = +$("amount").value;
  const desc = $("desc").value.trim();
  if (!(amount > 0) || !desc) return;
  const rec = {
    id: uid(),
    date: $("date").value || new Date().toISOString().slice(0, 10),
    desc,
    category: $("category").value,
    account: $("account").value,
    amount,
  };
  state.spending.push(rec); // optimistic
  persist();
  renderRecent();
  $("amount").value = "";
  $("desc").value = "";
  $("amount").focus();

  if (isConnected()) {
    try {
      await syncAppend(rec);
      renderRecent();
      toast("Saved & synced ✓");
    } catch (e) {
      state.updatedAt = Date.now(); persist(); // mark dirty for a later sync
      badgeState = "error"; setBadge();
      toast("Saved on phone — will sync later", "warn");
    }
  } else {
    state.updatedAt = Date.now(); persist();
    toast("Saved on this phone");
  }
});

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
