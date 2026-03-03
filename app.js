import * as idb from "./idb.js";

const PSID_DEFAULT = "100000160";
const GOOGLE_CLIENT_ID = "PASTE_YOUR_CLIENT_ID_HERE.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const DRIVE_PROGRESS_FILENAME = "lovcryptic_progress_v1.json";

const FETCH_TIMEOUT_MS = 8000;
const INDEX_REFRESH_EVERY_MS = 30 * 60 * 1000;

const $ = (s) => document.querySelector(s);

const homeView = $("#homeView");
const puzzleView = $("#puzzleView");
const archiveEl = $("#archive");
const homeStatusEl = $("#homeStatus");

const sortBtn = $("#sortBtn");
const filterBtn = $("#filterBtn");
const homeMenuBtn = $("#homeMenuBtn");

const hintBtn = $("#hintBtn");
const menuBtn = $("#menuBtn");

const homeMenu = $("#homeMenu");
const homeThemeBtn = $("#homeThemeBtn");
const loginBtn = $("#loginBtn");
const logoutBtn = $("#logoutBtn");
const accountLine = $("#accountLine");

const themeMenu = $("#themeMenu");
const sortMenu = $("#sortMenu");
const filterMenu = $("#filterMenu");

const gridEl = $("#grid");
const clueBar = $("#clueBar");
const timerEl = $("#timer");
const kbd = $("#kbd");

const hintMenu = $("#hintMenu");
const mainMenu = $("#mainMenu");
const restartConfirm = $("#restartConfirm");
const congrats = $("#congrats");
const congratsBody = $("#congratsBody");
const congratsExitBtn = $("#congratsExitBtn");

const revealLetterBtn = $("#revealLetterBtn");
const revealWordBtn = $("#revealWordBtn");
const checkWordBtn = $("#checkWordBtn");
const checkPuzzleBtn = $("#checkPuzzleBtn");
const toggleChecksBtn = $("#toggleChecksBtn");

const saveExitBtn = $("#saveExitBtn");
const restartBtn = $("#restartBtn");
const restartYesBtn = $("#restartYesBtn");

let filterMode = localStorage.getItem("lovcrypticFilter") || "all";
let sortMode = localStorage.getItem("lovcrypticSort") || "newest";

let current = { key:null, psid:PSID_DEFAULT, date:null, spec:null, progress:null, selected:null };
let puzzleOpen = false;

let correctWordIds = new Set();

let indexTimer = null;

// auth state (optional)
let accessToken = null;
let tokenClient = null;
let driveFileId = null;
let signedIn = false;

installGlobalErrorOverlay();
init().catch((e) => fatal(e));

function installGlobalErrorOverlay() {
  const box = document.createElement("div");
  box.id = "fatalBox";
  box.style.cssText = `
    position:fixed; inset:12px; z-index:99999; display:none;
    background:rgba(0,0,0,.88); color:white; padding:14px;
    border-radius:14px; font: 14px/1.35 system-ui, -apple-system, Segoe UI, Roboto;
    overflow:auto;
  `;
  document.body.appendChild(box);

  window.addEventListener("error", (ev) => {
    fatal(ev?.error || ev?.message || "Unknown error");
  });
  window.addEventListener("unhandledrejection", (ev) => {
    fatal(ev?.reason || "Unhandled promise rejection");
  });
}

function fatal(err) {
  const box = document.getElementById("fatalBox");
  if (!box) return;
  const msg = (err && err.stack) ? err.stack : String(err);
  box.style.display = "block";
  box.textContent =
    `LovCryptic error:\n\n${msg}\n\n` +
    `Common fixes:\n` +
    `• Confirm puzzles/index.json loads (no 404)\n` +
    `• Confirm idb.js exists and is served\n` +
    `• GitHub Pages points to correct branch/folder\n`;
  homeStatusEl.textContent = "Error (see overlay)";
}

async function init() {
  applySavedTheme();
  applyLastUpdatedLabel();

  // menu wiring
  sortBtn.addEventListener("click", () => openSheet("sortMenu"));
  filterBtn.addEventListener("click", () => openSheet("filterMenu"));
  homeMenuBtn.addEventListener("click", () => openSheet("homeMenu"));
  homeThemeBtn.addEventListener("click", () => { closeSheet("homeMenu"); openSheet("themeMenu"); });

  hintBtn.addEventListener("click", () => openSheet("hintMenu"));
  menuBtn.addEventListener("click", () => openSheet("mainMenu"));

  loginBtn.addEventListener("click", async () => loginGoogle());
  logoutBtn.addEventListener("click", () => logoutGoogle());

  document.body.addEventListener("click", async (e) => {
    const closeId = e.target?.getAttribute?.("data-close");
    if (closeId) closeSheet(closeId);

    if (e.target === homeMenu) closeSheet("homeMenu");
    if (e.target === themeMenu) closeSheet("themeMenu");
    if (e.target === sortMenu) closeSheet("sortMenu");
    if (e.target === filterMenu) closeSheet("filterMenu");
    if (e.target === hintMenu) closeSheet("hintMenu");
    if (e.target === mainMenu) closeSheet("mainMenu");
    if (e.target === restartConfirm) closeSheet("restartConfirm");
    if (e.target === congrats) return;

    const s = e.target?.getAttribute?.("data-sort");
    if (s) { sortMode = s; localStorage.setItem("lovcrypticSort", sortMode); closeSheet("sortMenu"); await renderHome(); }

    const f = e.target?.getAttribute?.("data-filter");
    if (f) { filterMode = f; localStorage.setItem("lovcrypticFilter", filterMode); closeSheet("filterMenu"); await renderHome(); }

    const t = e.target?.getAttribute?.("data-theme");
    if (t) { setTheme(t); closeSheet("themeMenu"); }
  });

  revealLetterBtn.addEventListener("click", async () => { closeSheet("hintMenu"); await hintRevealLetter(); });
  revealWordBtn.addEventListener("click", async () => { closeSheet("hintMenu"); await hintRevealWord(); });
  checkWordBtn.addEventListener("click", async () => { closeSheet("hintMenu"); await hintCheckWord(); });
  checkPuzzleBtn.addEventListener("click", async () => { closeSheet("hintMenu"); await hintCheckPuzzle(); });

  toggleChecksBtn.addEventListener("click", async () => {
    if (!current.progress) return;
    current.progress.wordChecks = !current.progress.wordChecks;
    toggleChecksBtn.textContent = `Word checks: ${current.progress.wordChecks ? "On" : "Off"}`;
    if (!current.progress.wordChecks) { correctWordIds.clear(); clearAllGreen(); }
    else { recomputeCorrectWords(); paintGreenFromSet(); }
    await autosave(true);
  });

  saveExitBtn.addEventListener("click", async () => { closeSheet("mainMenu"); await exitPuzzle(); });
  restartBtn.addEventListener("click", () => { closeSheet("mainMenu"); openSheet("restartConfirm"); });
  restartYesBtn.addEventListener("click", async () => { closeSheet("restartConfirm"); await restartPuzzle(); });
  congratsExitBtn.addEventListener("click", async () => { closeSheet("congrats"); await exitPuzzle(); });

  kbd.addEventListener("keydown", onKeyDown);

  // IMPORTANT: never hang on index load; show errors
  await refreshIndexAndCache({ quiet: false });
  await renderHome();

  scheduleIndexRefresh();
  await initGoogleTokenClient();
  updateAccountUI();
}

/* ---------- index refresh (robust status) ---------- */

async function refreshIndexAndCache({ quiet }) {
  try {
    if (!quiet) homeStatusEl.textContent = "Loading puzzles…";

    const idx = await fetchJson("./puzzles/index.json", { cache: "no-store" });
    const dates = Array.isArray(idx?.dates) ? idx.dates : [];
    const psid = String(idx?.psid || PSID_DEFAULT);

    const existing = await idb.getAll("puzzles");
    const existingKeys = new Set(existing.map(p => p.key));

    let added = 0;
    for (const d of dates) {
      const key = `${psid}|${d}`;
      if (existingKeys.has(key)) continue;

      const url = `./puzzles/${psid}/${d}.json`;
      const data = await fetchJson(url, { cache: "no-store" });
      await idb.put("puzzles", { key, psid, date: d, fetchedAt: Date.now(), data });
      added++;
    }

    homeStatusEl.textContent = added ? `Loaded (+${added})` : "Loaded";
  } catch (e) {
    // Show a clear error in status (no infinite “Loading…”)
    homeStatusEl.textContent = "Failed to load puzzles (tap for error)";
    // Also throw so overlay shows the exact stack/HTTP code
    throw e;
  }
}

function scheduleIndexRefresh() {
  if (indexTimer) clearInterval(indexTimer);
  indexTimer = setInterval(async () => {
    const onHome = !homeView.classList.contains("hidden");
    if (!onHome || document.hidden) return;
    try {
      await refreshIndexAndCache({ quiet: true });
      await renderHome();
    } catch {}
  }, INDEX_REFRESH_EVERY_MS);
}

/* ---------- minimal home render so you can at least see something ---------- */

async function renderHome() {
  const puzzles = await idb.getAll("puzzles");
  if (!puzzles.length) {
    archiveEl.innerHTML = `<div class="muted">No cached puzzles found. Confirm puzzles/index.json exists on GitHub Pages.</div>`;
    return;
  }
  archiveEl.innerHTML = puzzles
    .sort((a,b)=> (a.date < b.date ? 1 : -1))
    .slice(0, 30)
    .map(p => `<div class="card"><div><b>${p.date}</b></div><div class="pct"><b>Open</b></div></div>`)
    .join("");
}

/* ---------- helpers you already have elsewhere (stubs to avoid crash) ---------- */

function openSheet(id){ document.body.classList.add("modalOpen"); $(`#${id}`).classList.remove("hidden"); }
function closeSheet(id){ $(`#${id}`).classList.add("hidden"); const anyOpen=document.querySelector(".sheet:not(.hidden)"); if(!anyOpen)document.body.classList.remove("modalOpen"); }
function applySavedTheme(){ const t=localStorage.getItem("lovcrypticTheme")||"light"; document.body.setAttribute("data-theme",t); }
function applyLastUpdatedLabel(){ const s=localStorage.getItem("lovcrypticLastUpdated"); if(s) homeStatusEl.textContent=`Updated ${s}`; }
function setTheme(t){ document.body.setAttribute("data-theme",t); localStorage.setItem("lovcrypticTheme",t); }
async function autosave(){ /* no-op here; your full app has this */ }
function recomputeCorrectWords(){}
function paintGreenFromSet(){}
function clearAllGreen(){}
async function hintRevealLetter(){}
async function hintRevealWord(){}
async function hintCheckWord(){}
async function hintCheckPuzzle(){}
async function exitPuzzle(){}
async function restartPuzzle(){}
async function onKeyDown(){}

/* ---------- fetchJson with timeout ---------- */

async function fetchJson(url, fetchOpts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...fetchOpts, signal: ctrl.signal, cache: fetchOpts.cache || "no-store" });
    if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/* ---------- Google token client (optional) ---------- */

async function initGoogleTokenClient() {
  for (let i = 0; i < 40; i++) {
    if (window.google?.accounts?.oauth2?.initTokenClient) break;
    await new Promise(r => setTimeout(r, 150));
  }
  if (!window.google?.accounts?.oauth2?.initTokenClient) return;

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (resp) => {
      if (resp?.access_token) {
        accessToken = resp.access_token;
        signedIn = true;
        driveFileId = null;
        updateAccountUI();
      }
    }
  });
}

async function loginGoogle() {
  if (!tokenClient) await initGoogleTokenClient();
  if (!tokenClient) throw new Error("Google login script not ready");
  tokenClient.requestAccessToken({ prompt: "consent" });
}
function logoutGoogle() {
  accessToken = null; signedIn = false; driveFileId = null; updateAccountUI();
}
function updateAccountUI() {
  if (signedIn) {
    accountLine.textContent = "Signed in (Google)";
    loginBtn.classList.add("hidden");
    logoutBtn.classList.remove("hidden");
  } else {
    accountLine.textContent = "Not signed in";
    loginBtn.classList.remove("hidden");
    logoutBtn.classList.add("hidden");
  }
}


