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

const DRIVE_PROGRESS_FILENAME = "lovcryptics_progress_v1.json";

// < 10s should be treated as "Not started"
const STARTED_THRESHOLD_MS = 10_000;

const LS = {
  filter: "lovcrypticsFilter",
  sort: "lovcrypticsSort",
  themeBase: "lovcrypticsThemeBase",
  themeMode: "lovcrypticsThemeMode",
  lastUpdated: "lovcrypticsLastUpdated",
  autoLogin: "lovcrypticsGoogleAutoLogin",
  token: "lovcrypticsGoogleAccessToken",
  tokenExp: "lovcrypticsGoogleAccessTokenExp",
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
const gridShellEl = document.querySelector(".gridShell");
const clueBar = $("#clueBar");
const timerEl = $("#timer");
const kbd = $("#kbd");
const mobileKeyboardEl = $("#mobileKeyboard");

const hintBtn = $("#hintBtn");
const menuBtn = $("#menuBtn");

const homeMenu = $("#homeMenu");
const homeThemeBtn = $("#homeThemeBtn");
const loginBtn = $("#loginBtn");
const logoutBtn = $("#logoutBtn");
const accountLine = $("#accountLine");

const themeMenu = $("#themeMenu");
const themeModeToggle = $("#themeModeToggle");
const themeModeLabel = $("#themeModeLabel");

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
const puzzleThemeBtn = $("#puzzleThemeBtn");
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
let wordCheckPaintPending = false;

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
   WORD OUTLINE OVERLAYS
=========================== */

let wordOutlineEl = null;
let cellOutlineEl = null;
const useInAppKeyboard = window.matchMedia("(pointer: coarse), (hover: none)").matches;
let backspaceRepeatDelayTimer = null;
let backspaceRepeatInterval = null;

function stopBackspaceRepeat() {
  if (backspaceRepeatDelayTimer) {
    clearTimeout(backspaceRepeatDelayTimer);
    backspaceRepeatDelayTimer = null;
  }
  if (backspaceRepeatInterval) {
    clearInterval(backspaceRepeatInterval);
    backspaceRepeatInterval = null;
  }
}

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

  // Theme mode toggle
  themeModeToggle.addEventListener("change", () => {
    const mode = themeModeToggle.checked ? "dark" : "light";
    setThemeMode(mode);
  });

  // Puzzle controls
  hintBtn.addEventListener("click", () => openSheet("hintMenu"));
  menuBtn.addEventListener("click", () => openSheet("mainMenu"));

  // Themes inside puzzle menu
  if (puzzleThemeBtn) {
    puzzleThemeBtn.addEventListener("click", () => {
      closeSheet("mainMenu");
      openSheet("themeMenu");
    });
  }

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

    const themeBase = e.target?.getAttribute?.("data-theme-base");
    if (themeBase) {
      setThemeBase(themeBase);
      return;
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
      clearAllOk();
    } else {
      recomputeCorrectWords();
      paintOkFromSet();
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
  installNoZoomGuards();
  renderMobileKeyboard();

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
    paintSelection();
  });

  // Load index + render
  await refreshIndexAndCache({ quiet: false });
  await renderHome();
  scheduleIndexRefresh();

  // Google
  await initGoogleTokenClient();
  restoreTokenFromStorage();
  updateAccountUI();
  if (signedIn) pullProgressFromDrive().catch(() => {});

  homeStatusEl.textContent = "Loaded";
}

function renderMobileKeyboard() {
  if (!mobileKeyboardEl) return;

  if (!useInAppKeyboard) {
    mobileKeyboardEl.classList.add("hidden");
    return;
  }

  const rows = [
    {
      className: "mobileKeyboardRow mobileKeyboardRowTop",
      keys: [..."QWERTYUIOP"].map((key) => ({ label: key, key })),
    },
    {
      className: "mobileKeyboardRow mobileKeyboardRowHome",
      keys: [..."ASDFGHJKL"].map((key) => ({ label: key, key })),
    },
    {
      className: "mobileKeyboardRow mobileKeyboardRowBottom",
      keys: [
        { label: "", key: null, extraClass: "mobileKeySpacer" },
        ...[..."ZXCVBNM"].map((key) => ({ label: key, key })),
        { label: "⌫", key: "Backspace", extraClass: "mobileKeyWide mobileKeyIcon mobileKeyBackspace" },
      ],
    },
    {
      className: "mobileKeyboardRow mobileKeyboardRowSpace",
      keys: [
        { label: "", key: null, extraClass: "mobileKeySpacer" },
        { label: "SPACE", key: "Space", extraClass: "mobileKeySpace" },
        { label: "ENTER", key: "Enter", extraClass: "mobileKeyWide" },
      ],
    },
  ];

  mobileKeyboardEl.innerHTML = "";
  mobileKeyboardEl.classList.remove("hidden");

  for (const rowSpec of rows) {
    const row = document.createElement("div");
    row.className = rowSpec.className;

    for (const item of rowSpec.keys) {
      if (!item.key) {
        const spacer = document.createElement("div");
        spacer.className = item.extraClass || "";
        spacer.setAttribute("aria-hidden", "true");
        row.appendChild(spacer);
        continue;
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `mobileKey ${item.extraClass || ""}`.trim();
      btn.textContent = item.label;
      btn.setAttribute("aria-label", item.label);
      btn.tabIndex = -1;
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        btn.blur();

        if (item.key === "Backspace") {
          btn.setPointerCapture?.(e.pointerId);
          handlePuzzleKey(item.key);
          stopBackspaceRepeat();
          backspaceRepeatDelayTimer = setTimeout(() => {
            backspaceRepeatInterval = setInterval(() => {
              handlePuzzleKey(item.key);
            }, 72);
          }, 180);
          return;
        }

        handlePuzzleKey(item.key);
      });

      btn.addEventListener("contextmenu", (e) => e.preventDefault());
      btn.addEventListener("pointerup", stopBackspaceRepeat);
      btn.addEventListener("pointercancel", stopBackspaceRepeat);
      btn.addEventListener("pointerleave", stopBackspaceRepeat);
      row.appendChild(btn);
    }

    mobileKeyboardEl.appendChild(row);
  }
}

function installNoZoomGuards() {
  for (const eventName of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(eventName, (e) => {
      e.preventDefault();
    }, { passive: false });
  }

  window.addEventListener("wheel", (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "0"].includes(e.key)) {
      e.preventDefault();
    }
  });
}

/* ===========================
   SORT/FILTER LABELS
=========================== */

function sortLabel(mode) {
  if (mode === "oldest") return "Old → New";
  if (mode === "recent") return "Recent";
  return "New → Old";
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
   THEME
=========================== */

function applySavedTheme() {
  const base = localStorage.getItem(LS.themeBase) || "blackwhite";
  const mode = localStorage.getItem(LS.themeMode) || "light";
  setThemeBase(base);
  setThemeMode(mode);

  themeModeToggle.checked = mode === "dark";
  themeModeLabel.textContent = mode === "dark" ? "Dark" : "Light";
}

function setThemeBase(base) {
  document.body.setAttribute("data-theme-base", base);
  localStorage.setItem(LS.themeBase, base);
}

function setThemeMode(mode) {
  document.body.setAttribute("data-theme-mode", mode);
  localStorage.setItem(LS.themeMode, mode);
  themeModeToggle.checked = mode === "dark";
  themeModeLabel.textContent = mode === "dark" ? "Dark" : "Light";
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
      if (window.__lovcryptics_reloaded) return;
      window.__lovcryptics_reloaded = true;
      window.location.reload();
    });
  } catch (e) {
    console.error(e);
  }
}

/* ===========================
   GOOGLE LOGIN + TOKEN STORE
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
    callback: () => {},
  });
}

function storeToken(token, expiresInSeconds) {
  accessToken = token;
  signedIn = true;

  const ttlMs = (Number(expiresInSeconds) || 3000) * 1000;
  const exp = Date.now() + ttlMs - 20_000;

  localStorage.setItem(LS.token, token);
  localStorage.setItem(LS.tokenExp, String(exp));
  localStorage.setItem(LS.autoLogin, "1");
}

function clearStoredToken() {
  localStorage.removeItem(LS.token);
  localStorage.removeItem(LS.tokenExp);
}

function restoreTokenFromStorage() {
  const tok = localStorage.getItem(LS.token);
  const expRaw = localStorage.getItem(LS.tokenExp);
  const exp = expRaw ? Number(expRaw) : 0;
  if (tok && exp && Date.now() < exp) {
    accessToken = tok;
    signedIn = true;
    return true;
  }
  accessToken = null;
  signedIn = false;
  return false;
}

async function loginGoogle(interactive) {
  if (!tokenClient) await initGoogleTokenClient();
  if (!tokenClient) {
    alert("Google login not ready yet. Please refresh and try again.");
    return;
  }

  return new Promise((resolve) => {
    tokenClient.callback = (resp) => {
      if (resp?.access_token) {
        storeToken(resp.access_token, resp.expires_in);
        driveFileId = null;
        updateAccountUI();
        pullProgressFromDrive().catch(() => {});
      }
      resolve();
    };
    tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
  });
}

function logoutGoogle() {
  accessToken = null;
  signedIn = false;
  driveFileId = null;
  localStorage.removeItem(LS.autoLogin);
  clearStoredToken();
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

async function ensureValidTokenOrThrow() {
  if (restoreTokenFromStorage()) return;
  if (localStorage.getItem(LS.autoLogin) !== "1") throw new Error("Not signed in");
  await loginGoogle(false);
  if (!signedIn || !accessToken) throw new Error("Not signed in");
}

/* ===========================
   DRIVE APPDATA PROGRESS
=========================== */

async function driveRequest(url, opts = {}, retry = true) {
  await ensureValidTokenOrThrow();

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

    if ((res.status === 401 || res.status === 403) && retry) {
      clearStoredToken();
      accessToken = null;
      signedIn = false;
      updateAccountUI();
      await ensureValidTokenOrThrow();
      return driveRequest(url, opts, false);
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
  if (!signedIn) return;
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

    for (const d of dates) {
      const key = `${psid}|${d}`;
      if (existingKeys.has(key)) continue;
      await idb.put("puzzles", { key, psid, date: d, fetchedAt: 0, data: null });
    }

    localStorage.setItem(LS.lastUpdated, new Date().toLocaleString());
    applyLastUpdatedLabel();
    if (!quiet) homeStatusEl.textContent = "Loaded";
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

    const startedByTime = timeMs >= STARTED_THRESHOLD_MS;
    const isNotStarted = !startedByTime;

    if (filterMode === "incomplete" && !(startedByTime && !isCompleted)) continue;
    if (filterMode === "completed" && !isCompleted) continue;
    if (filterMode === "not_started" && !isNotStarted) continue;

    let subtitle = "";
    if (isCompleted) subtitle = `Completed • ${fmtTime(timeMs)}`;
    else if (isNotStarted) subtitle = "Not started";
    else subtitle = `In progress • ${fmtTime(timeMs)}`;

    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");

    card.innerHTML = `<div>
        <div><b>${escapeHtml(p.date)}</b></div>
        <small>${escapeHtml(subtitle)}</small>
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

  homeView.classList.add("hidden");
  puzzleView.classList.remove("hidden");

  renderGrid(spec, progress);
  showClue(null);
  computeCellSize(spec.rows, spec.cols);

  toggleChecksBtn.setAttribute("aria-pressed", String(!!progress.wordChecks));
  toggleChecksBtn.textContent = `Word checks: ${progress.wordChecks ? "On" : "Off"}`;

  correctWordIds = new Set();
  if (progress.wordChecks) {
    recomputeCorrectWords();
    paintOkFromSet();
  } else {
    clearAllOk();
  }

  if (!useInAppKeyboard) setTimeout(() => kbd.focus(), 50);

  await startTimerIfOpen(true);
}

async function exitPuzzle() {
  puzzleOpen = false;
  await stopTimerAndSave();

  current = { key: null, psid: PSID_DEFAULT, date: null, spec: null, progress: null, selected: null };
  correctWordIds.clear();

  stopClockLoop();
  timerEl.textContent = "00:00";

  hideOutlines();

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
  clearAllOk();

  current.progress = freshProgress(current.spec);
  current.progress.lastOpenedAt = Date.now();
  current.selected = null;

  renderGrid(current.spec, current.progress);
  showClue(null);
  computeCellSize(current.spec.rows, current.spec.cols);

  hideOutlines();

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
    current.progress.elapsedMs = (current.progress.elapsedMs || 0) + (now - current.progress.runningSince);
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
   GRID + SELECTION OVERLAYS
=========================== */

function renderGrid(spec, progress) {
  gridEl.innerHTML = "";
  gridEl.style.gridTemplateColumns = `repeat(${spec.cols}, var(--cell))`;
  gridEl.style.position = "relative";

  for (let i = 0; i < spec.rows * spec.cols; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.i = String(i);

    if (spec.isBlock[i]) {
      cell.classList.add("block");
      cell.textContent = "";
      cell.addEventListener("click", () => setSelection(null));
    } else {
      cell.textContent = (progress.fills[i] || "").toUpperCase();
      cell.addEventListener("click", () => onCellTap(i));
    }
    gridEl.appendChild(cell);
  }

  // overlays are destroyed by innerHTML reset; recreate
  wordOutlineEl = null;
  cellOutlineEl = null;
  ensureOutlineEls();
  hideOutlines();

  lastPaintedSecond = null;
  if (puzzleOpen) paintTimer();
}

function ensureOutlineEls() {
  if (wordOutlineEl && cellOutlineEl) return;

  wordOutlineEl = document.createElement("div");
  wordOutlineEl.className = "wordOutline";
  wordOutlineEl.setAttribute("aria-hidden", "true");

  cellOutlineEl = document.createElement("div");
  cellOutlineEl.className = "cellOutline";
  cellOutlineEl.setAttribute("aria-hidden", "true");

  gridEl.appendChild(wordOutlineEl);
  gridEl.appendChild(cellOutlineEl);
}

function hideOutlines() {
  if (wordOutlineEl) wordOutlineEl.style.display = "none";
  if (cellOutlineEl) cellOutlineEl.style.display = "none";
}

function getWordChoicesAtCell(cellIndex) {
  const m = current.spec.cellToWords[cellIndex];
  const out = [];
  for (const id of m.a || []) out.push({ wordId: id, dir: "a" });
  for (const id of m.d || []) out.push({ wordId: id, dir: "d" });
  return out;
}

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
  if (!useInAppKeyboard) kbd.focus();
}

function setSelection(sel) {
  current.selected = sel;
  paintSelection();
  showCurrentClue();
}

function paintSelection() {
  for (const el of gridEl.querySelectorAll(".cell.selected")) el.classList.remove("selected");

  if (!current.selected || !current.spec) {
    hideOutlines();
    return;
  }
  ensureOutlineEls();

  const { cellIndex, wordId } = current.selected;
  const selCellEl = gridEl.querySelector(`.cell[data-i="${cellIndex}"]`);
  if (selCellEl) selCellEl.classList.add("selected");

  const w = wordId ? current.spec.wordMap.get(wordId) : null;
  if (!w || !w.cells?.length || !selCellEl) {
    hideOutlines();
    return;
  }

  const gridRect = gridEl.getBoundingClientRect();

  let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
  for (const c of w.cells) {
    const el = gridEl.querySelector(`.cell[data-i="${c}"]`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    minL = Math.min(minL, r.left);
    minT = Math.min(minT, r.top);
    maxR = Math.max(maxR, r.right);
    maxB = Math.max(maxB, r.bottom);
  }
  if (!isFinite(minL)) {
    hideOutlines();
    return;
  }

  const selRect = selCellEl.getBoundingClientRect();
  const pad = 1; // <<< smaller than before (was 2)

  wordOutlineEl.style.display = "block";
  wordOutlineEl.style.left = `${Math.round(minL - gridRect.left - pad)}px`;
  wordOutlineEl.style.top = `${Math.round(minT - gridRect.top - pad)}px`;
  wordOutlineEl.style.width = `${Math.round((maxR - minL) + pad * 2)}px`;
  wordOutlineEl.style.height = `${Math.round((maxB - minT) + pad * 2)}px`;

  cellOutlineEl.style.display = "block";
  cellOutlineEl.style.left = `${Math.round(selRect.left - gridRect.left)}px`;
  cellOutlineEl.style.top = `${Math.round(selRect.top - gridRect.top)}px`;
  cellOutlineEl.style.width = `${Math.round(selRect.width)}px`;
  cellOutlineEl.style.height = `${Math.round(selRect.height)}px`;
}

/* ===========================
   CLUE BAR + CELL SIZE
=========================== */

function showCurrentClue() {
  if (!current.selected?.wordId) { showClue(null); return; }
  const w = current.spec.wordMap.get(current.selected.wordId);
  if (!w) { showClue(null); return; }

  const hasLen = /\(\s*\d+\s*\)\s*$/.test((w.clue || "").trim());
  const text = hasLen ? `${w.clue}` : `${w.clue} (${w.len})`;
  showClue(text);
}

function showClue(text) {
  clueBar.textContent = text || "";
  if (current.spec) computeCellSize(current.spec.rows, current.spec.cols);
}

function getClueBottomBoundary() {
  return clueBar.getBoundingClientRect().bottom;
}

function getKeyboardTopBoundary() {
  if (!mobileKeyboardEl || mobileKeyboardEl.classList.contains("hidden")) {
    return window.innerHeight;
  }

  const kbStyle = window.getComputedStyle(mobileKeyboardEl);
  if (kbStyle.display === "none" || kbStyle.visibility === "hidden") {
    return window.innerHeight;
  }

  const topRow = mobileKeyboardEl.querySelector(".mobileKeyboardRowTop");
  if (topRow) {
    const rowRect = topRow.getBoundingClientRect();
    return rowRect.top;
  }

  return mobileKeyboardEl.getBoundingClientRect().top;
}

function positionGridAtPlayableCenter() {
  if (!puzzleOpen || !gridEl || !clueBar) return;

  // Reset before measuring so offsets don't compound.
  gridEl.style.transform = "translateY(0px)";

  const clueBottom = getClueBottomBoundary();
  const keyboardTop = getKeyboardTopBoundary();

  const gridRect = gridEl.getBoundingClientRect();
  if (!gridRect.height) return;

  const targetCenterY = (clueBottom + keyboardTop) / 2;
  const gridCenterY = gridRect.top + (gridRect.height / 2);
  const dy = Math.round(targetCenterY - gridCenterY);

  gridEl.style.transform = `translateY(${dy}px)`;
  paintSelection();
}

function computeCellSize(rows, cols) {
  if (!gridShellEl) return;
  const rect = gridShellEl.getBoundingClientRect();
  const availW = Math.max(0, Math.floor(rect.width) - 8);
  const availH = Math.max(0, Math.floor(rect.height) - 8);

  const cell = Math.max(20, Math.floor(Math.min(availW / cols, availH / rows)));
  gridEl.style.setProperty("--cell", `${cell}px`);
  requestAnimationFrame(positionGridAtPlayableCenter);
}

/* ===========================
   WORD CHECKS
=========================== */

function clearAllOk() {
  for (const el of gridEl.querySelectorAll(".cell.wordOk")) el.classList.remove("wordOk");
}

function scheduleWordCheckPaint() {
  if (wordCheckPaintPending) return;
  wordCheckPaintPending = true;

  requestAnimationFrame(() => {
    wordCheckPaintPending = false;
    if (!current.progress?.wordChecks) {
      clearAllOk();
      return;
    }
    recomputeCorrectWords();
    paintOkFromSet();
  });
}

function recomputeCorrectWords() {
  correctWordIds = new Set();
  for (const w of current.spec.words) {
    if (isWordFilledAndCorrect(w)) correctWordIds.add(w.id);
  }
}

function paintOkFromSet() {
  clearAllOk();
  if (!current.progress?.wordChecks) return;

  for (const id of correctWordIds) {
    const w = current.spec.wordMap.get(id);
    if (!w) continue;
    for (const c of w.cells) {
      const el = gridEl.querySelector(`.cell[data-i="${c}"]`);
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
   TYPING
=========================== */

function onKeyDown(e) {
  if (!puzzleOpen) return;
  const handled = handlePuzzleKey(e.key);
  if (handled) e.preventDefault();
}

function handlePuzzleKey(key) {
  if (!puzzleOpen) return false;
  if (!current.spec || !current.progress) return false;
  if (current.progress.completed) return false;

  if (key === " " || key === "Space" || key === "Spacebar") {
    return toggleSelectedDirection();
  }

  if (key === "Enter") {
    return selectNextWord();
  }

  if (!current.selected) return false;

  const { cellIndex, wordId } = current.selected;
  if (current.spec.isBlock[cellIndex]) return false;

  if (/^[a-zA-Z]$/.test(key)) {
    if (current.progress.wordChecks && cellIsVerifiedCorrect(cellIndex)) {
      advanceForward(wordId, cellIndex);
      return true;
    }
    setCell(cellIndex, key.toUpperCase());
    autosave();
    advanceForward(wordId, cellIndex);
    return true;
  }

  if (key === "Backspace") {
    const filledHere = getCell(cellIndex);

    if (filledHere && current.progress.wordChecks && cellIsVerifiedCorrect(cellIndex)) {
      moveBackOneCell(wordId, cellIndex, { deletePrev: false });
      return true;
    }

    if (filledHere) {
      setCell(cellIndex, "");
      autosave();
      return true;
    }

    moveBackOneCell(wordId, cellIndex, { deletePrev: true });
    return true;
  }

  return false;
}

function toggleSelectedDirection() {
  if (!current.selected) return false;
  const idx = current.selected.cellIndex;
  const choices = getWordChoicesAtCell(idx);
  if (choices.length <= 1) return true;

  const curId = current.selected.wordId;
  const next = choices.find((c) => c.wordId !== curId) || choices[0];
  setSelection({ cellIndex: idx, wordId: next.wordId, dir: next.dir });
  return true;
}

function selectNextWord() {
  if (!current.spec?.words?.length) return false;

  const next = current.selected?.wordId
    ? (nextWordAfter(current.selected.wordId) || firstWord())
    : firstWord();

  if (!next) return false;
  setSelection({ cellIndex: next.cells[0], wordId: next.id, dir: next.dir });
  return true;
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
  const el = gridEl.querySelector(`.cell[data-i="${i}"]`);
  if (el) el.textContent = v;

  if (current.progress.wordChecks) {
    scheduleWordCheckPaint();
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
  if (snap.allCorrect) await completePuzzle();
  else await autosave(true);
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

function anySheetOpen() {
  return !!document.querySelector(".sheet:not(.hidden)");
}

/* ===========================
   GLOBAL KEYS (RESTORED)
=========================== */

function onGlobalKeyDown(e) {
  if (!puzzleOpen) return;

  // Esc: open/close menu popup
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

  // If any sheet open, ignore
  if (anySheetOpen()) return;

  // Enter toggles across/down at intersections
  if (e.key === "Enter") {
    e.preventDefault();
    toggleSelectedDirection();
    return;
  }

  const arrows = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  if (!arrows.includes(e.key)) return;

  e.preventDefault();
  if (!current.selected || !current.spec) return;

  const { rows, cols, isBlock } = current.spec;
  let r = Math.floor(current.selected.cellIndex / cols);
  let c = current.selected.cellIndex % cols;

  let dr = 0, dc = 0;
  let wantDir = current.selected.dir;

  if (e.key === "ArrowLeft")  { dc = -1; wantDir = "a"; }
  if (e.key === "ArrowRight") { dc =  1; wantDir = "a"; }
  if (e.key === "ArrowUp")    { dr = -1; wantDir = "d"; }
  if (e.key === "ArrowDown")  { dr =  1; wantDir = "d"; }

  // step to next non-block cell
  let nr = r + dr, nc = c + dc;
  while (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
    const ni = nr * cols + nc;
    if (!isBlock[ni]) {
      const choices = getWordChoicesAtCell(ni);
      const keep = choices.find((ch) => ch.dir === wantDir) || choices[0];
      setSelection({ cellIndex: ni, wordId: keep.wordId, dir: keep.dir });
      return;
    }
    nr += dr;
    nc += dc;
  }
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
