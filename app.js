import * as idb from "./idb.js";

/* ===========================
   CONFIG
=========================== */

const PSID_DEFAULT = "100000160";
const GOOGLE_CLIENT_ID =
  "36850930626-iunbe4q4pds4ouea93f39rjqkk1icgs0.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

const FETCH_TIMEOUT_MS = 8000;
const INDEX_REFRESH_EVERY_MS = 30 * 60 * 1000;

const DRIVE_PROGRESS_FILENAME = "lovcryptic_progress_v1.json";

const LS = {
  filter: "lovcrypticFilter",
  sort: "lovcrypticSort",
  theme: "lovcrypticTheme",
  lastUpdated: "lovcrypticLastUpdated",
  autoLogin: "lovcrypticGoogleAutoLogin", // "1" when user has granted consent once
};

/* ===========================
   DOM
=========================== */

const $ = (s) => document.querySelector(s);

const homeView = $("#homeView");
const puzzleView = $("#puzzleView");

const archiveEl = $("#archive");
const homeStatusEl = $("#homeStatus");

const sortBtn = $("#sortBtn");
const filterBtn = $("#filterBtn");
const homeMenuBtn = $("#homeMenuBtn");

const gridEl = $("#grid");
const clueBar = $("#clueBar");
const timerEl = $("#timer");
const kbd = $("#kbd");

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

/* ===========================
   STATE
=========================== */

let filterMode = localStorage.getItem(LS.filter) || "all";
let sortMode = localStorage.getItem(LS.sort) || "newest";

let current = {
  key: null,
  psid: PSID_DEFAULT,
  date: null,
  spec: null,
  progress: null,
  selected: null,
};

let puzzleOpen = false;

let savePending = null;
let syncPending = null;

// verified correct words
let correctWordIds = new Set();

// timer loop
let clockRaf = null;
let clockActive = false;
let lastPaintedSecond = null;

// index refresh timer
let indexTimer = null;

// auth
let accessToken = null;
let tokenClient = null;
let driveFileId = null;
let signedIn = false;

/* ===========================
   INIT
=========================== */

init().catch((e) => {
  console.error(e);
  homeStatusEl.textContent = "Error (see console)";
});

async function init() {
  await registerServiceWorker();

  applySavedTheme();
  applyLastUpdatedLabel();
  updateSortFilterButtonLabels();

  try {
    await normalizeOrphanRunningTimers();
  } catch (e) {
    console.error(e);
    homeStatusEl.textContent = "Storage unavailable (IndexedDB blocked)";
  }

  // Home controls
  sortBtn.addEventListener("click", () => openSheet("sortMenu"));
  filterBtn.addEventListener("click", () => openSheet("filterMenu"));
  homeMenuBtn.addEventListener("click", () => openSheet("homeMenu"));

  homeThemeBtn.addEventListener("click", () => {
    closeSheet("homeMenu");
    openSheet("themeMenu");
  });

  loginBtn.addEventListener("click", async () => loginGoogle(true));
  logoutBtn.addEventListener("click", () => logoutGoogle());

  // Puzzle controls
  hintBtn.addEventListener("click", () => openSheet("hintMenu"));
  menuBtn.addEventListener("click", () => openSheet("mainMenu"));

  // Global click handling (sheets + pickers)
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
    if (s) {
      sortMode = s;
      localStorage.setItem(LS.sort, sortMode);
      updateSortFilterButtonLabels();
      closeSheet("sortMenu");
      await renderHome();
    }

    const f = e.target?.getAttribute?.("data-filter");
    if (f) {
      filterMode = f;
      localStorage.setItem(LS.filter, filterMode);
      updateSortFilterButtonLabels();
      closeSheet("filterMenu");
      await renderHome();
    }

    const t = e.target?.getAttribute?.("data-theme");
    if (t) {
      setTheme(t);
      closeSheet("themeMenu");
    }
  });

  // Hints + checks
  revealLetterBtn.addEventListener("click", async () => {
    closeSheet("hintMenu");
    await hintRevealLetter();
  });
  revealWordBtn.addEventListener("click", async () => {
    closeSheet("hintMenu");
    await hintRevealWord();
  });
  checkWordBtn.addEventListener("click", async () => {
    closeSheet("hintMenu");
    await hintCheckWord();
  });
  checkPuzzleBtn.addEventListener("click", async () => {
    closeSheet("hintMenu");
    await hintCheckPuzzle();
  });

  toggleChecksBtn.addEventListener("click", async () => {
    if (!current.progress) return;
    current.progress.wordChecks = !current.progress.wordChecks;
    toggleChecksBtn.setAttribute("aria-pressed", String(current.progress.wordChecks));
    toggleChecksBtn.textContent = `Word checks: ${current.progress.wordChecks ? "On" : "Off"}`;

    if (!current.progress.wordChecks) {
      correctWordIds.clear();
      clearAllGreen();
    } else {
      recomputeCorrectWords();
      paintGreenFromSet();
    }
    await autosave(true);
  });

  // Menu actions
  saveExitBtn.addEventListener("click", async () => {
    closeSheet("mainMenu");
    await exitPuzzle();
  });

  restartBtn.addEventListener("click", () => {
    closeSheet("mainMenu");
    openSheet("restartConfirm");
  });
  restartYesBtn.addEventListener("click", async () => {
    closeSheet("restartConfirm");
    await restartPuzzle();
  });

  congratsExitBtn.addEventListener("click", async () => {
    closeSheet("congrats");
    await exitPuzzle();
  });

  // Keyboard
  kbd.addEventListener("keydown", onKeyDown);
  window.addEventListener("keydown", onGlobalKeyDown);

  // Lifecycle
  document.addEventListener("visibilitychange", async () => {
    if (!document.hidden) {
      try {
        await normalizeOrphanRunningTimers();
      } catch {}
      if (!puzzleOpen) await refreshIndexAndCache({ quiet: true });
    } else {
      if (puzzleOpen) await stopTimerAndSave();
    }
  });

  window.addEventListener("pageshow", async () => {
    try {
      await normalizeOrphanRunningTimers();
    } catch {}
    if (!puzzleOpen) await refreshIndexAndCache({ quiet: true });
  });

  window.addEventListener("resize", () => {
    if (current.spec) computeCellSize(current.spec.rows, current.spec.cols);
  });

  // Load index → metadata fast
  await refreshIndexAndCache({ quiet: false });
  await renderHome();
  scheduleIndexRefresh();

  // Google
  await initGoogleTokenClient();
  updateAccountUI();

  // Silent “stay logged in” on refresh/reopen if previously granted
  if (localStorage.getItem(LS.autoLogin) === "1") {
    await loginGoogle(false); // no prompt
  }

  homeStatusEl.textContent = "Loaded";
}

/* ===========================
   SORT/FILTER LABELS
=========================== */

function sortLabel(mode) {
  if (mode === "oldest") return "Old → New";
  if (mode === "recent") return "Recent";
  return "New → Old"; // newest
}

function filterLabel(mode) {
  if (mode === "incomplete") return "In progress";
  if (mode === "completed") return "Completed";
  if (mode === "not_started") return "Not started";
  return "All";
}

function updateSortFilterButtonLabels() {
  sortBtn.textContent = sortLabel(sortMode);
  filterBtn.textContent = filterLabel(filterMode);
}

/* ===========================
   THEME + LABELS
=========================== */

function applySavedTheme() {
  const t = localStorage.getItem(LS.theme) || "light";
  setTheme(t);
}

function setTheme(t) {
  document.body.setAttribute("data-theme", t);
  localStorage.setItem(LS.theme, t);
}

function applyLastUpdatedLabel() {
  const s = localStorage.getItem(LS.lastUpdated);
  if (s) homeStatusEl.textContent = `Updated ${s}`;
}

/* ===========================
   SERVICE WORKER
=========================== */

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("./sw.js");

    if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });

    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) {
          nw.postMessage({ type: "SKIP_WAITING" });
        }
      });
    });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (window.__lovcryptic_reloaded) return;
      window.__lovcryptic_reloaded = true;
      window.location.reload();
    });
  } catch (e) {
    console.error(e);
  }
}

/* ===========================
   GOOGLE LOGIN (GIS token client)
=========================== */

async function initGoogleTokenClient() {
  for (let i = 0; i < 40; i++) {
    if (window.google?.accounts?.oauth2?.initTokenClient) break;
    await sleep(150);
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
        localStorage.setItem(LS.autoLogin, "1");
        updateAccountUI();
        pullProgressFromDrive().catch(() => {});
      }
    },
  });
}

// interactive=true -> prompt consent; interactive=false -> silent (prompt:"")
async function loginGoogle(interactive) {
  if (!tokenClient) await initGoogleTokenClient();
  if (!tokenClient) {
    alert("Google login not ready yet. Please refresh and try again.");
    return;
  }

  const prompt = interactive ? "consent" : "";
  return new Promise((resolve) => {
    const prev = tokenClient.callback;
    tokenClient.callback = (resp) => {
      tokenClient.callback = prev;
      if (resp?.access_token) {
        accessToken = resp.access_token;
        signedIn = true;
        driveFileId = null;
        localStorage.setItem(LS.autoLogin, "1");
        updateAccountUI();
        pullProgressFromDrive().catch(() => {});
      } else if (interactive) {
        // interactive attempt failed/canceled; keep state unchanged
      }
      resolve();
    };
    tokenClient.requestAccessToken({ prompt });
  });
}

function logoutGoogle() {
  accessToken = null;
  signedIn = false;
  driveFileId = null;
  localStorage.removeItem(LS.autoLogin);
  updateAccountUI();
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

async function silentRefreshToken() {
  // Only attempt if user has previously granted consent
  if (!tokenClient) await initGoogleTokenClient();
  if (!tokenClient) throw new Error("Token client not ready");
  if (localStorage.getItem(LS.autoLogin) !== "1") throw new Error("No prior consent");

  return new Promise((resolve, reject) => {
    const prev = tokenClient.callback;
    tokenClient.callback = (resp) => {
      tokenClient.callback = prev;
      if (resp?.access_token) {
        accessToken = resp.access_token;
        signedIn = true;
        updateAccountUI();
        resolve();
      } else {
        accessToken = null;
        signedIn = false;
        updateAccountUI();
        reject(new Error("Silent token refresh failed"));
      }
    };
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

/* ===========================
   DRIVE APPDATA PROGRESS
=========================== */

async function driveRequest(url, opts = {}, _retry = true) {
  if (!accessToken) throw new Error("Not signed in");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        ...(opts.headers || {}),
        Authorization: `Bearer ${accessToken}`,
      },
    });

    // If token expired, try one silent refresh and retry once
    if ((res.status === 401 || res.status === 403) && _retry) {
      try {
        await silentRefreshToken();
        return driveRequest(url, opts, false);
      } catch {
        // fall through to throw
      }
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Drive HTTP ${res.status}: ${txt}`);
    }
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function findOrCreateDriveFileId() {
  if (driveFileId) return driveFileId;

  const q = encodeURIComponent(`name='${DRIVE_PROGRESS_FILENAME}' and trashed=false`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)`;
  const res = await driveRequest(url);
  const js = await res.json();
  const file = js.files?.[0];
  if (file?.id) {
    driveFileId = file.id;
    return driveFileId;
  }

  const meta = { name: DRIVE_PROGRESS_FILENAME, parents: ["appDataFolder"] };
  const boundary = "-------314159265358979323846";
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify({ version: 1, updatedAt: Date.now(), progress: {} })}\r\n` +
    `--${boundary}--`;

  const createRes = await driveRequest(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  const created = await createRes.json();
  driveFileId = created.id;
  return driveFileId;
}

async function pullProgressFromDrive() {
  const fid = await findOrCreateDriveFileId();
  const res = await driveRequest(`https://www.googleapis.com/drive/v3/files/${fid}?alt=media`);
  const cloud = await res.json().catch(() => ({ version: 1, progress: {} }));
  const cloudMap = cloud?.progress || {};

  const localAll = await idb.getAll("progress");
  const localMap = new Map(localAll.map((r) => [r.key, r]));
  const now = Date.now();

  for (const [key, cloudRec] of Object.entries(cloudMap)) {
    const localRec = localMap.get(key);
    if (!localRec) {
      await idb.put("progress", {
        key,
        updatedAt: cloudRec.updatedAt || now,
        progress: cloudRec.progress,
        snap: cloudRec.snap || null,
      });
      continue;
    }
    const lc = localRec.updatedAt || 0;
    const cc = cloudRec.updatedAt || 0;
    if (cc > lc) {
      await idb.put("progress", {
        key,
        updatedAt: cc,
        progress: cloudRec.progress,
        snap: cloudRec.snap || localRec.snap || null,
      });
    }
  }

  await pushProgressToDrive({ merge: true });
  await renderHome();
}

async function pushProgressToDrive({ merge } = { merge: true }) {
  if (!accessToken) return;
  const fid = await findOrCreateDriveFileId();

  let base = { version: 1, updatedAt: Date.now(), progress: {} };
  if (merge) {
    try {
      const res = await driveRequest(`https://www.googleapis.com/drive/v3/files/${fid}?alt=media`);
      base = await res.json();
      if (!base || typeof base !== "object") base = { version: 1, updatedAt: Date.now(), progress: {} };
      if (!base.progress) base.progress = {};
    } catch {}
  }

  const localAll = await idb.getAll("progress");
  for (const rec of localAll) {
    base.progress[rec.key] = {
      updatedAt: rec.updatedAt || Date.now(),
      progress: rec.progress,
      snap: rec.snap || null,
    };
  }
  base.updatedAt = Date.now();

  await driveRequest(`https://www.googleapis.com/upload/drive/v3/files/${fid}?uploadType=media`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(base),
  });
}

function scheduleCloudSync() {
  if (!signedIn) return;
  if (syncPending) clearTimeout(syncPending);
  syncPending = setTimeout(() => {
    pushProgressToDrive({ merge: true }).catch(() => {});
    syncPending = null;
  }, 1200);
}

/* ===========================
   PUZZLES INDEX → METADATA ONLY
=========================== */

async function refreshIndexAndCache({ quiet }) {
  try {
    if (!quiet) homeStatusEl.textContent = "Loading puzzles…";

    const idx = await fetchJson("./puzzles/index.json", { cache: "no-store" });
    const dates = Array.isArray(idx?.dates) ? idx.dates : [];
    const psid = String(idx?.psid || PSID_DEFAULT);

    const existing = await idb.getAll("puzzles");
    const existingKeys = new Set(existing.map((p) => p.key));

    let inserted = 0;
    for (const d of dates) {
      const key = `${psid}|${d}`;
      if (existingKeys.has(key)) continue;
      await idb.put("puzzles", { key, psid, date: d, fetchedAt: 0, data: null });
      inserted++;
    }

    localStorage.setItem(LS.lastUpdated, new Date().toLocaleString());
    applyLastUpdatedLabel();
    if (!quiet) homeStatusEl.textContent = inserted ? "Loaded" : (homeStatusEl.textContent || "Loaded");
  } catch (e) {
    console.error(e);
    const s = localStorage.getItem(LS.lastUpdated);
    homeStatusEl.textContent = s ? `Updated ${s} (offline)` : "Offline";
  }
}

function scheduleIndexRefresh() {
  if (indexTimer) clearInterval(indexTimer);
  indexTimer = setInterval(async () => {
    const onHome = !homeView.classList.contains("hidden");
    if (!onHome || document.hidden) return;
    await refreshIndexAndCache({ quiet: true });
    await renderHome();
  }, INDEX_REFRESH_EVERY_MS);
}

/* ===========================
   HOME LIST
=========================== */

async function renderHome() {
  try {
    await normalizeOrphanRunningTimers();
  } catch {}

  const puzzles = await idb.getAll("puzzles");
  const progress = await idb.getAll("progress");
  const progMap = new Map(progress.map((p) => [p.key, p]));
  const now = Date.now();

  const items = puzzles.map((p) => {
    const pr = progMap.get(p.key);
    const snap = pr?.snap || { pct: 0 };
    const isCompleted = !!pr?.progress?.completed;

    const elapsedMs = pr?.progress?.elapsedMs || 0;
    const runningSince = pr?.progress?.runningSince || null;

    const isThisOpen = puzzleOpen && current?.key && p.key === current.key;
    const timeMs = elapsedMs + (isThisOpen && runningSince ? now - runningSince : 0);

    const lastOpenedAt = pr?.progress?.lastOpenedAt || 0;
    return { p, snap, isCompleted, timeMs, lastOpenedAt };
  });

  if (sortMode === "recent") {
    items.sort((a, b) => (b.lastOpenedAt - a.lastOpenedAt) || (a.p.date < b.p.date ? 1 : -1));
  } else if (sortMode === "oldest") {
    items.sort((a, b) => (a.p.date < b.p.date ? -1 : 1));
  } else {
    items.sort((a, b) => (a.p.date < b.p.date ? 1 : -1));
  }

  archiveEl.innerHTML = "";
  let shown = 0;

  for (const it of items) {
    const { p, snap, isCompleted, timeMs } = it;

    const startedByTime = timeMs > 0;
    const isNotStarted = !startedByTime;

    if (filterMode === "incomplete" && !(startedByTime && !isCompleted)) continue;
    if (filterMode === "completed" && !isCompleted) continue;
    if (filterMode === "not_started" && !isNotStarted) continue;

    const status = isCompleted ? "Completed" : isNotStarted ? "Not started" : "In progress";
    const timeLabel = isNotStarted ? "Not started" : fmtTime(timeMs);

    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");

    card.innerHTML = `<div>
        <div><b>${escapeHtml(p.date)}</b></div>
        <small>${status} • ${timeLabel}</small>
      </div>
      <div class="pct"><b>${snap.pct ?? 0}%</b></div>`;

    const open = async () => openPuzzle(p.psid, p.date);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });

    archiveEl.appendChild(card);
    shown++;
  }

  if (!puzzles.length) {
    archiveEl.innerHTML = `<div class="muted">No cached puzzles yet (run the Action backfill once).</div>`;
  } else if (!shown) {
    archiveEl.innerHTML = `<div class="muted">No puzzles match this filter.</div>`;
  }
}

/* ===========================
   ORPHAN TIMER HEALING
=========================== */

async function normalizeOrphanRunningTimers() {
  const all = await idb.getAll("progress");
  const now = Date.now();

  for (const rec of all) {
    const p = rec?.progress;
    if (!p?.runningSince) continue;

    const isCurrentlyOpen = puzzleOpen && current?.key && rec.key === current.key;
    if (isCurrentlyOpen) continue;

    const delta = now - p.runningSince;
    if (delta > 0) p.elapsedMs = (p.elapsedMs || 0) + delta;
    p.runningSince = null;

    await idb.put("progress", { ...rec, progress: p, updatedAt: now });
  }
}

/* ===========================
   PUZZLE OPEN/CLOSE
=========================== */

async function openPuzzle(psid, date) {
  const key = `${psid}|${date}`;

  let puzzleRec = await idb.get("puzzles", key);
  if (!puzzleRec) {
    puzzleRec = { key, psid, date, fetchedAt: 0, data: null };
    await idb.put("puzzles", puzzleRec);
  }

  if (!puzzleRec.data) {
    const url = `./puzzles/${psid}/${date}.json`;
    const data = await fetchJson(url, { cache: "no-store" });
    puzzleRec.data = data;
    puzzleRec.fetchedAt = Date.now();
    await idb.put("puzzles", puzzleRec);
  }

  const spec = parsePuzzle(puzzleRec.data);
  const saved = await idb.get("progress", key);
  const progress = saved?.progress || freshProgress(spec);

  progress.lastOpenedAt = Date.now();
  progress.runningSince = null;
  await writeProgress(key, spec, progress);

  current = { key, psid, date, spec, progress, selected: null };
  puzzleOpen = true;

  toggleChecksBtn.setAttribute("aria-pressed", String(!!progress.wordChecks));
  toggleChecksBtn.textContent = `Word checks: ${progress.wordChecks ? "On" : "Off"}`;

  correctWordIds = new Set();

  homeView.classList.add("hidden");
  puzzleView.classList.remove("hidden");

  renderGrid(spec, progress);
  showClue(null);
  computeCellSize(spec.rows, spec.cols);

  setTimeout(() => kbd.focus(), 50);

  await startTimerIfOpen(true);

  if (progress.wordChecks) {
    recomputeCorrectWords();
    paintGreenFromSet();
  } else {
    clearAllGreen();
  }
}

async function exitPuzzle() {
  puzzleOpen = false;
  await stopTimerAndSave();

  current = { key: null, psid: PSID_DEFAULT, date: null, spec: null, progress: null, selected: null };
  correctWordIds.clear();

  stopClockLoop();
  timerEl.textContent = "00:00";

  puzzleView.classList.add("hidden");
  homeView.classList.remove("hidden");

  try {
    await normalizeOrphanRunningTimers();
  } catch {}

  await renderHome();
  scheduleCloudSync();
}

async function restartPuzzle() {
  if (!current.spec) return;

  correctWordIds.clear();
  clearAllGreen();

  current.progress = freshProgress(current.spec);
  current.progress.lastOpenedAt = Date.now();
  current.selected = null;

  renderGrid(current.spec, current.progress);
  showClue(null);
  computeCellSize(current.spec.rows, current.spec.cols);

  await forceRestartTimer();
  await autosave(true);
}

/* ===========================
   TIMER
=========================== */

function getElapsedMs(progress) {
  const base = progress.elapsedMs || 0;
  return progress.runningSince ? base + (Date.now() - progress.runningSince) : base;
}

function paintTimer() {
  if (!current.progress) return;
  const ms = getElapsedMs(current.progress);
  const s = Math.floor(ms / 1000);
  if (s === lastPaintedSecond) return;
  lastPaintedSecond = s;
  timerEl.textContent = fmtTime(ms);
}

function startClockLoop() {
  if (clockActive) return;
  clockActive = true;
  lastPaintedSecond = null;

  const tick = () => {
    if (!clockActive) return;
    if (!puzzleOpen) return;
    paintTimer();
    clockRaf = requestAnimationFrame(tick);
  };
  clockRaf = requestAnimationFrame(tick);
}

function stopClockLoop() {
  clockActive = false;
  if (clockRaf) cancelAnimationFrame(clockRaf);
  clockRaf = null;
}

async function startTimerIfOpen(ensureVisible = false) {
  if (!puzzleOpen) return;
  if (!current.key || !current.progress) return;

  if (current.progress.completed) {
    stopClockLoop();
    paintTimer();
    return;
  }

  if (!current.progress.runningSince) current.progress.runningSince = Date.now();

  startClockLoop();
  if (ensureVisible) {
    lastPaintedSecond = null;
    paintTimer();
  }

  await autosave(true);
}

async function forceRestartTimer() {
  stopClockLoop();
  if (!current.progress) return;

  current.progress.elapsedMs = 0;
  current.progress.runningSince = Date.now();

  timerEl.textContent = "00:00";
  lastPaintedSecond = null;

  if (puzzleOpen) startClockLoop();
}

async function stopTimerAndSave() {
  stopClockLoop();
  if (!current.key || !current.progress) return;

  if (current.progress.runningSince) {
    const now = Date.now();
    current.progress.elapsedMs =
      (current.progress.elapsedMs || 0) + (now - current.progress.runningSince);
    current.progress.runningSince = null;
  }

  lastPaintedSecond = null;
  paintTimer();
  await autosave(true);
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/* ===========================
   PARSE + PROGRESS
=========================== */

function parsePuzzle(apiJson) {
  const metaData = apiJson?.cells?.[0]?.meta?.data;
  if (!metaData) throw new Error("Unexpected JSON: missing meta.data");

  const params = new URLSearchParams(metaData.startsWith("&") ? metaData.slice(1) : metaData);
  const rows = parseInt(params.get("num_rows") || "15", 10);
  const cols = parseInt(params.get("num_columns") || "15", 10);

  const wordsRaw = [];
  for (let i = 0; ; i++) {
    const w = params.get(`word${i}`);
    const clue = params.get(`clue${i}`);
    const dir = params.get(`dir${i}`);
    const r = params.get(`start_j${i}`);
    const c = params.get(`start_k${i}`);
    if (!w && !clue && !dir && r === null && c === null) break;
    if (!w || !dir || r === null || c === null) continue;
    wordsRaw.push({ idx: i, answer: w, clue: clue || "", dir, r: parseInt(r, 10), c: parseInt(c, 10) });
  }

  const solution = Array.from({ length: rows * cols }, () => null);
  const words = wordsRaw.map((entry) => {
    const dr = entry.dir === "d" ? 1 : 0;
    const dc = entry.dir === "a" ? 1 : 0;
    const cells = [];
    for (let k = 0; k < entry.answer.length; k++) {
      const rr = entry.r + dr * k;
      const cc = entry.c + dc * k;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const pos = rr * cols + cc;
      cells.push(pos);
      solution[pos] = entry.answer[k];
    }
    return { id: `${entry.dir}:${entry.idx}`, dir: entry.dir, clue: entry.clue, len: entry.answer.length, cells };
  });

  const isBlock = solution.map((ch) => ch === null);

  const cellToWords = Array.from({ length: rows * cols }, () => ({ a: [], d: [] }));
  for (const w of words) {
    for (const cell of w.cells) {
      if (w.dir === "a") cellToWords[cell].a.push(w.id);
      else cellToWords[cell].d.push(w.id);
    }
  }

  const wordMap = new Map(words.map((w) => [w.id, w]));
  return { rows, cols, solution, isBlock, words, wordMap, cellToWords };
}

function freshProgress(spec) {
  return {
    fills: Array.from({ length: spec.rows * spec.cols }, () => ""),
    elapsedMs: 0,
    runningSince: null,
    wordChecks: false,
    completed: false,
    completedAt: null,
    lastOpenedAt: 0,
  };
}

function snapshot(spec, progress) {
  let total = 0, filled = 0, correctFilled = 0;
  for (let i = 0; i < spec.solution.length; i++) {
    if (spec.isBlock[i]) continue;
    total++;
    const got = (progress.fills[i] || "").toUpperCase();
    if (got) {
      filled++;
      const want = (spec.solution[i] || "").toUpperCase();
      if (got === want) correctFilled++;
    }
  }
  const pct = total ? Math.round((filled / total) * 100) : 0;
  const allCorrect = filled === total && correctFilled === total;
  return { total, filled, pct, allCorrect };
}

async function writeProgress(key, spec, progress) {
  const snap = snapshot(spec, progress);
  await idb.put("progress", { key, updatedAt: Date.now(), progress, snap });
}

async function autosave(immediate = false) {
  if (!current.key || !current.spec || !current.progress) return;

  if (savePending) clearTimeout(savePending);
  const delay = immediate ? 0 : 120;

  savePending = setTimeout(async () => {
    savePending = null;
    await writeProgress(current.key, current.spec, current.progress);
    scheduleCloudSync();
  }, delay);
}

/* ===========================
   GRID RENDER + SIZING
=========================== */

function renderGrid(spec, progress) {
  gridEl.innerHTML = "";
  gridEl.style.gridTemplateColumns = `repeat(${spec.cols}, var(--cell))`;

  for (let i = 0; i < spec.rows * spec.cols; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.i = String(i);

    if (spec.isBlock[i]) {
      cell.classList.add("block");
      cell.textContent = "";
    } else {
      cell.textContent = (progress.fills[i] || "").toUpperCase();
      cell.addEventListener("click", () => onCellTap(i));
    }
    gridEl.appendChild(cell);
  }

  lastPaintedSecond = null;
  if (puzzleOpen) paintTimer();
}

function computeCellSize(rows, cols) {
  const topbarH = 42;
  const clueH = clueBar.classList.contains("hidden") ? 0 : 30;

  const vpW = Math.floor(window.innerWidth);
  const vpH = Math.floor(window.innerHeight);

  const availW = vpW - 10;
  const availH = vpH - topbarH - clueH - 10;

  const cell = Math.max(20, Math.floor(Math.min(availW / cols, availH / rows)));
  gridEl.style.setProperty("--cell", `${cell}px`);
}

/* ===========================
   SELECTION + CLUE
=========================== */

function onCellTap(cellIndex) {
  if (!current.spec || !current.progress) return;
  if (current.spec.isBlock[cellIndex]) return;

  const choices = getWordChoicesAtCell(cellIndex);

  let nextWordId = null;
  let nextDir = null;

  if (current.selected && current.selected.cellIndex === cellIndex && choices.length > 1) {
    const idx = choices.findIndex((c) => c.wordId === current.selected.wordId);
    const next = choices[(idx + 1) % choices.length];
    nextWordId = next.wordId;
    nextDir = next.dir;
  } else if (current.selected) {
    const keep = choices.find((c) => c.dir === current.selected.dir);
    if (keep) { nextWordId = keep.wordId; nextDir = keep.dir; }
  }

  if (!nextWordId) {
    const preferAcross = choices.find((c) => c.dir === "a") || choices[0];
    nextWordId = preferAcross.wordId;
    nextDir = preferAcross.dir;
  }

  setSelection({ cellIndex, wordId: nextWordId, dir: nextDir });
  kbd.focus();
}

function getWordChoicesAtCell(cellIndex) {
  const m = current.spec.cellToWords[cellIndex];
  const out = [];
  for (const id of m.a || []) out.push({ wordId: id, dir: "a" });
  for (const id of m.d || []) out.push({ wordId: id, dir: "d" });
  return out;
}

function setSelection(sel) {
  current.selected = sel;
  paintSelection();
  showCurrentClue();
}

function paintSelection() {
  for (const el of gridEl.children) el.classList.remove("selected", "word");

  if (!current.selected) return;

  const { cellIndex, wordId } = current.selected;

  const selEl = gridEl.querySelector(`[data-i="${cellIndex}"]`);
  if (selEl) selEl.classList.add("selected");

  if (wordId) {
    const w = current.spec.wordMap.get(wordId);
    if (w) {
      for (const c of w.cells) {
        const el = gridEl.querySelector(`[data-i="${c}"]`);
        if (el) el.classList.add("word");
      }
    }
  }
}

function showCurrentClue() {
  if (!current.selected?.wordId) { showClue(null); return; }
  const w = current.spec.wordMap.get(current.selected.wordId);
  if (!w) { showClue(null); return; }

  const hasLen = /\(\s*\d+\s*\)\s*$/.test((w.clue || "").trim());
  const text = hasLen ? `${w.clue}` : `${w.clue} (${w.len})`;
  showClue(text);
}

function showClue(text) {
  if (!text) {
    clueBar.classList.add("hidden");
    clueBar.textContent = "";
  } else {
    clueBar.classList.remove("hidden");
    clueBar.textContent = text;
  }
  if (current.spec) computeCellSize(current.spec.rows, current.spec.cols);
}

/* ===========================
   WORD CHECKS
=========================== */

function clearAllGreen() {
  for (const el of gridEl.children) el.classList.remove("wordOk");
}

function recomputeCorrectWords() {
  correctWordIds = new Set();
  for (const w of current.spec.words) {
    if (isWordFilledAndCorrect(w)) correctWordIds.add(w.id);
  }
}

function paintGreenFromSet() {
  clearAllGreen();
  if (!current.progress?.wordChecks) return;

  for (const id of correctWordIds) {
    const w = current.spec.wordMap.get(id);
    if (!w) continue;
    for (const c of w.cells) {
      const el = gridEl.querySelector(`[data-i="${c}"]`);
      if (el) el.classList.add("wordOk");
    }
  }
}

function isWordFilledAndCorrect(w) {
  for (const c of w.cells) {
    const got = (current.progress.fills[c] || "").toUpperCase();
    if (!got) return false;
  }
  for (const c of w.cells) {
    const got = (current.progress.fills[c] || "").toUpperCase();
    const want = (current.spec.solution[c] || "").toUpperCase();
    if (got !== want) return false;
  }
  return true;
}

function cellIsVerifiedCorrect(cellIndex) {
  const m = current.spec.cellToWords[cellIndex];
  const ids = [...(m.a || []), ...(m.d || [])];
  return ids.some((id) => correctWordIds.has(id));
}

/* ===========================
   KEYBOARD SHORTCUTS
=========================== */

function anySheetOpen() {
  return !!document.querySelector(".sheet:not(.hidden)");
}

function onGlobalKeyDown(e) {
  if (!puzzleOpen) return;

  if (e.key === "Escape") {
    e.preventDefault();
    if (anySheetOpen()) {
      for (const el of document.querySelectorAll(".sheet")) el.classList.add("hidden");
      document.body.classList.remove("modalOpen");
    } else {
      openSheet("mainMenu");
    }
    return;
  }

  if (anySheetOpen()) return;

  if (e.key === "Enter") {
    e.preventDefault();
    if (!current.selected) return;
    const idx = current.selected.cellIndex;
    const choices = getWordChoicesAtCell(idx);
    if (choices.length > 1) {
      const curId = current.selected.wordId;
      const next = choices.find((c) => c.wordId !== curId) || choices[0];
      setSelection({ cellIndex: idx, wordId: next.wordId, dir: next.dir });
    }
    return;
  }

  const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  if (!arrows.includes(e.key)) return;

  e.preventDefault();
  if (!current.selected) return;

  const { rows, cols, isBlock } = current.spec;
  let r = Math.floor(current.selected.cellIndex / cols);
  let c = current.selected.cellIndex % cols;

  let dr = 0, dc = 0;
  let wantDir = current.selected.dir;

  if (e.key === "ArrowLeft") { dc = -1; wantDir = "a"; }
  if (e.key === "ArrowRight") { dc = 1; wantDir = "a"; }
  if (e.key === "ArrowUp") { dr = -1; wantDir = "d"; }
  if (e.key === "ArrowDown") { dr = 1; wantDir = "d"; }

  let nr = r + dr, nc = c + dc;
  while (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
    const ni = nr * cols + nc;
    if (!isBlock[ni]) {
      const choices = getWordChoicesAtCell(ni);
      const keep = choices.find((ch) => ch.dir === wantDir) || choices[0];
      setSelection({ cellIndex: ni, wordId: keep.wordId, dir: keep.dir });
      return;
    }
    nr += dr; nc += dc;
  }
}

/* ===========================
   TYPING
=========================== */

async function onKeyDown(e) {
  if (!puzzleOpen) return;
  if (!current.spec || !current.progress || !current.selected) return;
  if (current.progress.completed) return;

  const { cellIndex, wordId } = current.selected;
  if (current.spec.isBlock[cellIndex]) return;

  const key = e.key;

  if (/^[a-zA-Z]$/.test(key)) {
    e.preventDefault();

    if (current.progress.wordChecks && cellIsVerifiedCorrect(cellIndex)) {
      advanceForward(wordId, cellIndex);
      return;
    }

    setCell(cellIndex, key.toUpperCase());
    await autosave();
    advanceForward(wordId, cellIndex);
    return;
  }

  if (key === "Backspace") {
    e.preventDefault();

    const filledHere = getCell(cellIndex);

    if (filledHere && current.progress.wordChecks && cellIsVerifiedCorrect(cellIndex)) {
      moveBackOneCell(wordId, cellIndex, { deletePrev: false });
      return;
    }

    if (filledHere) {
      setCell(cellIndex, "");
      await autosave();
      return;
    }

    moveBackOneCell(wordId, cellIndex, { deletePrev: true });
    return;
  }
}

function advanceForward(wordId, cellIndex) {
  if (!wordId) return;
  const w = current.spec.wordMap.get(wordId);
  const pos = w.cells.indexOf(cellIndex);

  if (pos >= 0 && pos < w.cells.length - 1) {
    setSelection({ cellIndex: w.cells[pos + 1], wordId, dir: w.dir });
  } else {
    const next = nextWordAfter(wordId) || firstWord();
    if (next) setSelection({ cellIndex: next.cells[0], wordId: next.id, dir: next.dir });
  }
}

function moveBackOneCell(wordId, cellIndex, opts = { deletePrev: true }) {
  if (!wordId) return;
  const w = current.spec.wordMap.get(wordId);
  const pos = w.cells.indexOf(cellIndex);
  if (pos <= 0) return;

  const prev = w.cells[pos - 1];
  setSelection({ cellIndex: prev, wordId, dir: w.dir });

  if (!opts.deletePrev) return;

  if (getCell(prev)) {
    if (current.progress.wordChecks && cellIsVerifiedCorrect(prev)) return;
    setCell(prev, "");
    autosave();
  }
}

function getCell(i) {
  return (current.progress.fills[i] || "").toUpperCase();
}

function setCell(i, v) {
  current.progress.fills[i] = v;
  const el = gridEl.querySelector(`[data-i="${i}"]`);
  if (el) el.textContent = v;

  if (current.progress.wordChecks) {
    recomputeCorrectWords();
    paintGreenFromSet();
  }
}

/* ===========================
   HINTS
=========================== */

async function hintRevealLetter() {
  if (!current.selected) return;
  const i = current.selected.cellIndex;
  if (current.spec.isBlock[i]) return;
  const want = (current.spec.solution[i] || "").toUpperCase();
  if (want) setCell(i, want);
  await autosave(true);
}

async function hintRevealWord() {
  const w = getSelectedWord();
  if (!w) return;
  for (const c of w.cells) {
    const want = (current.spec.solution[c] || "").toUpperCase();
    if (want) setCell(c, want);
  }
  await autosave(true);
}

async function hintCheckWord() {
  const w = getSelectedWord();
  if (!w) return;
  for (const c of w.cells) {
    const got = (current.progress.fills[c] || "").toUpperCase();
    if (!got) continue;
    const want = (current.spec.solution[c] || "").toUpperCase();
    if (got !== want) setCell(c, "");
  }
  await autosave(true);
}

async function hintCheckPuzzle() {
  for (let i = 0; i < current.spec.solution.length; i++) {
    if (current.spec.isBlock[i]) continue;
    const got = (current.progress.fills[i] || "").toUpperCase();
    if (!got) continue;
    const want = (current.spec.solution[i] || "").toUpperCase();
    if (got !== want) setCell(i, "");
  }

  const snap = snapshot(current.spec, current.progress);
  if (snap.allCorrect) {
    await completePuzzle();
    return;
  }
  await autosave(true);
}

function getSelectedWord() {
  const id = current.selected?.wordId;
  if (!id) return null;
  return current.spec.wordMap.get(id) || null;
}

async function completePuzzle() {
  await stopTimerAndSave();
  current.progress.completed = true;
  current.progress.completedAt = Date.now();
  await autosave(true);

  congratsBody.textContent = `Solved in ${fmtTime(current.progress.elapsedMs || 0)}`;
  openSheet("congrats");
}

/* ===========================
   WORD ORDER
=========================== */

function firstWord() { return current.spec?.words?.[0] || null; }
function nextWordAfter(wordId) {
  const idx = current.spec.words.findIndex((w) => w.id === wordId);
  if (idx < 0) return null;
  return current.spec.words[idx + 1] || null;
}

/* ===========================
   SHEETS
=========================== */

function openSheet(id) {
  document.body.classList.add("modalOpen");
  $(`#${id}`).classList.remove("hidden");
}

function closeSheet(id) {
  $(`#${id}`).classList.add("hidden");
  const anyOpen = document.querySelector(".sheet:not(.hidden)");
  if (!anyOpen) document.body.classList.remove("modalOpen");
}

/* ===========================
   UTIL
=========================== */

async function fetchJson(url, fetchOpts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...fetchOpts,
      signal: ctrl.signal,
      cache: fetchOpts.cache || "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
