/* Household Finance — a local-first personal finance app modeled on the
   Household Budget workbook (Dashboard / Budget / Spending Log / Income /
   Recurring Bills / Debts / Savings Goals). Data lives in localStorage. */
"use strict";

const STORAGE_KEY = "household-finance-v2";
const OWNERS = ["Garrett", "Lizzie", "Joint"];
// Bill frequencies (how often a bill is charged), as charges-per-month.
// "One-time" is a scheduled expense that happens once — it contributes nothing
// to the monthly total but shows up in upcoming bills until its date passes.
const FREQUENCIES = { Weekly: 52 / 12, "Bi-weekly": 26 / 12, Monthly: 1, Quarterly: 1 / 3, "Semi-annual": 1 / 6, Annual: 1 / 12, "Every 2 years": 1 / 24, "One-time": 0 };
// Pay frequencies (how often a paycheck lands), as paychecks-per-month.
// Bi-weekly (every other week) is 26/yr; twice-a-month (semi-monthly) is 24/yr — they differ.
const PAY_FREQUENCIES = {
  "Weekly": 52 / 12,
  "Every other week": 26 / 12,
  "Twice a month": 2,
  "Monthly": 1,
  "Quarterly": 1 / 3,
  "Annually": 1 / 12,
};

// The 50/30/20 (Warren) axis — independent of category.
const CLASSES = ["Need", "Want", "Savings"];
const CLASS_TARGET = { Need: 0.5, Want: 0.3, Savings: 0.2 };

// A generic starter category list with a sensible default 50/30/20 class each
// (all editable/overridable later). Structure only — no example dollar figures.
const STARTER_CATEGORIES = [
  ["Housing", "Need"], ["Utilities", "Need"], ["Groceries", "Need"],
  ["Dining Out", "Want"], ["Transportation", "Need"], ["Insurance", "Need"],
  ["Medical", "Need"], ["Pets", "Need"], ["Subscriptions", "Want"],
  ["Personal - Garrett", "Want"], ["Personal - Lizzie", "Want"], ["Gifts", "Want"],
  ["Travel", "Want"], ["Household", "Need"], ["Debt Payments", "Need"],
  ["Savings", "Savings"], ["Misc", "Want"],
];
const DEFAULT_CLASS_BY_NAME = Object.fromEntries(STARTER_CATEGORIES);

// Empty starting state — no example data. Category names/classes are kept as a
// convenience (all limits 0); every other section starts empty.
function seedData() {
  let n = 0;
  return {
    household: "Garrett & Lizzie",
    taxRate: 0,          // default sales-tax rate (%) for taxable items; set on the Data tab
    categories: STARTER_CATEGORIES.map(([name, cls]) => ({ id: `seed-${++n}`, name, limit: 0, class: cls })),
    spending: [],        // { id, date, desc, category, account, amount, class? } — amount is tax-inclusive; class overrides the category default
    income: [],          // recurring paychecks: { id, source, owner, frequency, amount, notes } — amount is per paycheck
    oneTimeIncome: [],   // one-off income: { id, source, owner, date, amount, notes }
    bills: [],
    debts: [],
    goals: [],
    savingsAccounts: [],  // { id, name, owner, balance, notes }
  };
}

// ---------- State ----------

let state;
try {
  state = JSON.parse(localStorage.getItem(STORAGE_KEY)) || seedData();
} catch {
  state = seedData();
}
// Normalize shape (covers older/imported data): guarantee every section array
// exists, and give any recurring-income row without a pay frequency a default.
for (const k of ["categories", "spending", "income", "oneTimeIncome", "bills", "debts", "goals", "savingsAccounts"]) {
  if (!Array.isArray(state[k])) state[k] = [];
}
state.income.forEach((r) => { if (!r.frequency) r.frequency = "Monthly"; });
state.categories.forEach((c) => { if (!CLASSES.includes(c.class)) c.class = DEFAULT_CLASS_BY_NAME[c.name] || "Need"; });
if (typeof state.taxRate !== "number") state.taxRate = 0;
if (typeof state.updatedAt !== "number") state.updatedAt = 0;

// Category line items (e.g. Subscriptions → Netflix, Hulu): when present they
// define the category's limit. Savings accounts carry earmarks with a dated
// entry history; an earmark's balance is the sum of its entries.
function normalizeStructures() {
  state.categories.forEach((c) => {
    if (!Array.isArray(c.items)) c.items = [];
    if (c.items.length) c.limit = Math.round(c.items.reduce((s, i) => s + (+i.amount || 0), 0) * 100) / 100;
  });
  state.savingsAccounts.forEach((a) => {
    if (!Array.isArray(a.earmarks)) a.earmarks = [];
    a.earmarks.forEach((e) => { if (!Array.isArray(e.entries)) e.entries = []; });
  });
}
normalizeStructures();
const earmarkBalance = (e) => Math.round(e.entries.reduce((s, en) => s + en.amount, 0) * 100) / 100;

// ---------- Bill due dates ----------

const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtDateStr = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const daysUntil = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  const now = new Date();
  return Math.round((new Date(y, m - 1, d) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
};

// Advance a due date by one period of the bill's frequency.
function addPeriod(dateStr, freq) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (freq === "Weekly") dt.setDate(dt.getDate() + 7);
  else if (freq === "Bi-weekly") dt.setDate(dt.getDate() + 14);
  else if (freq === "Monthly") dt.setMonth(dt.getMonth() + 1);
  else if (freq === "Quarterly") dt.setMonth(dt.getMonth() + 3);
  else if (freq === "Semi-annual") dt.setMonth(dt.getMonth() + 6);
  else if (freq === "Every 2 years") dt.setFullYear(dt.getFullYear() + 2);
  else dt.setFullYear(dt.getFullYear() + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// Migrate day-of-month bills to a full next-due date, then roll every
// recurring bill's date forward past today. One-time bills keep their date
// (a past date shows as overdue rather than silently advancing).
function normalizeBills() {
  let changed = false;
  state.bills.forEach((b) => {
    if (!b.dueDate) {
      const now = new Date();
      const day = Math.min(Math.max(+b.dueDay || 1, 1), 28);
      const dt = new Date(now.getFullYear(), now.getMonth(), day);
      if (day < now.getDate()) dt.setMonth(dt.getMonth() + 1);
      b.dueDate = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      delete b.dueDay;
      changed = true;
    }
    if (b.frequency !== "One-time") {
      while (b.dueDate < todayStr()) { b.dueDate = addPeriod(b.dueDate, b.frequency); changed = true; }
    }
  });
  return changed;
}
if (normalizeBills()) { state.updatedAt = Date.now(); localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

// Write to localStorage WITHOUT touching the change clock — used when adopting a
// cloud copy, where we want to keep the cloud's timestamp rather than stamp a new one.
function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
// A local edit: stamp the change clock, persist, and nudge a cloud sync.
function save() {
  state.updatedAt = Date.now();
  persist();
  scheduleSyncSoon();
}

// ---------- Cloud sync (private GitHub Gist) — mirrors the Spanish app ----------

const SYNC_KEY = "household-finance-sync";
const GIST_FILE = "household-finance-state.json";
const GIST_DESCRIPTION = "Household Finance sync state";
const GH_API = "https://api.github.com";
const AUTO_SYNC_MS = 90 * 1000;   // background poll for the other person's changes
const PUSH_DEBOUNCE_MS = 4000;    // push shortly after you stop editing

let syncCfg;
try { syncCfg = JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch { syncCfg = {}; }
const saveSyncCfg = () => localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg));

let syncing = false;
let syncStatus = "off";   // off | syncing | ok | error
let syncMessage = "";
let pushTimer = null;
let pollTimer = null;

const isConnected = () => Boolean(syncCfg.token && syncCfg.gistId);
const gistWebUrl = () => `https://gist.github.com/${syncCfg.login || ""}/${syncCfg.gistId || ""}`;

function ghHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
}

async function ghVerifyToken(token) {
  const res = await fetch(`${GH_API}/user`, { headers: ghHeaders(token) });
  if (res.status === 401) throw new Error("Token rejected — make sure it has the 'gist' scope.");
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  return (await res.json()).login;
}

async function ghFindOrCreateGist(token) {
  const list = await fetch(`${GH_API}/gists?per_page=100`, { headers: ghHeaders(token) });
  if (!list.ok) throw new Error(`Listing gists failed (${list.status})`);
  const existing = (await list.json()).find((g) => g.files && GIST_FILE in g.files);
  if (existing) return existing.id;
  const created = await fetch(`${GH_API}/gists`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ description: GIST_DESCRIPTION, public: false, files: { [GIST_FILE]: { content: "{}" } } }),
  });
  if (!created.ok) throw new Error(`Creating the gist failed (${created.status})`);
  return (await created.json()).id;
}

async function ghPullGist() {
  const res = await fetch(`${GH_API}/gists/${syncCfg.gistId}`, { headers: ghHeaders(syncCfg.token) });
  if (res.status === 401) throw new Error("Token no longer valid — reconnect on the Data tab.");
  if (!res.ok) throw new Error(`Pull failed (${res.status})`);
  const content = (await res.json()).files?.[GIST_FILE]?.content;
  if (!content) return null;
  try { return JSON.parse(content); } catch { return null; }
}

async function ghPushGist(content) {
  const res = await fetch(`${GH_API}/gists/${syncCfg.gistId}`, {
    method: "PATCH",
    headers: { ...ghHeaders(syncCfg.token), "Content-Type": "application/json" },
    body: JSON.stringify({ files: { [GIST_FILE]: { content } } }),
  });
  if (!res.ok) throw new Error(`Push failed (${res.status})`);
}

function buildSyncPayload() {
  return JSON.stringify({
    version: 2,
    updatedAt: state.updatedAt ?? Date.now(),
    household: state.household,
    taxRate: state.taxRate ?? 0,
    overageAccountId: state.overageAccountId ?? null,
    categories: state.categories, spending: state.spending,
    income: state.income, oneTimeIncome: state.oneTimeIncome,
    bills: state.bills, debts: state.debts, goals: state.goals,
    savingsAccounts: state.savingsAccounts,
  });
}

// Replace local data with a cloud copy, keeping the cloud's change clock.
function adoptRemote(remote) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  state = {
    household: String(remote.household ?? "Our Household"),
    taxRate: typeof remote.taxRate === "number" ? remote.taxRate : 0,
    overageAccountId: remote.overageAccountId ?? null,
    categories: arr(remote.categories), spending: arr(remote.spending),
    income: arr(remote.income), oneTimeIncome: arr(remote.oneTimeIncome),
    bills: arr(remote.bills), debts: arr(remote.debts), goals: arr(remote.goals),
    savingsAccounts: arr(remote.savingsAccounts),
    updatedAt: typeof remote.updatedAt === "number" ? remote.updatedAt : Date.now(),
  };
  state.income.forEach((r) => { if (!r.frequency) r.frequency = "Monthly"; });
  state.categories.forEach((c) => { if (!CLASSES.includes(c.class)) c.class = DEFAULT_CLASS_BY_NAME[c.name] || "Need"; });
  normalizeBills();
  normalizeStructures();
  persist();
  syncCfg.lastSyncedStamp = state.updatedAt;
  saveSyncCfg();
  renderAll();
}

function setSyncStatus(status, message = "") {
  syncStatus = status;
  syncMessage = message;
  updateSyncBadge();
  if (activeTab === "data") {
    const line = document.getElementById("syncStatusLine");
    if (line) line.innerHTML = syncStatusHtml();
  }
}

// One reconciliation pass: adopt the cloud if it's newer, else push if we have
// unsynced local edits. Whole-document last-writer-wins, keyed on the timestamp.
async function syncTick() {
  if (!isConnected() || syncing) return;
  syncing = true;
  setSyncStatus("syncing");
  try {
    const remote = await ghPullGist();
    const remoteStamp = remote?.updatedAt ?? 0;
    const localStamp = state.updatedAt ?? 0;
    if (remote && remoteStamp > localStamp) {
      adoptRemote(remote);
    } else if (localStamp > (syncCfg.lastSyncedStamp ?? 0) || !remote) {
      await ghPushGist(buildSyncPayload());
      syncCfg.lastSyncedStamp = localStamp;
    }
    syncCfg.lastSyncedAt = new Date().toISOString();
    saveSyncCfg();
    setSyncStatus("ok");
    uploadPendingAttachments(); // fire-and-forget; retried next tick on failure
  } catch (e) {
    setSyncStatus("error", e.message || String(e));
  } finally {
    syncing = false;
  }
}

function scheduleSyncSoon() {
  if (!isConnected()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncTick, PUSH_DEBOUNCE_MS);
}

function startAutoSync() {
  clearInterval(pollTimer);
  if (!isConnected()) return;
  pollTimer = setInterval(syncTick, AUTO_SYNC_MS);
}

async function connectSync(token) {
  const login = await ghVerifyToken(token);
  const gistId = await ghFindOrCreateGist(token);
  syncCfg = { token, gistId, login, lastSyncedStamp: 0 };
  saveSyncCfg();
  // Bootstrap: adopt existing cloud data if present, otherwise seed the cloud.
  const remote = await ghPullGist();
  const remoteHasData = remote && ["categories", "spending", "income", "oneTimeIncome", "bills", "debts", "goals"]
    .some((k) => Array.isArray(remote[k]) && remote[k].length);
  if (remoteHasData) {
    const takeCloud = confirm("This household already has data in the cloud.\n\nOK = use the cloud copy on this device.\nCancel = keep THIS device's data and overwrite the cloud.");
    if (takeCloud) { adoptRemote(remote); }
    else { state.updatedAt = Date.now(); persist(); await ghPushGist(buildSyncPayload()); syncCfg.lastSyncedStamp = state.updatedAt; saveSyncCfg(); }
  } else {
    state.updatedAt = Date.now(); persist();
    await ghPushGist(buildSyncPayload());
    syncCfg.lastSyncedStamp = state.updatedAt; saveSyncCfg();
  }
  syncCfg.lastSyncedAt = new Date().toISOString();
  saveSyncCfg();
  setSyncStatus("ok");
  startAutoSync();
  uploadPendingAttachments(); // push any documents added before connecting
}

function disconnectSync() {
  clearInterval(pollTimer);
  clearTimeout(pushTimer);
  syncCfg = {};
  saveSyncCfg();
  setSyncStatus("off");
}

function updateSyncBadge() {
  const b = document.getElementById("syncBadge");
  if (!b) return;
  if (!isConnected()) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = syncStatus === "syncing" ? "⟳ Syncing…" : syncStatus === "error" ? "⚠ Sync error" : "☁ Synced";
  b.className = "sync-badge" + (syncStatus === "error" ? " err" : "");
  b.title = syncStatus === "error" ? syncMessage
    : syncCfg.lastSyncedAt ? `Last synced ${new Date(syncCfg.lastSyncedAt).toLocaleTimeString()}` : "Connected";
}

function syncStatusHtml() {
  if (!isConnected()) return "";
  const when = syncCfg.lastSyncedAt ? new Date(syncCfg.lastSyncedAt).toLocaleString() : "not yet";
  const label = syncStatus === "syncing" ? "Syncing…" : syncStatus === "error" ? `Error: ${esc(syncMessage)}` : "Up to date";
  return `Connected as <strong>${esc(syncCfg.login || "?")}</strong> · ${esc(label)} · last synced ${esc(when)}`;
}

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// ---------- Expense attachments ----------
// Binary documents (invoice photos, PDFs) are far too big for the state gist,
// so they live in IndexedDB on each device and sync as individual files in a
// SECOND private gist — the state gist stays small and fast to poll.

const ATT_MARKER = "household-finance-attachments.marker";

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("household-finance-files", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(id, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put(val, id);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(id) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const q = db.transaction("files").objectStore("files").get(id);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function idbDel(id) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").delete(id);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

const fileToDataUrl = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(file);
});

// Images are resized/recompressed so a phone photo lands well under the gist
// file limits; other documents (PDFs) are size-capped instead.
async function prepareAttachment(file) {
  if (file.type.startsWith("image/")) {
    const url = await fileToDataUrl(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("Couldn't read that image.")); img.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    if (scale === 1 && file.size < 600 * 1024) return url;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.8);
  }
  if (file.size > 2 * 1024 * 1024) throw new Error(`"${file.name}" is over 2 MB — export a smaller PDF or take a photo of it instead.`);
  return fileToDataUrl(file);
}

function dataUrlToBlobUrl(u) {
  const [head, b64] = u.split(",");
  const mime = (head.match(/data:(.*?)(;|$)/) || [])[1] || "application/octet-stream";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr], { type: mime }));
}

async function attachmentGistId() {
  if (syncCfg.attGistId) return syncCfg.attGistId;
  const list = await fetch(`${GH_API}/gists?per_page=100`, { headers: ghHeaders(syncCfg.token) });
  if (!list.ok) throw new Error(`Listing gists failed (${list.status})`);
  const existing = (await list.json()).find((g) => g.files && ATT_MARKER in g.files);
  let id;
  if (existing) {
    id = existing.id;
  } else {
    const created = await fetch(`${GH_API}/gists`, {
      method: "POST",
      headers: { ...ghHeaders(syncCfg.token), "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Household Finance attachments", public: false, files: { [ATT_MARKER]: { content: "attachment store — managed by the app" } } }),
    });
    if (!created.ok) throw new Error(`Creating the attachment store failed (${created.status})`);
    id = (await created.json()).id;
  }
  syncCfg.attGistId = id;
  saveSyncCfg();
  return id;
}

async function pushAttachmentFile(id, content) {
  const gid = await attachmentGistId();
  const res = await fetch(`${GH_API}/gists/${gid}`, {
    method: "PATCH",
    headers: { ...ghHeaders(syncCfg.token), "Content-Type": "application/json" },
    body: JSON.stringify({ files: { [`att-${id}.txt`]: { content } } }),
  });
  if (!res.ok) throw new Error(`Attachment upload failed (${res.status})`);
}

async function pullAttachmentFile(id) {
  const gid = await attachmentGistId();
  const res = await fetch(`${GH_API}/gists/${gid}`, { headers: ghHeaders(syncCfg.token) });
  if (!res.ok) throw new Error(`Fetching attachments failed (${res.status})`);
  const f = (await res.json()).files?.[`att-${id}.txt`];
  if (!f) throw new Error("This document isn't in the cloud yet — open it on the device it was added from so it can sync up.");
  let content = f.content;
  if (f.truncated) {
    const raw = await fetch(f.raw_url, { headers: ghHeaders(syncCfg.token) });
    if (!raw.ok) throw new Error(`Fetching the document failed (${raw.status})`);
    content = await raw.text();
  }
  await idbPut(id, content);
  return content;
}

async function deleteAttachmentFile(id) {
  try {
    const gid = await attachmentGistId();
    await fetch(`${GH_API}/gists/${gid}`, {
      method: "PATCH",
      headers: { ...ghHeaders(syncCfg.token), "Content-Type": "application/json" },
      body: JSON.stringify({ files: { [`att-${id}.txt`]: null } }),
    });
  } catch { /* best effort — orphaned cloud files are harmless */ }
}

// Push any attachment added on this device that hasn't reached the cloud yet.
async function uploadPendingAttachments() {
  if (!isConnected()) return;
  for (const row of state.spending) {
    for (const att of row.attachments || []) {
      if (att.up) continue;
      const data = await idbGet(att.id).catch(() => null);
      if (!data) continue; // added on another device; nothing to push from here
      try {
        await pushAttachmentFile(att.id, data);
        att.up = true;
        persist();
      } catch { /* retried on the next sync tick */ }
    }
  }
}

// ----- Attachment modal (one shared overlay, opened per expense) -----

let attModalExpenseId = null;

function ensureAttModal() {
  ensureModalStyles();
  if (document.getElementById("attModal")) return;
  const div = document.createElement("div");
  div.id = "attModal";
  div.className = "att-overlay";
  div.hidden = true;
  div.innerHTML = `<div class="att-box">
    <div class="att-head"><h2 id="attTitle">Attachments</h2><button id="attClose" class="ghost-btn" title="Close">✕</button></div>
    <div id="attList"></div>
    <label class="secondary-btn att-upload">＋ Add photo or document<input id="attFile" type="file" accept="image/*,application/pdf" multiple hidden></label>
    <p class="card-note">Photos are compressed automatically; PDFs up to 2 MB. Documents sync privately so both of you can open them.</p>
    <div id="attPreview"></div>
  </div>`;
  document.body.appendChild(div);
  div.addEventListener("click", (ev) => { if (ev.target === div) closeAttModal(); });
  div.querySelector("#attClose").addEventListener("click", closeAttModal);
  div.querySelector("#attFile").addEventListener("change", async (ev) => {
    const row = state.spending.find((r) => r.id === attModalExpenseId);
    if (!row) return;
    for (const file of ev.target.files) {
      try {
        const data = await prepareAttachment(file);
        const att = { id: uid(), name: file.name, up: false };
        await idbPut(att.id, data);
        (row.attachments ||= []).push(att);
      } catch (err) {
        alert(err.message || String(err));
      }
    }
    ev.target.value = "";
    save();
    renderAll();
    renderAttModal();
    if (isConnected()) uploadPendingAttachments().then(() => { renderAttModal(); });
  });
}

function openAttModal(expenseId) {
  ensureAttModal();
  attModalExpenseId = expenseId;
  renderAttModal();
  document.getElementById("attModal").hidden = false;
}
function closeAttModal() {
  attModalExpenseId = null;
  const m = document.getElementById("attModal");
  if (m) { m.hidden = true; m.querySelector("#attPreview").innerHTML = ""; }
}

function renderAttModal() {
  const m = document.getElementById("attModal");
  const row = state.spending.find((r) => r.id === attModalExpenseId);
  if (!m || !row) return;
  m.querySelector("#attTitle").textContent = `Attachments — ${row.desc}`;
  const atts = row.attachments || [];
  m.querySelector("#attList").innerHTML = atts.length
    ? atts.map((a) => `<div class="att-item">
        <button class="att-name" data-view="${a.id}">${esc(a.name)}</button>
        <span class="muted">${a.up ? "☁ synced" : "on this device"}</span>
        <button class="att-remove" data-remove="${a.id}" title="Remove">✕</button>
      </div>`).join("")
    : `<p class="empty-note">No documents attached yet.</p>`;

  m.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", async () => {
    const prev = m.querySelector("#attPreview");
    prev.innerHTML = `<p class="card-note">Loading…</p>`;
    try {
      let data = await idbGet(b.dataset.view).catch(() => null);
      if (!data) {
        if (!isConnected()) throw new Error("This document was added on another device — connect sync to fetch it.");
        data = await pullAttachmentFile(b.dataset.view);
        renderAttModal();
        return void openPreview(m, data);
      }
      openPreview(m, data);
    } catch (err) {
      prev.innerHTML = `<p class="card-note neg">${esc(err.message || String(err))}</p>`;
    }
  }));
  m.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Remove this document?")) return;
    row.attachments = (row.attachments || []).filter((a) => a.id !== b.dataset.remove);
    idbDel(b.dataset.remove).catch(() => {});
    if (isConnected()) deleteAttachmentFile(b.dataset.remove);
    save();
    renderAll();
    renderAttModal();
  }));
}

function openPreview(m, data) {
  const prev = m.querySelector("#attPreview");
  if (data.startsWith("data:image/")) {
    prev.innerHTML = `<img src="${data}" alt="attachment preview">`;
  } else {
    prev.innerHTML = "";
    window.open(dataUrlToBlobUrl(data), "_blank");
  }
}

// Modal-critical CSS ships with the JS (not only styles.css) so a cached old
// stylesheet can never render a dialog as bare floating text.
function ensureModalStyles() {
  if (document.getElementById("modalStyles")) return;
  const s = document.createElement("style");
  s.id = "modalStyles";
  s.textContent = `
    .att-overlay{position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto}
    .att-overlay[hidden]{display:none}
    .att-box{background:var(--surface-1,#fff);color:var(--text-primary,#111);border:1px solid var(--border,rgba(0,0,0,.1));border-radius:14px;padding:16px;width:100%;max-width:560px}
    .att-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px}
    .att-head h2{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .att-item{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--grid,#e5e5e5)}
    .att-item .att-name{background:none;border:none;cursor:pointer;font:inherit;color:var(--series-1,#2a78d6);text-align:left;padding:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
    .att-item .att-remove{background:none;border:none;cursor:pointer;color:var(--text-muted,#888);font-size:14px}
    .att-upload{display:inline-block;margin-top:12px;cursor:pointer}
    #attPreview{margin-top:12px}
    #attPreview img{max-width:100%;border-radius:10px;border:1px solid var(--border,rgba(0,0,0,.1))}
    .att-box .form-grid{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin:12px 0}
    .att-box .field{display:flex;flex-direction:column;gap:3px}
    .att-box .field label{font-size:12px;color:var(--text-secondary,#555)}
    .att-box input,.att-box select{font:inherit;font-size:14px;color:var(--text-primary,#111);background:var(--page,#f6f6f4);border:1px solid var(--axis,#b5b5b0);border-radius:8px;padding:8px 10px;min-width:0}
    .att-box input:focus,.att-box select:focus{outline:2px solid var(--series-1,#2a78d6);outline-offset:1px;border-color:transparent}
    .att-box .primary-btn{font:inherit;font-size:14px;font-weight:600;background:var(--series-1,#2a78d6);color:#fff;border:none;border-radius:8px;padding:8px 16px;cursor:pointer}
    .att-box .secondary-btn{font:inherit;font-size:14px;background:none;border:1px solid var(--axis,#b5b5b0);color:var(--text-secondary,#555);border-radius:8px;padding:8px 14px;cursor:pointer}
    .att-box .toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
    .att-box .card-note{font-size:13px;color:var(--text-muted,#888);margin-bottom:10px}
    .att-box .empty-note{color:var(--text-muted,#888);font-size:13.5px;padding:8px 0}
    .att-box .ghost-btn{background:none;border:1px solid var(--border,rgba(0,0,0,.1));border-radius:8px;color:var(--text-secondary,#555);font-size:16px;padding:6px 10px;cursor:pointer}
  `;
  document.head.appendChild(s);
}

// ----- Items modal: line items that build a category's limit -----

let itemsModalCatId = null;

function ensureItemsModal() {
  ensureModalStyles();
  if (document.getElementById("itModal")) return;
  const div = document.createElement("div");
  div.id = "itModal";
  div.className = "att-overlay";
  div.hidden = true;
  div.innerHTML = `<div class="att-box">
    <div class="att-head"><h2 id="itTitle">Items</h2><button id="itClose" class="ghost-btn" title="Close">✕</button></div>
    <p class="card-note">List what makes up this category (e.g. Netflix, Hulu). Their monthly costs add up to the category's limit automatically.</p>
    <div id="itList"></div>
    <form id="itForm" class="form-grid">
      <div class="field" style="flex:1"><label>Item</label><input name="name" required placeholder="e.g. Netflix"></div>
      <div class="field"><label>Monthly cost</label><input name="amount" type="number" step="0.01" min="0.01" required style="width:110px"></div>
      <button class="primary-btn">Add</button>
    </form>
    <div class="rc-summary" id="itSum"></div>
  </div>`;
  document.body.appendChild(div);
  div.addEventListener("click", (ev) => { if (ev.target === div) closeItemsModal(); });
  div.querySelector("#itClose").addEventListener("click", closeItemsModal);
  div.querySelector("#itForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const c = state.categories.find((x) => x.id === itemsModalCatId);
    if (!c) return;
    const f = new FormData(ev.target);
    c.items.push({ id: uid(), name: f.get("name").trim(), amount: +f.get("amount") });
    normalizeStructures();
    ev.target.reset();
    save(); renderAll(); renderItemsModal();
  });
}

function openItemsModal(catId) {
  ensureItemsModal();
  itemsModalCatId = catId;
  renderItemsModal();
  document.getElementById("itModal").hidden = false;
}
function closeItemsModal() {
  itemsModalCatId = null;
  const m = document.getElementById("itModal");
  if (m) m.hidden = true;
}

function renderItemsModal() {
  const m = document.getElementById("itModal");
  const c = state.categories.find((x) => x.id === itemsModalCatId);
  if (!m || !c) return;
  m.querySelector("#itTitle").textContent = `Items — ${c.name}`;
  m.querySelector("#itList").innerHTML = c.items.length
    ? c.items.map((i) => `<div class="att-item">
        <span style="flex:1">${esc(i.name)}</span>
        <span class="secondary">${fmtMoney(i.amount, true)}/mo</span>
        <button class="att-remove" data-del-item="${i.id}" title="Remove">✕</button>
      </div>`).join("")
    : `<p class="empty-note">No items yet — the limit stays manually editable until you add one.</p>`;
  m.querySelector("#itSum").innerHTML = c.items.length
    ? `Category limit: <strong>${fmtMoney(c.limit, true)}/mo</strong> (sum of items)` : "";
  m.querySelectorAll("[data-del-item]").forEach((b) => b.addEventListener("click", () => {
    c.items = c.items.filter((i) => i.id !== b.dataset.delItem);
    normalizeStructures();
    save(); renderAll(); renderItemsModal();
  }));
}

// ----- Earmark modal: dated add/pull history inside a savings account -----

let earmarkModalIds = null; // { acctId, emId }

function ensureEarmarkModal() {
  ensureModalStyles();
  if (document.getElementById("emModal")) return;
  const div = document.createElement("div");
  div.id = "emModal";
  div.className = "att-overlay";
  div.hidden = true;
  div.innerHTML = `<div class="att-box">
    <div class="att-head"><h2 id="emTitle">Earmark</h2><button id="emClose" class="ghost-btn" title="Close">✕</button></div>
    <p class="card-note" id="emSub"></p>
    <div class="toolbar" id="emQuick"></div>
    <form id="emForm" class="form-grid">
      <div class="field"><label>Date</label><input name="date" type="date" required></div>
      <div class="field"><label>Add / Pull</label><select name="dir"><option value="1">Add to earmark</option><option value="-1">Pull from earmark</option></select></div>
      <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" min="0.01" required style="width:110px"></div>
      <div class="field" style="flex:1"><label>Note</label><input name="note" placeholder="e.g. oil change"></div>
      <button class="primary-btn">Record</button>
    </form>
    <p class="card-note">Adds and pulls also update the account's balance, since the money really enters or leaves that account.</p>
    <div id="emHistory"></div>
  </div>`;
  document.body.appendChild(div);
  div.addEventListener("click", (ev) => { if (ev.target === div) closeEarmarkModal(); });
  div.querySelector("#emClose").addEventListener("click", closeEarmarkModal);
  div.querySelector("#emForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const ctx = earmarkCtx();
    if (!ctx) return;
    const f = new FormData(ev.target);
    const amount = Math.round(+f.get("amount") * +f.get("dir") * 100) / 100;
    if (!amount) return;
    ctx.em.entries.push({ id: uid(), date: f.get("date") || todayStr(), amount, note: f.get("note").trim() });
    ctx.acct.balance = Math.max(0, Math.round((ctx.acct.balance + amount) * 100) / 100);
    ev.target.reset();
    div.querySelector('#emForm input[name="date"]').value = todayStr();
    save(); renderAll(); renderEarmarkModal();
  });
}

const earmarkCtx = () => {
  if (!earmarkModalIds) return null;
  const acct = state.savingsAccounts.find((a) => a.id === earmarkModalIds.acctId);
  const em = acct?.earmarks.find((e) => e.id === earmarkModalIds.emId);
  return acct && em ? { acct, em } : null;
};

function openEarmarkModal(acctId, emId) {
  ensureEarmarkModal();
  earmarkModalIds = { acctId, emId };
  document.querySelector('#emForm input[name="date"]').value = todayStr();
  renderEarmarkModal();
  document.getElementById("emModal").hidden = false;
}
function closeEarmarkModal() {
  earmarkModalIds = null;
  const m = document.getElementById("emModal");
  if (m) m.hidden = true;
}

function renderEarmarkModal() {
  const m = document.getElementById("emModal");
  const ctx = earmarkCtx();
  if (!m || !ctx) return;
  const { acct, em } = ctx;
  m.querySelector("#emTitle").textContent = `${em.name} — ${acct.name}`;
  m.querySelector("#emSub").innerHTML = `Balance <strong>${fmtMoney(earmarkBalance(em), true)}</strong>${em.monthly > 0 ? ` · plan ${fmtMoney(em.monthly)}/mo` : ""}`;
  m.querySelector("#emQuick").innerHTML = em.monthly > 0
    ? `<button class="secondary-btn" id="emQuickAdd">＋ Record this month's ${fmtMoney(em.monthly)}</button>` : "";
  m.querySelector("#emQuickAdd")?.addEventListener("click", () => {
    em.entries.push({ id: uid(), date: todayStr(), amount: em.monthly, note: "monthly set-aside" });
    acct.balance = Math.round((acct.balance + em.monthly) * 100) / 100;
    save(); renderAll(); renderEarmarkModal();
  });
  const entries = [...em.entries].sort((a, b) => b.date.localeCompare(a.date));
  m.querySelector("#emHistory").innerHTML = entries.length
    ? entries.map((en) => `<div class="att-item">
        <span class="secondary" style="white-space:nowrap">${en.date}</span>
        <span style="flex:1">${esc(en.note || (en.amount >= 0 ? "added" : "pulled"))}</span>
        <span class="${en.amount >= 0 ? "pos" : "neg"}" style="font-variant-numeric:tabular-nums">${en.amount >= 0 ? "+" : "−"}${fmtMoney(Math.abs(en.amount), true)}</span>
        <button class="att-remove" data-del-entry="${en.id}" title="Remove entry">✕</button>
      </div>`).join("")
    : `<p class="empty-note">No history yet.</p>`;
  m.querySelectorAll("[data-del-entry]").forEach((b) => b.addEventListener("click", () => {
    const en = em.entries.find((x) => x.id === b.dataset.delEntry);
    if (!en || !confirm("Remove this entry? The account balance is adjusted back.")) return;
    em.entries = em.entries.filter((x) => x.id !== en.id);
    acct.balance = Math.max(0, Math.round((acct.balance - en.amount) * 100) / 100);
    save(); renderAll(); renderEarmarkModal();
  }));
}

// Which month each tab is looking at (YYYY-MM), defaults to today.
let selectedMonth = new Date().toISOString().slice(0, 7);
let editing = {}; // per-entity id currently loaded into the tab's form

// ---------- Derived values ----------

const monthlyEquivalent = (b) => b.amount * (FREQUENCIES[b.frequency] ?? 1);
// Recurring income: the entered amount is per paycheck; convert to a monthly figure.
const incomeMonthly = (r) => r.amount * (PAY_FREQUENCIES[r.frequency] ?? 1);
const totalIncome = () => state.income.reduce((s, r) => s + incomeMonthly(r), 0);
const incomeByOwner = (owner) => state.income.filter((r) => r.owner === owner).reduce((s, r) => s + incomeMonthly(r), 0);
// One-time income landing in a given month (YYYY-MM).
const oneTimeIn = (month, owner) => state.oneTimeIncome
  .filter((r) => r.date.slice(0, 7) === month && (!owner || r.owner === owner))
  .reduce((s, r) => s + r.amount, 0);
const totalBills = () => state.bills.reduce((s, b) => s + monthlyEquivalent(b), 0);
const totalMinPayments = () => state.debts.reduce((s, d) => s + d.minPayment, 0);
const totalGoalContributions = () => state.goals.reduce((s, g) => s + g.monthly, 0);
const totalBudgeted = () => state.categories.reduce((s, c) => s + c.limit, 0);
const totalSavings = () => state.savingsAccounts.reduce((s, a) => s + a.balance, 0);

// 50/30/20 axis. A category has a default class; a spending row may override it.
const categoryClass = (name) => state.categories.find((c) => c.name === name)?.class || "Need";
const effectiveClass = (row) => (CLASSES.includes(row.class) ? row.class : categoryClass(row.category));

// This month's spending in a given 50/30/20 class. For Savings we also fold in
// the monthly savings-goal contributions (per the household's chosen rule).
function classSpentIn(month, cls) {
  const spent = state.spending
    .filter((r) => r.date.slice(0, 7) === month && effectiveClass(r) === cls)
    .reduce((s, r) => s + r.amount, 0);
  return cls === "Savings" ? spent + totalGoalContributions() : spent;
}

function spentIn(month, category) {
  return state.spending
    .filter((r) => r.date.slice(0, 7) === month && (!category || r.category === category))
    .reduce((s, r) => s + r.amount, 0);
}

function spentYTD(year, category) {
  return state.spending
    .filter((r) => r.date.slice(0, 4) === year && (!category || r.category === category))
    .reduce((s, r) => s + r.amount, 0);
}

function last12Months() {
  const out = [];
  const [y, m] = selectedMonth.split("-").map(Number);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(y, m - 1 - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// ---------- Formatting ----------

const fmtMoney = (v, cents = false) =>
  (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });

const fmtMonth = (key, short = false) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", short ? { month: "short" } : { month: "long", year: "numeric" });
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Small components ----------

function statTile(label, value, sub = "") {
  return `<div class="stat-tile">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value">${esc(value)}</div>
    ${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ""}
  </div>`;
}

// Meter: fill carries severity (accent under 85%, warning to 100%, critical over);
// the track is a lighter step of the same blue ramp. State is never color-alone —
// the numbers and an "Over"/"Close" flag ride beside every meter.
function meterRow(name, actual, limit) {
  const pct = limit > 0 ? actual / limit : 0;
  const cls = pct > 1 ? "over" : pct >= 0.85 ? "warn" : "";
  const flag = pct > 1 ? `<span class="flag over-flag">▲ Over</span>` : pct >= 0.85 ? `<span class="flag warn-flag">Close</span>` : "";
  return `<div class="meter-row">
    <div class="meter-head">
      <span class="meter-name">${esc(name)}${flag}</span>
      <span class="meter-nums">${fmtMoney(actual, true)} of ${fmtMoney(limit)}</span>
    </div>
    <div class="meter" role="img" aria-label="${esc(name)}: ${fmtMoney(actual, true)} of ${fmtMoney(limit)}">
      <div class="meter-fill ${cls}" style="width:${Math.min(pct * 100, 100)}%"></div>
    </div>
  </div>`;
}

// 50/30/20 (Warren) breakdown for a month: each class's spend vs its target
// share of take-home income. Savings folds in monthly goal contributions.
function fiftyThirtyTwentyCard(month) {
  const income = totalIncome();
  const body = income <= 0
    ? `<p class="empty-note">Add your take-home income on the Income tab to see your 50/30/20 targets.</p>`
    : CLASSES.map((cls) => {
        const actual = classSpentIn(month, cls);
        const target = income * CLASS_TARGET[cls];
        const pctOfIncome = Math.round((actual / income) * 100);
        const fill = target > 0 ? Math.min((actual / target) * 100, 100) : 0;
        // For Need/Want, over target reads as a caution; for Savings, more is good.
        const sev = cls === "Savings" ? "" : actual > target ? "over" : actual >= target * 0.85 ? "warn" : "";
        return `<div class="meter-row">
          <div class="meter-head">
            <span class="meter-name">${cls} <span class="muted">· ${Math.round(CLASS_TARGET[cls] * 100)}% target</span></span>
            <span class="meter-nums">${fmtMoney(actual)} <span class="muted">of ${fmtMoney(target)}</span> · ${pctOfIncome}% of income</span>
          </div>
          <div class="meter" role="img" aria-label="${cls}: ${fmtMoney(actual)} of ${fmtMoney(target)} target">
            <div class="meter-fill ${sev}" style="width:${fill}%"></div>
          </div>
        </div>`;
      }).join("");
  return `<div class="card">
    <h2>50/30/20 — ${fmtMonth(month)}</h2>
    <p class="card-note">Your spending split into needs, wants, and savings against the 50/30/20 targets on take-home income. Savings includes your monthly goal contributions. Each expense uses its category's class unless you override it.</p>
    ${body}
  </div>`;
}

// Single-series column chart (12 months of total spending), pure SVG.
// Columns ≤24px, 4px rounded cap / square baseline, hairline solid gridlines.
function spendingChart() {
  const months = last12Months();
  const values = months.map((m) => spentIn(m));
  const max = Math.max(...values, 1);
  // round the axis top to a clean number
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const W = 640, H = 220, padL = 52, padR = 8, padT = 10, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const band = plotW / 12;
  const barW = Math.min(24, band - 8);
  const ticks = [0, top / 2, top];

  let svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Total spending by month, last 12 months">`;
  for (const t of ticks) {
    const y = padT + plotH - (t / top) * plotH;
    svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--grid)" stroke-width="1"/>`;
    svg += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)" style="font-variant-numeric:tabular-nums">${t >= 1000 ? (t / 1000) + "k" : t}</text>`;
  }
  months.forEach((m, i) => {
    const v = values[i];
    const x = padL + i * band + (band - barW) / 2;
    const h = (v / top) * plotH;
    const y = padT + plotH - h;
    if (v > 0) {
      const r = Math.min(4, h);
      svg += `<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + h} Z" fill="var(--series-1)"/>`;
    }
    // full-band invisible hit target so hover never needs pixel accuracy
    svg += `<rect class="hit" data-month="${m}" data-value="${v}" x="${padL + i * band}" y="${padT}" width="${band}" height="${plotH}" fill="transparent"/>`;
    svg += `<text x="${x + barW / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--text-muted)">${fmtMonth(m, true)}</text>`;
  });
  svg += `<line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--axis)" stroke-width="1"/>`;
  svg += `</svg>`;
  return svg;
}

// ---------- Tooltip ----------

const tooltip = () => document.getElementById("tooltip");

function bindChartHover(container) {
  const tt = tooltip();
  container.querySelectorAll(".hit").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      tt.innerHTML = `<div class="tt-title">${fmtMonth(el.dataset.month)}</div><div class="tt-line">Spent ${fmtMoney(+el.dataset.value, true)}</div>`;
      tt.hidden = false;
      const x = Math.min(e.clientX + 12, window.innerWidth - tt.offsetWidth - 8);
      tt.style.left = `${x}px`;
      tt.style.top = `${e.clientY + 12}px`;
    });
    el.addEventListener("pointerleave", () => { tt.hidden = true; });
  });
}

// ---------- Renderers ----------

function categoryOptions(selected) {
  return state.categories.map((c) => `<option ${c.name === selected ? "selected" : ""}>${esc(c.name)}</option>`).join("");
}
const ownerOptions = (selected) => OWNERS.map((o) => `<option ${o === selected ? "selected" : ""}>${o}</option>`).join("");
const classOptions = (selected) => CLASSES.map((c) => `<option ${c === selected ? "selected" : ""}>${c}</option>`).join("");
// For a per-expense override select: blank means "use the category's class".
const classOverrideOptions = (selected) =>
  `<option value="">— use category —</option>` + CLASSES.map((c) => `<option ${c === selected ? "selected" : ""}>${c}</option>`).join("");

function renderDashboard(el) {
  const income = totalIncome(), budgeted = totalBudgeted(), cushion = income - budgeted;
  const month = selectedMonth;
  const spent = spentIn(month);
  const overCats = state.categories
    .map((c) => ({ ...c, actual: spentIn(month, c.name) }))
    .filter((c) => c.limit > 0 && c.actual / c.limit >= 0.85)
    .sort((a, b) => b.actual / b.limit - a.actual / a.limit);

  const upcoming = [...state.bills]
    .map((b) => ({ ...b, daysAway: daysUntil(b.dueDate) }))
    .sort((a, b) => a.daysAway - b.daysAway)
    .slice(0, 5);

  el.innerHTML = `
    <div class="card hero">
      <div class="hero-label">Income minus budgeted limits</div>
      <div class="hero-value ${cushion >= 0 ? "" : "neg"}">${fmtMoney(cushion)}<span style="font-size:18px;color:var(--text-muted)"> / mo</span></div>
      <div class="hero-sub">${cushion >= 0 ? "Positive = cushion after every category limit is fully spent." : "Negative = your category limits exceed income. Trim limits or grow income."}</div>
    </div>
    <div class="kpi-row">
      ${statTile("Household income", fmtMoney(income), "per month, take-home")}
      ${statTile("Recurring bills", fmtMoney(totalBills()), "monthly equivalent")}
      ${statTile("Debt minimums", fmtMoney(totalMinPayments()), "required per month")}
      ${statTile("Goal contributions", fmtMoney(totalGoalContributions()), "toward savings goals")}
      ${statTile("In savings", fmtMoney(totalSavings()), "across all accounts")}
      ${statTile("Total budgeted", fmtMoney(budgeted), "sum of category limits")}
    </div>
    ${fiftyThirtyTwentyCard(month)}
    <div class="card">
      <h2>${fmtMonth(month)} — spending vs total budget</h2>
      <p class="card-note">Logged so far this month against the sum of all category limits.</p>
      ${meterRow("All categories", spent, budgeted)}
      ${overCats.length
        ? overCats.map((c) => meterRow(c.name, c.actual, c.limit)).join("")
        : `<p class="empty-note">No category is above 85% of its limit this month.</p>`}
    </div>
    <div class="card">
      <h2>Total spending by month</h2>
      <p class="card-note">Last 12 months, from the spending log. Hover a column for the exact figure; the Budget tab has the full table.</p>
      <div id="dashChart">${spendingChart()}</div>
    </div>
    <div class="two-col">
      <div class="card">
        <h2>Upcoming bills</h2>
        <p class="card-note">Next five by due date — including annual and one-time scheduled expenses.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Bill</th><th>Due</th><th class="num">Amount</th><th>Auto-pay</th></tr></thead>
          <tbody>${upcoming.map((b) => `<tr>
            <td>${esc(b.name)}</td>
            <td class="secondary" style="white-space:nowrap">${fmtDateStr(b.dueDate)} <span class="muted">· ${b.daysAway < 0 ? '<span class="neg">overdue</span>' : b.daysAway === 0 ? "today" : `in ${b.daysAway}d`}</span></td>
            <td class="num">${fmtMoney(b.amount, true)}</td>
            <td class="secondary">${b.autopay ? "Yes" : "No"}</td>
          </tr>`).join("") || `<tr><td colspan="4" class="empty-note">No bills scheduled.</td></tr>`}</tbody>
        </table></div>
      </div>
      <div class="card">
        <h2>Savings goals</h2>
        <p class="card-note">Progress toward each target — full detail on the Goals tab.</p>
        ${state.goals.map((g) => meterRow(g.name, g.saved, g.target)).join("") || `<p class="empty-note">No goals yet.</p>`}
      </div>
    </div>`;
  bindChartHover(el.querySelector("#dashChart"));
}

// ----- Overages: leftovers from marked categories move into an "Overages"
// earmark on a chosen savings account, with a dated entry per move. -----

function overageEarmark(create = false) {
  const acct = state.savingsAccounts.find((a) => a.id === state.overageAccountId);
  if (!acct) return null;
  let em = acct.earmarks.find((e) => e.name === "Overages");
  if (!em && create) {
    em = { id: uid(), name: "Overages", monthly: 0, entries: [] };
    acct.earmarks.push(em);
  }
  return em ? { acct, em } : { acct, em: null };
}

function overageMoved(catId, month) {
  const o = overageEarmark();
  return Boolean(o?.em?.entries.some((en) => en.srcCat === catId && en.month === month));
}

function overagesCard(month, rows) {
  const marked = rows.filter((r) => r.overage);
  if (!marked.length) return "";
  const acctOptions = state.savingsAccounts
    .map((a) => `<option value="${a.id}" ${a.id === state.overageAccountId ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  const body = !state.savingsAccounts.length
    ? `<p class="empty-note">Add a savings account on the Savings tab first, then pick it here as the overage destination.</p>`
    : marked.map((r) => {
        const leftover = Math.round((r.limit - r.actual) * 100) / 100;
        const moved = overageMoved(r.id, month);
        const btn = moved
          ? `<span class="pos">Moved ✓</span>`
          : leftover > 0 && state.overageAccountId
            ? `<button class="secondary-btn" data-move-ovg="${r.id}" data-amt="${leftover}">Move ${fmtMoney(leftover, true)}</button>`
            : `<span class="muted">${leftover <= 0 ? "nothing left" : "pick an account"}</span>`;
        return `<div class="ovg-row">
          <span>${esc(r.name)} <span class="muted">· ${fmtMoney(r.actual, true)} of ${fmtMoney(r.limit)}</span></span>
          ${btn}
        </div>`;
      }).join("");
  return `<div class="card">
    <div class="toolbar">
      <h2 style="margin:0">Overages — ${fmtMonth(month)}</h2>
      <div class="spacer"></div>
      <div class="field"><label>Destination account</label><select id="ovgAccount"><option value="">— choose —</option>${acctOptions}</select></div>
    </div>
    <p class="card-note">Leftovers from your marked categories. After you move the money at the bank, tap Move — it records a dated entry in the account's "Overages" earmark and bumps its balance. Pull from it on the Savings tab when a month runs over.</p>
    ${body}
  </div>`;
}

// How the Budget tab orders categories — a per-device preference.
let budgetSort = localStorage.getItem("household-finance-budget-sort") || "class";
const BUDGET_SORTS = {
  class: ["By class (need / want / savings)", (a, b) => CLASSES.indexOf(a.class) - CLASSES.indexOf(b.class) || a.name.localeCompare(b.name)],
  alpha: ["Alphabetical", (a, b) => a.name.localeCompare(b.name)],
  limit: ["By monthly limit", (a, b) => b.limit - a.limit || a.name.localeCompare(b.name)],
  actual: ["By this month's spending", (a, b) => b.actual - a.actual || a.name.localeCompare(b.name)],
};

function renderBudget(el) {
  const month = selectedMonth;
  const year = month.slice(0, 4);
  const monthIndex = +month.slice(5) - 1;
  const rows = state.categories.map((c) => {
    const actual = spentIn(month, c.name);
    const ytd = spentYTD(year, c.name);
    // YTD allowance = limit × months elapsed this year (Jan..selected month)
    const ytdAllowance = c.limit * (monthIndex + 1);
    return { ...c, actual, ytd, ytdVs: ytdAllowance - ytd };
  });
  rows.sort((BUDGET_SORTS[budgetSort] || BUDGET_SORTS.class)[1]);
  const totActual = rows.reduce((s, r) => s + r.actual, 0);
  const totYtd = rows.reduce((s, r) => s + r.ytd, 0);
  const e = editing.category ? state.categories.find((c) => c.id === editing.category) : null;

  el.innerHTML = `
    <div class="card">
      <div class="toolbar">
        <div class="field"><label>Month</label><input type="month" id="budgetMonth" value="${month}"></div>
        <div class="field"><label>Sort</label><select class="budget-sort">${Object.entries(BUDGET_SORTS).map(([k, [label]]) => `<option value="${k}" ${k === budgetSort ? "selected" : ""}>${label}</option>`).join("")}</select></div>
        <div class="spacer"></div>
      </div>
      <h2>Category limits vs. actuals — ${fmtMonth(month)}</h2>
      <p class="card-note">Actuals flow in automatically from the Spending tab. "YTD vs limit" compares year-to-date spending against the limit × months elapsed; positive means under budget.</p>
      ${rows.map((r) => meterRow(r.name, r.actual, r.limit)).join("")}
    </div>
    <div class="card">
      <div class="toolbar">
        <h2 style="margin:0">Budget table</h2>
        <div class="spacer"></div>
        <div class="field"><label>Sort</label><select class="budget-sort">${Object.entries(BUDGET_SORTS).map(([k, [label]]) => `<option value="${k}" ${k === budgetSort ? "selected" : ""}>${label}</option>`).join("")}</select></div>
      </div>
      <p class="card-note">Type a new limit or pick a class right in the table — changes save as soon as you leave the field. The form below adds a category or renames one.</p>
      <form id="categoryForm" class="form-grid">
        <div class="field"><label>Category</label><input name="name" required value="${esc(e?.name ?? "")}" placeholder="e.g. Groceries"></div>
        <div class="field"><label>Class (50/30/20)</label><select name="class">${classOptions(e?.class ?? "Need")}</select></div>
        <div class="field"><label>Monthly limit</label><input name="limit" type="number" step="1" min="0" required value="${e?.limit ?? ""}"></div>
        <button class="primary-btn">${e ? "Update" : "Add category"}</button>
        ${e ? `<button type="button" class="secondary-btn" id="cancelCategory">Cancel</button>` : ""}
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>Category</th><th>Class</th><th title="Leftovers from this category can be moved to your Overages account">Overage</th><th class="num">Monthly limit</th><th class="num">${fmtMonth(month, true)} actual</th><th class="num">YTD actual</th><th class="num">YTD vs limit</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>
            <td>${esc(r.name)}</td>
            <td><select class="cat-class" data-id="${r.id}">${classOptions(r.class)}</select></td>
            <td style="text-align:center"><input type="checkbox" class="cat-overage" data-id="${r.id}" ${r.overage ? "checked" : ""}></td>
            <td class="num"><input class="cat-limit" data-id="${r.id}" type="number" min="0" step="1" inputmode="numeric" value="${r.limit}" ${r.items.length ? 'disabled title="Set by its items — edit them via the Items button"' : ""}></td>
            <td class="num">${fmtMoney(r.actual, true)}</td>
            <td class="num">${fmtMoney(r.ytd, true)}</td>
            <td class="num ${r.ytdVs >= 0 ? "pos" : "neg"}">${r.ytd > 0 ? fmtMoney(r.ytdVs, true) : '<span class="muted">—</span>'}</td>
            <td class="row-actions">
              <button data-items="${r.id}">Items${r.items.length ? ` (${r.items.length})` : ""}</button>
              <button data-edit="${r.id}">Rename</button>
              <button data-del="${r.id}">Delete</button>
            </td>
          </tr>`).join("")}
          <tr class="total-row"><td>TOTAL</td><td></td><td></td><td class="num">${fmtMoney(totalBudgeted())}</td><td class="num">${fmtMoney(totActual, true)}</td><td class="num">${fmtMoney(totYtd, true)}</td><td></td><td></td></tr>
        </tbody>
      </table></div>
    </div>
    ${overagesCard(month, rows)}`;

  el.querySelector("#budgetMonth").addEventListener("change", (ev) => {
    if (ev.target.value) { selectedMonth = ev.target.value; renderAll(); }
  });
  el.querySelectorAll(".budget-sort").forEach((sel) => sel.addEventListener("change", (ev) => {
    budgetSort = ev.target.value;
    localStorage.setItem("household-finance-budget-sort", budgetSort);
    renderAll();
  }));
  el.querySelector("#categoryForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const name = f.get("name").trim(), limit = +f.get("limit"), cls = f.get("class");
    if (!name) return;
    if (e) {
      // renaming a category keeps its spending history attached
      state.spending.forEach((r) => { if (r.category === e.name) r.category = name; });
      state.bills.forEach((b) => { if (b.category === e.name) b.category = name; });
      e.name = name; e.limit = limit; e.class = cls;
      editing.category = null;
    } else {
      state.categories.push({ id: uid(), name, limit, class: cls });
    }
    save(); renderAll();
  });
  el.querySelector("#cancelCategory")?.addEventListener("click", () => { editing.category = null; renderAll(); });
  el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
    editing.category = b.dataset.edit;
    renderAll();
    document.querySelector("#categoryForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    const cat = state.categories.find((c) => c.id === b.dataset.del);
    const used = state.spending.some((r) => r.category === cat.name);
    if (!confirm(used ? `"${cat.name}" has logged expenses. Delete the category anyway? (Expenses keep the name but lose their limit.)` : `Delete "${cat.name}"?`)) return;
    state.categories = state.categories.filter((c) => c.id !== b.dataset.del);
    save(); renderAll();
  }));

  // Inline edits in the table: commit on change (blur / Enter / select).
  el.querySelectorAll(".cat-limit").forEach((inp) => inp.addEventListener("change", () => {
    const c = state.categories.find((x) => x.id === inp.dataset.id);
    if (!c || c.items.length) return;
    c.limit = Math.max(0, +inp.value || 0);
    save(); renderAll();
  }));
  el.querySelectorAll(".cat-class").forEach((sel) => sel.addEventListener("change", () => {
    const c = state.categories.find((x) => x.id === sel.dataset.id);
    if (!c) return;
    c.class = sel.value;
    save(); renderAll();
  }));
  el.querySelectorAll(".cat-overage").forEach((box) => box.addEventListener("change", () => {
    const c = state.categories.find((x) => x.id === box.dataset.id);
    if (!c) return;
    c.overage = box.checked;
    save(); renderAll();
  }));
  el.querySelectorAll("[data-items]").forEach((b) => b.addEventListener("click", () => openItemsModal(b.dataset.items)));

  // Overages card
  el.querySelector("#ovgAccount")?.addEventListener("change", (ev) => {
    state.overageAccountId = ev.target.value || null;
    save(); renderAll();
  });
  el.querySelectorAll("[data-move-ovg]").forEach((b) => b.addEventListener("click", () => {
    const cat = state.categories.find((c) => c.id === b.dataset.moveOvg);
    const amt = +b.dataset.amt;
    const o = overageEarmark(true);
    if (!cat || !o?.acct || !(amt > 0)) return;
    o.em.entries.push({ id: uid(), date: todayStr(), amount: amt, note: `${cat.name} leftover — ${fmtMonth(month)}`, srcCat: cat.id, month });
    o.acct.balance = Math.round((o.acct.balance + amt) * 100) / 100;
    save(); renderAll();
  }));
}

function renderSpending(el) {
  const month = selectedMonth;
  const rows = state.spending
    .filter((r) => r.date.slice(0, 7) === month)
    .sort((a, b) => b.date.localeCompare(a.date));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const e = editing.spending ? state.spending.find((r) => r.id === editing.spending) : null;
  const today = new Date().toISOString().slice(0, 10);

  el.innerHTML = `
    <div class="card">
      <h2>${e ? "Edit expense" : "Log an expense"}</h2>
      <p class="card-note">Every expense you log flows into the Budget tab's actuals for its month. Class defaults to the category's, or override it here.</p>
      <form id="spendForm" class="form-grid">
        <div class="field"><label>Date</label><input name="date" type="date" required value="${e?.date ?? today}"></div>
        <div class="field"><label>Description</label><input name="desc" required value="${esc(e?.desc ?? "")}" placeholder="e.g. HyVee groceries"></div>
        <div class="field"><label>Category</label><select name="category">${categoryOptions(e?.category)}</select></div>
        <div class="field"><label>Account</label><select name="account">${ownerOptions(e?.account ?? "Joint")}</select></div>
        <div class="field"><label>Class</label><select name="class">${classOverrideOptions(e?.class)}</select></div>
        <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" min="0.01" required value="${e?.amount ?? ""}"></div>
        <button class="primary-btn">${e ? "Update" : "Add expense"}</button>
        ${e ? `<button type="button" class="secondary-btn" id="cancelSpend">Cancel</button>` : ""}
      </form>
    </div>
    ${e ? "" : receiptCard()}
    <div class="card">
      <div class="toolbar">
        <div class="field"><label>Month</label><input type="month" id="spendMonth" value="${month}"></div>
        <div class="spacer"></div>
        <span class="secondary" style="font-size:14px">${rows.length} expense${rows.length === 1 ? "" : "s"} · <strong>${fmtMoney(total, true)}</strong></span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Class</th><th>Account</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr>
            <td class="secondary" style="white-space:nowrap">${r.date}</td>
            <td>${esc(r.desc)}</td>
            <td class="secondary">${esc(r.category)}</td>
            <td class="secondary">${esc(effectiveClass(r))}${r.class ? " ·" : ""}</td>
            <td class="secondary">${esc(r.account)}</td>
            <td class="num">${fmtMoney(r.amount, true)}</td>
            <td class="row-actions"><button data-att="${r.id}" title="Attach documents">📎${r.attachments?.length ? ` ${r.attachments.length}` : ""}</button><button data-edit="${r.id}">Edit</button><button data-del="${r.id}">Delete</button></td>
          </tr>`).join("") || `<tr><td colspan="7" class="empty-note">Nothing logged for ${fmtMonth(month)} yet.</td></tr>`}
        </tbody>
      </table></div>
    </div>`;

  el.querySelector("#spendMonth").addEventListener("change", (ev) => {
    if (ev.target.value) { selectedMonth = ev.target.value; renderAll(); }
  });
  el.querySelector("#spendForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const rec = {
      date: f.get("date"),
      desc: f.get("desc").trim(),
      category: f.get("category"),
      account: f.get("account"),
      amount: +f.get("amount"),
    };
    const cls = f.get("class");
    if (CLASSES.includes(cls)) rec.class = cls; else rec.class = undefined;
    if (e) { Object.assign(e, rec); if (!rec.class) delete e.class; editing.spending = null; }
    else { if (!rec.class) delete rec.class; state.spending.push({ id: uid(), ...rec }); }
    selectedMonth = rec.date.slice(0, 7);
    save(); renderAll();
  });
  el.querySelector("#cancelSpend")?.addEventListener("click", () => { editing.spending = null; renderAll(); });
  el.querySelectorAll("[data-att]").forEach((b) => b.addEventListener("click", () => openAttModal(b.dataset.att)));
  el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => { editing.spending = b.dataset.edit; renderAll(); }));
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    const row = state.spending.find((r) => r.id === b.dataset.del);
    for (const att of row?.attachments || []) {
      idbDel(att.id).catch(() => {});
      if (isConnected()) deleteAttachmentFile(att.id);
    }
    state.spending = state.spending.filter((r) => r.id !== b.dataset.del);
    save(); renderAll();
  }));

  if (!e) bindReceipt(el.querySelector("#rcCard"));
}

// ---------- Multi-line receipt (tax folded into each line — method D) ----------

let receiptDraft = null;
function freshReceiptLine() {
  return { id: uid(), desc: "", category: state.categories[0]?.name || "", cls: "", amount: "", taxable: false };
}
function freshReceipt() {
  return {
    date: new Date().toISOString().slice(0, 10),
    account: "Joint",
    taxMode: "rate",
    taxValue: state.taxRate || 0,
    lines: [freshReceiptLine(), freshReceiptLine()],
  };
}

// Spread the tax across the taxable lines (or, if none are marked, across all
// lines) and fold each line's share into its cost.
function computeReceipt(d) {
  const lines = d.lines.map((l) => ({ ...l, amt: +l.amount || 0 }));
  const subtotal = lines.reduce((s, l) => s + l.amt, 0);
  const marked = lines.filter((l) => l.taxable);
  const baseLines = marked.length ? marked : lines;
  const baseSum = baseLines.reduce((s, l) => s + l.amt, 0);
  const rate = (+d.taxValue || 0) / 100;
  const taxTotal = d.taxMode === "amount" ? (+d.taxValue || 0) : baseSum * rate;
  const out = lines.map((l) => {
    const inBase = baseLines.includes(l);
    const tax = inBase && baseSum > 0 ? taxTotal * (l.amt / baseSum) : 0;
    return { ...l, tax, total: l.amt + tax };
  });
  return { lines: out, subtotal, taxTotal, grandTotal: subtotal + taxTotal };
}

function receiptLinesHtml(d) {
  return d.lines.map((l) => `<tr data-line="${l.id}">
    <td><input class="rc-desc" value="${esc(l.desc)}" placeholder="e.g. Paper towels"></td>
    <td><select class="rc-cat">${categoryOptions(l.category)}</select></td>
    <td><select class="rc-class">${classOverrideOptions(l.cls)}</select></td>
    <td class="num"><input class="rc-amt" type="number" step="0.01" min="0" inputmode="decimal" value="${l.amount}"></td>
    <td style="text-align:center"><input class="rc-tax" type="checkbox" ${l.taxable ? "checked" : ""}></td>
    <td class="num rc-withtax">—</td>
    <td class="row-actions"><button type="button" class="rc-del" title="Remove line">✕</button></td>
  </tr>`).join("");
}

function receiptCard() {
  if (!receiptDraft) receiptDraft = freshReceipt();
  const d = receiptDraft;
  return `<div class="card" id="rcCard">
    <h2>Split a receipt across categories</h2>
    <p class="card-note">One purchase, many categories. Tick the taxable lines and enter the tax — a dollar amount from the receipt, or a rate — and it's spread across those lines and folded into each line's cost. No separate tax expense is stored.</p>
    <div class="form-grid">
      <div class="field"><label>Date</label><input id="rcDate" type="date" value="${d.date}"></div>
      <div class="field"><label>Account</label><select id="rcAccount">${ownerOptions(d.account)}</select></div>
    </div>
    <div class="table-wrap"><table class="rc-table">
      <thead><tr><th>Description</th><th>Category</th><th>Class</th><th class="num">Amount</th><th>Tax?</th><th class="num">With tax</th><th></th></tr></thead>
      <tbody id="rcLines">${receiptLinesHtml(d)}</tbody>
    </table></div>
    <div class="toolbar">
      <button type="button" class="secondary-btn" id="rcAddLine">＋ Add line</button>
      <div class="spacer"></div>
      <div class="field"><label>Tax</label>
        <div style="display:flex;gap:6px;align-items:center">
          <select id="rcTaxMode">
            <option value="rate" ${d.taxMode === "rate" ? "selected" : ""}>Rate %</option>
            <option value="amount" ${d.taxMode === "amount" ? "selected" : ""}>Amount $</option>
          </select>
          <input id="rcTaxValue" type="number" step="0.01" min="0" inputmode="decimal" style="width:96px" value="${d.taxValue}">
        </div>
      </div>
    </div>
    <div class="rc-summary" id="rcSummary"></div>
    <button type="button" class="primary-btn" id="rcSave">Save receipt</button>
  </div>`;
}

function readReceiptFromDom() {
  const card = document.getElementById("rcCard");
  if (!card) return;
  receiptDraft.date = card.querySelector("#rcDate").value;
  receiptDraft.account = card.querySelector("#rcAccount").value;
  receiptDraft.taxMode = card.querySelector("#rcTaxMode").value;
  receiptDraft.taxValue = card.querySelector("#rcTaxValue").value;
  receiptDraft.lines = [...card.querySelectorAll("#rcLines tr")].map((tr) => ({
    id: tr.dataset.line,
    desc: tr.querySelector(".rc-desc").value,
    category: tr.querySelector(".rc-cat").value,
    cls: tr.querySelector(".rc-class").value,
    amount: tr.querySelector(".rc-amt").value,
    taxable: tr.querySelector(".rc-tax").checked,
  }));
}

function updateReceiptPreview() {
  const card = document.getElementById("rcCard");
  if (!card) return;
  const comp = computeReceipt(receiptDraft);
  comp.lines.forEach((l) => {
    const cell = card.querySelector(`tr[data-line="${l.id}"] .rc-withtax`);
    if (cell) cell.textContent = l.amt > 0 ? fmtMoney(l.total, true) : "—";
  });
  card.querySelector("#rcSummary").innerHTML =
    `Subtotal ${fmtMoney(comp.subtotal, true)} · Tax ${fmtMoney(comp.taxTotal, true)} · <strong>Total ${fmtMoney(comp.grandTotal, true)}</strong>`;
}

function rerenderReceiptLines() {
  const card = document.getElementById("rcCard");
  if (!card) return;
  card.querySelector("#rcLines").innerHTML = receiptLinesHtml(receiptDraft);
  updateReceiptPreview();
}

function bindReceipt(card) {
  if (!card) return;
  updateReceiptPreview();
  card.addEventListener("input", () => { readReceiptFromDom(); updateReceiptPreview(); });
  card.addEventListener("change", () => { readReceiptFromDom(); updateReceiptPreview(); });
  card.querySelector("#rcAddLine").addEventListener("click", () => {
    readReceiptFromDom();
    receiptDraft.lines.push(freshReceiptLine());
    rerenderReceiptLines();
  });
  card.querySelector("#rcLines").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".rc-del");
    if (!btn) return;
    readReceiptFromDom();
    const id = btn.closest("tr").dataset.line;
    receiptDraft.lines = receiptDraft.lines.filter((l) => l.id !== id);
    if (!receiptDraft.lines.length) receiptDraft.lines = [freshReceiptLine()];
    rerenderReceiptLines();
  });
  card.querySelector("#rcSave").addEventListener("click", () => {
    readReceiptFromDom();
    const comp = computeReceipt(receiptDraft);
    const valid = comp.lines.filter((l) => l.desc.trim() && l.amt > 0);
    if (!valid.length) return alert("Add at least one line with a description and amount.");
    const date = receiptDraft.date || new Date().toISOString().slice(0, 10);
    valid.forEach((l) => {
      const row = {
        id: uid(), date, desc: l.desc.trim(), category: l.category,
        account: receiptDraft.account, amount: Math.round(l.total * 100) / 100,
      };
      if (CLASSES.includes(l.cls)) row.class = l.cls;
      state.spending.push(row);
    });
    selectedMonth = date.slice(0, 7);
    receiptDraft = freshReceipt();
    save(); renderAll();
  });
}

function renderIncome(el) {
  const e = editing.income ? state.income.find((r) => r.id === editing.income) : null;
  const eo = editing.oneTime ? state.oneTimeIncome.find((r) => r.id === editing.oneTime) : null;
  const today = new Date().toISOString().slice(0, 10);
  const payFreqOptions = (selected) => Object.keys(PAY_FREQUENCIES)
    .map((fq) => `<option ${fq === (selected ?? "Twice a month") ? "selected" : ""}>${fq}</option>`).join("");
  const oneTimeRows = [...state.oneTimeIncome].sort((a, b) => b.date.localeCompare(a.date));
  const oneTimeTotal = oneTimeRows.reduce((s, r) => s + r.amount, 0);

  el.innerHTML = `
    <div class="card">
      <h2>${e ? "Edit paycheck" : "Recurring income (paychecks)"}</h2>
      <p class="card-note">Enter the take-home amount of a single paycheck and how often it lands. The monthly figure is computed for you — twice a month means ×2, every other week means ×2.17 (26 checks a year).</p>
      <form id="incomeForm" class="form-grid">
        <div class="field"><label>Source</label><input name="source" required value="${esc(e?.source ?? "")}" placeholder="e.g. Teaching salary"></div>
        <div class="field"><label>Owner</label><select name="owner">${ownerOptions(e?.owner)}</select></div>
        <div class="field"><label>Pay frequency</label><select name="frequency">${payFreqOptions(e?.frequency)}</select></div>
        <div class="field"><label>Amount per paycheck</label><input name="amount" type="number" step="0.01" min="0" required value="${e?.amount ?? ""}"></div>
        <div class="field"><label>Notes</label><input name="notes" value="${esc(e?.notes ?? "")}"></div>
        <button class="primary-btn">${e ? "Update" : "Add paycheck"}</button>
        ${e ? `<button type="button" class="secondary-btn" id="cancelIncome">Cancel</button>` : ""}
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>Source</th><th>Owner</th><th>Frequency</th><th class="num">Per paycheck</th><th class="num">Monthly</th><th>Notes</th><th></th></tr></thead>
        <tbody>
          ${state.income.map((r) => `<tr>
            <td>${esc(r.source)}</td>
            <td class="secondary">${esc(r.owner)}</td>
            <td class="secondary">${esc(r.frequency)}</td>
            <td class="num">${fmtMoney(r.amount, true)}</td>
            <td class="num">${fmtMoney(incomeMonthly(r), true)}</td>
            <td class="muted">${esc(r.notes)}</td>
            <td class="row-actions"><button data-edit-inc="${r.id}">Edit</button><button data-del-inc="${r.id}">Delete</button></td>
          </tr>`).join("") || `<tr><td colspan="7" class="empty-note">No paychecks yet — add one above.</td></tr>`}
          ${state.income.length ? OWNERS.map((o) => incomeByOwner(o) > 0
            ? `<tr><td class="secondary">${o} total</td><td></td><td></td><td></td><td class="num">${fmtMoney(incomeByOwner(o), true)}</td><td></td><td></td></tr>` : "").join("") : ""}
          ${state.income.length ? `<tr class="total-row"><td>TOTAL HOUSEHOLD / MO</td><td></td><td></td><td></td><td class="num">${fmtMoney(totalIncome(), true)}</td><td></td><td></td></tr>` : ""}
        </tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>${eo ? "Edit one-time income" : "One-time & extra income"}</h2>
      <p class="card-note">Bonuses, gifts, tax refunds, one-off side jobs — money that isn't a regular paycheck. Each entry counts only in the month of its date, not every month.</p>
      <form id="oneTimeForm" class="form-grid">
        <div class="field"><label>Date</label><input name="date" type="date" required value="${eo?.date ?? today}"></div>
        <div class="field"><label>Source</label><input name="source" required value="${esc(eo?.source ?? "")}" placeholder="e.g. Tax refund"></div>
        <div class="field"><label>Owner</label><select name="owner">${ownerOptions(eo?.owner ?? "Joint")}</select></div>
        <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" min="0.01" required value="${eo?.amount ?? ""}"></div>
        <div class="field"><label>Notes</label><input name="notes" value="${esc(eo?.notes ?? "")}"></div>
        <button class="primary-btn">${eo ? "Update" : "Add income"}</button>
        ${eo ? `<button type="button" class="secondary-btn" id="cancelOneTime">Cancel</button>` : ""}
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Source</th><th>Owner</th><th class="num">Amount</th><th>Notes</th><th></th></tr></thead>
        <tbody>
          ${oneTimeRows.map((r) => `<tr>
            <td class="secondary" style="white-space:nowrap">${r.date}</td>
            <td>${esc(r.source)}</td>
            <td class="secondary">${esc(r.owner)}</td>
            <td class="num">${fmtMoney(r.amount, true)}</td>
            <td class="muted">${esc(r.notes)}</td>
            <td class="row-actions"><button data-edit-ot="${r.id}">Edit</button><button data-del-ot="${r.id}">Delete</button></td>
          </tr>`).join("") || `<tr><td colspan="6" class="empty-note">No one-time income logged.</td></tr>`}
          ${oneTimeRows.length ? `<tr class="total-row"><td>TOTAL LOGGED</td><td></td><td></td><td class="num">${fmtMoney(oneTimeTotal, true)}</td><td></td><td></td></tr>` : ""}
        </tbody>
      </table></div>
    </div>`;

  el.querySelector("#incomeForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const rec = { source: f.get("source").trim(), owner: f.get("owner"), frequency: f.get("frequency"), amount: +f.get("amount"), notes: f.get("notes").trim() };
    if (e) { Object.assign(e, rec); editing.income = null; }
    else state.income.push({ id: uid(), ...rec });
    save(); renderAll();
  });
  el.querySelector("#cancelIncome")?.addEventListener("click", () => { editing.income = null; renderAll(); });
  el.querySelectorAll("[data-edit-inc]").forEach((b) => b.addEventListener("click", () => { editing.income = b.dataset.editInc; renderAll(); }));
  el.querySelectorAll("[data-del-inc]").forEach((b) => b.addEventListener("click", () => {
    state.income = state.income.filter((r) => r.id !== b.dataset.delInc);
    save(); renderAll();
  }));

  el.querySelector("#oneTimeForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const rec = { date: f.get("date"), source: f.get("source").trim(), owner: f.get("owner"), amount: +f.get("amount"), notes: f.get("notes").trim() };
    if (eo) { Object.assign(eo, rec); editing.oneTime = null; }
    else state.oneTimeIncome.push({ id: uid(), ...rec });
    save(); renderAll();
  });
  el.querySelector("#cancelOneTime")?.addEventListener("click", () => { editing.oneTime = null; renderAll(); });
  el.querySelectorAll("[data-edit-ot]").forEach((b) => b.addEventListener("click", () => { editing.oneTime = b.dataset.editOt; renderAll(); }));
  el.querySelectorAll("[data-del-ot]").forEach((b) => b.addEventListener("click", () => {
    state.oneTimeIncome = state.oneTimeIncome.filter((r) => r.id !== b.dataset.delOt);
    save(); renderAll();
  }));
}

function renderBills(el) {
  const e = editing.bill ? state.bills.find((b) => b.id === editing.bill) : null;
  const rows = [...state.bills].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const dueCell = (b) => {
    const n = daysUntil(b.dueDate);
    const when = n < 0 ? `<span class="neg">overdue</span>` : n === 0 ? "today" : `in ${n}d`;
    return `${fmtDateStr(b.dueDate)} <span class="muted">· ${when}</span>`;
  };
  el.innerHTML = `
    <div class="card">
      <h2>Recurring bills &amp; scheduled expenses</h2>
      <p class="card-note">Enter each bill once at its real frequency with its next due date — an annual bill like car registration recurs on that date each year, and the monthly equivalent is computed (a $720 semi-annual premium is $120/mo). Use "One-time" for an expense that happens once; it shows in upcoming bills but doesn't count toward the monthly total. Recurring dates roll forward automatically after they pass.</p>
      <form id="billForm" class="form-grid">
        <div class="field"><label>Bill</label><input name="name" required value="${esc(e?.name ?? "")}" placeholder="e.g. Car registration"></div>
        <div class="field"><label>Category</label><select name="category">${categoryOptions(e?.category)}</select></div>
        <div class="field"><label>Paid from</label><select name="paidFrom">${ownerOptions(e?.paidFrom ?? "Joint")}</select></div>
        <div class="field"><label>Next due</label><input name="dueDate" type="date" required value="${e?.dueDate ?? todayStr()}"></div>
        <div class="field"><label>Frequency</label><select name="frequency">${Object.keys(FREQUENCIES).map((fq) => `<option ${fq === (e?.frequency ?? "Monthly") ? "selected" : ""}>${fq}</option>`).join("")}</select></div>
        <div class="field"><label>Amount</label><input name="amount" type="number" step="0.01" min="0" required value="${e?.amount ?? ""}"></div>
        <div class="field checkbox-field"><input name="autopay" id="autopayBox" type="checkbox" ${e?.autopay !== false ? "checked" : ""}><label for="autopayBox">Auto-pay</label></div>
        <button class="primary-btn">${e ? "Update" : "Add bill"}</button>
        ${e ? `<button type="button" class="secondary-btn" id="cancelBill">Cancel</button>` : ""}
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>Bill</th><th>Category</th><th>Paid from</th><th>Next due</th><th>Frequency</th><th class="num">Amount</th><th class="num">Monthly equiv.</th><th>Auto-pay</th><th></th></tr></thead>
        <tbody>
          ${rows.map((b) => `<tr>
            <td>${esc(b.name)}</td>
            <td class="secondary">${esc(b.category)}</td>
            <td class="secondary">${esc(b.paidFrom)}</td>
            <td class="secondary" style="white-space:nowrap">${dueCell(b)}</td>
            <td class="secondary">${esc(b.frequency)}</td>
            <td class="num">${fmtMoney(b.amount, true)}</td>
            <td class="num">${b.frequency === "One-time" ? '<span class="muted">—</span>' : fmtMoney(monthlyEquivalent(b), true)}</td>
            <td class="secondary">${b.autopay ? "Yes" : "No"}</td>
            <td class="row-actions"><button data-edit="${b.id}">Edit</button><button data-del="${b.id}">Delete</button></td>
          </tr>`).join("") || `<tr><td colspan="9" class="empty-note">No bills or scheduled expenses yet.</td></tr>`}
          <tr class="total-row"><td>TOTAL / MONTH</td><td></td><td></td><td></td><td></td><td></td><td class="num">${fmtMoney(totalBills(), true)}</td><td></td><td></td></tr>
        </tbody>
      </table></div>
    </div>`;

  el.querySelector("#billForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const rec = {
      name: f.get("name").trim(),
      category: f.get("category"),
      paidFrom: f.get("paidFrom"),
      dueDate: f.get("dueDate") || todayStr(),
      frequency: f.get("frequency"),
      amount: +f.get("amount"),
      autopay: f.get("autopay") === "on",
    };
    if (e) { Object.assign(e, rec); editing.bill = null; }
    else state.bills.push({ id: uid(), ...rec });
    save(); renderAll();
  });
  el.querySelector("#cancelBill")?.addEventListener("click", () => { editing.bill = null; renderAll(); });
  el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => { editing.bill = b.dataset.edit; renderAll(); }));
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    state.bills = state.bills.filter((x) => x.id !== b.dataset.del);
    save(); renderAll();
  }));
}

function renderDebts(el) {
  const e = editing.debt ? state.debts.find((d) => d.id === editing.debt) : null;
  const totOriginal = state.debts.reduce((s, d) => s + d.original, 0);
  const totBalance = state.debts.reduce((s, d) => s + d.balance, 0);
  el.innerHTML = `
    <div class="kpi-row">
      ${statTile("Total debt", fmtMoney(totBalance), "current balances")}
      ${statTile("Paid down", fmtMoney(totOriginal - totBalance), "vs original balances")}
      ${statTile("Min payments", fmtMoney(totalMinPayments()), "required per month")}
    </div>
    <div class="card">
      <h2>Debt tracker</h2>
      <p class="card-note">Update each balance monthly. Equity = asset value − balance, for debts backed by an asset.</p>
      <form id="debtForm" class="form-grid">
        <div class="field"><label>Debt</label><input name="name" required value="${esc(e?.name ?? "")}"></div>
        <div class="field"><label>Type</label><input name="type" value="${esc(e?.type ?? "")}" placeholder="Mortgage / Auto / …" style="width:110px"></div>
        <div class="field"><label>Lender</label><input name="lender" value="${esc(e?.lender ?? "")}"></div>
        <div class="field"><label>Rate %</label><input name="rate" type="number" step="0.01" min="0" value="${e?.rate ?? ""}" style="width:80px"></div>
        <div class="field"><label>Original balance</label><input name="original" type="number" step="0.01" min="0" required value="${e?.original ?? ""}"></div>
        <div class="field"><label>Current balance</label><input name="balance" type="number" step="0.01" min="0" required value="${e?.balance ?? ""}"></div>
        <div class="field"><label>Asset value (if any)</label><input name="asset" type="number" step="0.01" min="0" value="${e?.asset ?? ""}"></div>
        <div class="field"><label>Min payment / mo</label><input name="minPayment" type="number" step="0.01" min="0" required value="${e?.minPayment ?? ""}"></div>
        <button class="primary-btn">${e ? "Update" : "Add debt"}</button>
        ${e ? `<button type="button" class="secondary-btn" id="cancelDebt">Cancel</button>` : ""}
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>Debt</th><th>Type</th><th>Lender</th><th class="num">Rate</th><th class="num">Original</th><th class="num">Balance</th><th class="num">Asset value</th><th class="num">Equity</th><th class="num">Min / mo</th><th></th></tr></thead>
        <tbody>
          ${state.debts.map((d) => `<tr>
            <td>${esc(d.name)}</td>
            <td class="secondary">${esc(d.type)}</td>
            <td class="secondary">${esc(d.lender)}</td>
            <td class="num">${d.rate ? d.rate.toFixed(2) + "%" : '<span class="muted">—</span>'}</td>
            <td class="num">${fmtMoney(d.original)}</td>
            <td class="num">${fmtMoney(d.balance)}</td>
            <td class="num">${d.asset != null ? fmtMoney(d.asset) : '<span class="muted">—</span>'}</td>
            <td class="num ${d.asset != null && d.asset - d.balance < 0 ? "neg" : ""}">${d.asset != null ? fmtMoney(d.asset - d.balance) : '<span class="muted">—</span>'}</td>
            <td class="num">${fmtMoney(d.minPayment)}</td>
            <td class="row-actions"><button data-edit="${d.id}">Edit</button><button data-del="${d.id}">Delete</button></td>
          </tr>`).join("")}
          <tr class="total-row"><td>TOTALS</td><td></td><td></td><td></td><td class="num">${fmtMoney(totOriginal)}</td><td class="num">${fmtMoney(totBalance)}</td><td></td><td></td><td class="num">${fmtMoney(totalMinPayments())}</td><td></td></tr>
        </tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>Payoff progress</h2>
      <p class="card-note">Amount paid down against each original balance.</p>
      ${state.debts.map((d) => meterRow(d.name, d.original - d.balance, d.original)).join("") || `<p class="empty-note">No debts tracked.</p>`}
    </div>`;

  el.querySelector("#debtForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const rec = {
      name: f.get("name").trim(),
      type: f.get("type").trim(),
      lender: f.get("lender").trim(),
      rate: f.get("rate") ? +f.get("rate") : 0,
      original: +f.get("original"),
      balance: +f.get("balance"),
      asset: f.get("asset") ? +f.get("asset") : null,
      minPayment: +f.get("minPayment"),
    };
    if (e) { Object.assign(e, rec); editing.debt = null; }
    else state.debts.push({ id: uid(), ...rec });
    save(); renderAll();
  });
  el.querySelector("#cancelDebt")?.addEventListener("click", () => { editing.debt = null; renderAll(); });
  el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => { editing.debt = b.dataset.edit; renderAll(); }));
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    state.debts = state.debts.filter((d) => d.id !== b.dataset.del);
    save(); renderAll();
  }));
}

function renderGoals(el) {
  const e = editing.goal ? state.goals.find((g) => g.id === editing.goal) : null;
  const ea = editing.account ? state.savingsAccounts.find((a) => a.id === editing.account) : null;
  el.innerHTML = `
    <div class="kpi-row">
      ${statTile("Total in savings", fmtMoney(totalSavings()), "across all accounts")}
      ${statTile("Goal targets", fmtMoney(state.goals.reduce((s, g) => s + g.target, 0)), "sum of all goal targets")}
      ${statTile("Monthly contributions", fmtMoney(totalGoalContributions()), "toward goals")}
    </div>
    <div class="card">
      <h2>Savings accounts</h2>
      <p class="card-note">Each real account where your savings live — name it, say whose it is, and keep the balance current. Type a new balance right in the table; it saves when you leave the field.</p>
      <form id="accountForm" class="form-grid">
        <div class="field"><label>Account name</label><input name="name" required value="${esc(ea?.name ?? "")}" placeholder="e.g. Ally joint savings"></div>
        <div class="field"><label>Owner</label><select name="owner">${ownerOptions(ea?.owner ?? "Joint")}</select></div>
        <div class="field"><label>Balance</label><input name="balance" type="number" step="0.01" min="0" required value="${ea?.balance ?? ""}"></div>
        <div class="field"><label>Notes</label><input name="notes" value="${esc(ea?.notes ?? "")}" placeholder="e.g. emergency fund lives here"></div>
        <button class="primary-btn">${ea ? "Update" : "Add account"}</button>
        ${ea ? `<button type="button" class="secondary-btn" id="cancelAccount">Cancel</button>` : ""}
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>Account</th><th>Owner</th><th class="num">Balance</th><th>Notes</th><th></th></tr></thead>
        <tbody>
          ${state.savingsAccounts.map((a) => `<tr>
            <td>${esc(a.name)}</td>
            <td class="secondary">${esc(a.owner)}</td>
            <td class="num"><input class="acct-balance" data-id="${a.id}" type="number" step="0.01" min="0" inputmode="decimal" value="${a.balance}"></td>
            <td class="muted">${esc(a.notes)}</td>
            <td class="row-actions"><button data-edit-acct="${a.id}">Rename</button><button data-del-acct="${a.id}">Delete</button></td>
          </tr>`).join("") || `<tr><td colspan="5" class="empty-note">No savings accounts yet — add your first one above.</td></tr>`}
          ${state.savingsAccounts.length ? `<tr class="total-row"><td>TOTAL SAVINGS</td><td></td><td class="num">${fmtMoney(totalSavings(), true)}</td><td></td><td></td></tr>` : ""}
        </tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>Earmarks</h2>
      <p class="card-note">Set aside money within an account for a purpose — like $50/mo for car maintenance — and record every add or pull with a date and note. Open an earmark to see its history.</p>
      ${state.savingsAccounts.length ? `
      <form id="earmarkForm" class="form-grid">
        <div class="field"><label>Earmark</label><input name="name" required placeholder="e.g. Car maintenance"></div>
        <div class="field"><label>In account</label><select name="acct">${state.savingsAccounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Planned / month</label><input name="monthly" type="number" step="1" min="0" value="0" style="width:100px"></div>
        <button class="primary-btn">Add earmark</button>
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>Earmark</th><th>Account</th><th class="num">Balance</th><th class="num">Planned / mo</th><th></th></tr></thead>
        <tbody>
          ${state.savingsAccounts.flatMap((a) => a.earmarks.map((e) => `<tr>
            <td>${esc(e.name)}</td>
            <td class="secondary">${esc(a.name)}</td>
            <td class="num">${fmtMoney(earmarkBalance(e), true)}</td>
            <td class="num">${e.monthly > 0 ? fmtMoney(e.monthly) : '<span class="muted">—</span>'}</td>
            <td class="row-actions"><button data-open-em="${a.id}:${e.id}">Open</button><button data-del-em="${a.id}:${e.id}">Delete</button></td>
          </tr>`)).join("") || `<tr><td colspan="5" class="empty-note">No earmarks yet.</td></tr>`}
        </tbody>
      </table></div>` : `<p class="empty-note">Add a savings account above first.</p>`}
    </div>
    <div class="card">
      <h2>Savings goals</h2>
      <p class="card-note">Update "saved so far" monthly. Months remaining assumes the monthly contribution holds.</p>
      <form id="goalForm" class="form-grid">
        <div class="field"><label>Goal</label><input name="name" required value="${esc(e?.name ?? "")}"></div>
        <div class="field"><label>Target</label><input name="target" type="number" step="1" min="1" required value="${e?.target ?? ""}"></div>
        <div class="field"><label>Saved so far</label><input name="saved" type="number" step="0.01" min="0" required value="${e?.saved ?? ""}"></div>
        <div class="field"><label>Monthly contribution</label><input name="monthly" type="number" step="1" min="0" required value="${e?.monthly ?? ""}"></div>
        <div class="field"><label>Notes</label><input name="notes" value="${esc(e?.notes ?? "")}"></div>
        <button class="primary-btn">${e ? "Update" : "Add goal"}</button>
        ${e ? `<button type="button" class="secondary-btn" id="cancelGoal">Cancel</button>` : ""}
      </form>
      ${state.goals.map((g) => meterRow(g.name, g.saved, g.target)).join("")}
      <div class="table-wrap"><table>
        <thead><tr><th>Goal</th><th class="num">Target</th><th class="num">Saved</th><th class="num">Remaining</th><th class="num">Monthly</th><th class="num">Months left</th><th>Notes</th><th></th></tr></thead>
        <tbody>
          ${state.goals.map((g) => {
            const remaining = Math.max(g.target - g.saved, 0);
            const months = g.monthly > 0 ? Math.ceil(remaining / g.monthly) : null;
            const done = new Date();
            if (months) done.setMonth(done.getMonth() + months);
            return `<tr>
              <td>${esc(g.name)}</td>
              <td class="num">${fmtMoney(g.target)}</td>
              <td class="num">${fmtMoney(g.saved, true)}</td>
              <td class="num">${fmtMoney(remaining, true)}</td>
              <td class="num">${fmtMoney(g.monthly)}</td>
              <td class="num">${months != null ? (remaining === 0 ? '<span class="pos">Done ✓</span>' : `${months} <span class="muted">(${done.toLocaleString("en-US", { month: "short", year: "numeric" })})</span>`) : '<span class="muted">—</span>'}</td>
              <td class="muted">${esc(g.notes)}</td>
              <td class="row-actions"><button data-edit="${g.id}">Edit</button><button data-del="${g.id}">Delete</button></td>
            </tr>`;
          }).join("")}
          <tr class="total-row"><td>TOTAL MONTHLY</td><td></td><td></td><td></td><td class="num">${fmtMoney(totalGoalContributions())}</td><td></td><td></td><td></td></tr>
        </tbody>
      </table></div>
    </div>`;

  el.querySelector("#goalForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const rec = { name: f.get("name").trim(), target: +f.get("target"), saved: +f.get("saved"), monthly: +f.get("monthly"), notes: f.get("notes").trim() };
    if (e) { Object.assign(e, rec); editing.goal = null; }
    else state.goals.push({ id: uid(), ...rec });
    save(); renderAll();
  });
  el.querySelector("#cancelGoal")?.addEventListener("click", () => { editing.goal = null; renderAll(); });
  el.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => { editing.goal = b.dataset.edit; renderAll(); }));
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
    state.goals = state.goals.filter((g) => g.id !== b.dataset.del);
    save(); renderAll();
  }));

  // Savings accounts
  el.querySelector("#accountForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const rec = { name: f.get("name").trim(), owner: f.get("owner"), balance: +f.get("balance") || 0, notes: f.get("notes").trim() };
    if (!rec.name) return;
    if (ea) { Object.assign(ea, rec); editing.account = null; }
    else state.savingsAccounts.push({ id: uid(), ...rec, earmarks: [] });
    save(); renderAll();
  });
  el.querySelector("#cancelAccount")?.addEventListener("click", () => { editing.account = null; renderAll(); });
  el.querySelectorAll("[data-edit-acct]").forEach((b) => b.addEventListener("click", () => {
    editing.account = b.dataset.editAcct;
    renderAll();
    document.querySelector("#accountForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  el.querySelectorAll("[data-del-acct]").forEach((b) => b.addEventListener("click", () => {
    const a = state.savingsAccounts.find((x) => x.id === b.dataset.delAcct);
    if (!confirm(`Delete "${a.name}"?`)) return;
    state.savingsAccounts = state.savingsAccounts.filter((x) => x.id !== b.dataset.delAcct);
    save(); renderAll();
  }));
  el.querySelectorAll(".acct-balance").forEach((inp) => inp.addEventListener("change", () => {
    const a = state.savingsAccounts.find((x) => x.id === inp.dataset.id);
    if (!a) return;
    a.balance = Math.max(0, +inp.value || 0);
    save(); renderAll();
  }));

  // Earmarks
  el.querySelector("#earmarkForm")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const acct = state.savingsAccounts.find((a) => a.id === f.get("acct"));
    const name = f.get("name").trim();
    if (!acct || !name) return;
    acct.earmarks.push({ id: uid(), name, monthly: Math.max(0, +f.get("monthly") || 0), entries: [] });
    save(); renderAll();
  });
  el.querySelectorAll("[data-open-em]").forEach((b) => b.addEventListener("click", () => {
    const [acctId, emId] = b.dataset.openEm.split(":");
    openEarmarkModal(acctId, emId);
  }));
  el.querySelectorAll("[data-del-em]").forEach((b) => b.addEventListener("click", () => {
    const [acctId, emId] = b.dataset.delEm.split(":");
    const acct = state.savingsAccounts.find((a) => a.id === acctId);
    const em = acct?.earmarks.find((e) => e.id === emId);
    if (!em || !confirm(`Delete the "${em.name}" earmark? Its history goes with it (the account balance is not changed).`)) return;
    acct.earmarks = acct.earmarks.filter((e) => e.id !== emId);
    save(); renderAll();
  }));
}

function renderData(el) {
  el.innerHTML = `
    <div class="card">
      <h2>Household</h2>
      <form id="householdForm" class="form-grid">
        <div class="field"><label>Household name</label><input name="household" value="${esc(state.household)}"></div>
        <div class="field"><label>Default sales tax rate (%)</label><input name="taxRate" type="number" step="0.001" min="0" value="${state.taxRate}"></div>
        <button class="primary-btn">Save</button>
      </form>
      <p class="card-note">The tax rate pre-fills the receipt splitter. In Kansas, groceries are state-exempt; in Missouri, groceries are taxed at a reduced 1.225% state rate — so mark taxable per line rather than relying on one blanket rate.</p>
    </div>
    <div class="card">
      <h2>Sync across devices</h2>
      ${isConnected() ? `
        <p class="card-note" id="syncStatusLine">${syncStatusHtml()}</p>
        <p class="card-note">Changes sync automatically every couple of minutes, and a few seconds after you edit. Press “Sync now” to update this instant.</p>
        <div class="toolbar">
          <button id="syncNowBtn" class="primary-btn">Sync now</button>
          <a class="secondary-btn" href="${esc(gistWebUrl())}" target="_blank" rel="noopener">View cloud data</a>
          <div class="spacer"></div>
          <button id="syncDisconnectBtn" class="secondary-btn">Disconnect</button>
        </div>
      ` : `
        <p class="card-note">Share this household between you and Lizzie through a private GitHub Gist — the same mechanism as the Spanish app. Both devices then stay in step automatically.</p>
        <div class="form-grid">
          <div class="field" style="flex:1 1 260px"><label>GitHub token (gist scope only)</label><input id="syncToken" type="password" placeholder="ghp_… or github_pat_…" autocomplete="off"></div>
          <button id="syncConnectBtn" class="primary-btn">Connect</button>
        </div>
        <p class="card-note"><a href="https://github.com/settings/tokens/new?scopes=gist&description=Household%20Finance%20sync" target="_blank" rel="noopener">Create a token →</a> Both of you connect with the <strong>same GitHub account</strong> (or paste the same token) so you share one cloud copy. The token is stored only in this browser.</p>
      `}
    </div>
    <div class="card">
      <h2>Backup &amp; restore</h2>
      <p class="card-note">Everything is stored locally in this browser. Export a JSON backup to move it to another device, or paste a backup below and import it.</p>
      <div class="toolbar">
        <button id="exportBtn" class="primary-btn">Export JSON</button>
        <button id="importBtn" class="secondary-btn">Import from box below</button>
        <div class="spacer"></div>
        <button id="resetBtn" class="danger-btn">Clear all data</button>
      </div>
      <textarea id="ioArea" class="io-area" placeholder="Paste an exported backup here, then press Import."></textarea>
    </div>
    <div class="card">
      <h2>About</h2>
      <p class="card-note">A local-first household budget app. Add your paychecks and one-time income on the Income tab, set category limits on the Budget tab, and log expenses on the Spending tab — those drive the Budget actuals and the Dashboard automatically.</p>
    </div>`;

  el.querySelector("#householdForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    state.household = f.get("household").trim() || "Household";
    state.taxRate = Math.max(0, +f.get("taxRate") || 0);
    save(); renderAll();
  });
  el.querySelector("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `household-finance-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  el.querySelector("#importBtn").addEventListener("click", () => {
    const text = el.querySelector("#ioArea").value.trim();
    if (!text) return alert("Paste an exported backup into the box first.");
    try {
      const data = JSON.parse(text);
      const keys = ["categories", "spending", "income", "bills", "debts", "goals"];
      if (!keys.every((k) => Array.isArray(data[k]))) throw new Error("missing sections");
      if (!confirm("Replace ALL current data with this backup?")) return;
      state = {
        household: String(data.household ?? "Household"),
        taxRate: typeof data.taxRate === "number" ? data.taxRate : 0,
        ...Object.fromEntries(keys.map((k) => [k, data[k]])),
        oneTimeIncome: Array.isArray(data.oneTimeIncome) ? data.oneTimeIncome : [],
        savingsAccounts: Array.isArray(data.savingsAccounts) ? data.savingsAccounts : [],
      };
      state.income.forEach((r) => { if (!r.frequency) r.frequency = "Monthly"; });
      state.categories.forEach((c) => { if (!CLASSES.includes(c.class)) c.class = DEFAULT_CLASS_BY_NAME[c.name] || "Need"; });
      save(); renderAll();
    } catch {
      alert("That doesn't look like a valid backup file.");
    }
  });
  el.querySelector("#resetBtn").addEventListener("click", () => {
    if (!confirm("Delete ALL data and start from an empty app? This cannot be undone.")) return;
    state = seedData();
    save(); renderAll();
  });

  // Sync controls
  el.querySelector("#syncConnectBtn")?.addEventListener("click", async () => {
    const input = el.querySelector("#syncToken");
    const tok = input.value.trim();
    if (!tok) return alert("Paste your GitHub token first.");
    const btn = el.querySelector("#syncConnectBtn");
    btn.disabled = true; btn.textContent = "Connecting…";
    try {
      await connectSync(tok);
      renderAll();
    } catch (e) {
      alert("Couldn't connect: " + (e.message || e));
      btn.disabled = false; btn.textContent = "Connect";
    }
  });
  el.querySelector("#syncNowBtn")?.addEventListener("click", async () => {
    const btn = el.querySelector("#syncNowBtn");
    btn.disabled = true;
    await syncTick();
    renderAll();
  });
  el.querySelector("#syncDisconnectBtn")?.addEventListener("click", () => {
    if (!confirm("Stop syncing on this device? Your data stays here — it just won't sync until you reconnect.")) return;
    disconnectSync(); renderAll();
  });
}

// ---------- Shell ----------

const RENDERERS = {
  dashboard: renderDashboard,
  budget: renderBudget,
  spending: renderSpending,
  income: renderIncome,
  bills: renderBills,
  debts: renderDebts,
  goals: renderGoals,
  data: renderData,
};

let activeTab = "dashboard";

function renderAll() {
  document.getElementById("householdName").textContent = state.household;
  for (const [name, render] of Object.entries(RENDERERS)) {
    const panel = document.getElementById(`tab-${name}`);
    panel.classList.toggle("active", name === activeTab);
    if (name === activeTab) render(panel);
    else panel.innerHTML = "";
  }
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === activeTab));
  updateSyncBadge();
}

document.getElementById("tabs").addEventListener("click", (ev) => {
  const tab = ev.target.closest(".tab");
  if (!tab) return;
  activeTab = tab.dataset.tab;
  editing = {};
  renderAll();
});

document.getElementById("themeToggle").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme === "dark" || (root.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "light" : "dark";
  localStorage.setItem("household-finance-theme", root.dataset.theme);
});
{
  const savedTheme = localStorage.getItem("household-finance-theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
}

renderAll();

// Kick off cloud sync if this device is already connected: pull others' changes
// on load, then poll in the background.
if (isConnected()) {
  setSyncStatus("ok");
  syncTick();
  startAutoSync();
}
