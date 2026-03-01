import * as idb from "./idb.js";

const API_BASE = "";         // set to your proxy if needed
const PSID_DEFAULT = "100000160";
const FETCH_TIMEOUT_MS = 8000;

const $ = (s) => document.querySelector(s);

const homeView = $("#homeView");
const puzzleView = $("#puzzleView");

const archiveEl = $("#archive");
const homeStatusEl = $("#homeStatus");

const sortBtn = $("#sortBtn");
const filterBtn = $("#filterBtn");
const themeBtn = $("#themeBtn");

const gridEl = $("#grid");
const clueBar = $("#clueBar");
const timerEl = $("#timer");
const kbd = $("#kbd");

const hintBtn = $("#hintBtn");
const menuBtn = $("#menuBtn");

const hintMenu = $("#hintMenu");
const mainMenu = $("#mainMenu");
const restartConfirm = $("#restartConfirm");
const sortMenu = $("#sortMenu");
const filterMenu = $("#filterMenu");
const themeMenu = $("#themeMenu");
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

let filterMode = "all";   // all | incomplete | completed | not_started
let sortMode = "newest";  // recent | newest | oldest

let current = {
  key: null,
  psid: PSID_DEFAULT,
  date: null,
  spec: null,
  progress: null,
  selected: null
};

let savePending = null;
let timerTick = null;

// word-check persistence
let correctWordIds = new Set();

// sync control
let syncInFlight = false;

init();

async function init() {
  applySavedTheme();
  applyLastUpdatedLabel();

  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./sw.js"); } catch {}
  }

  sortBtn.addEventListener("click", () => openSheet("sortMenu"));
  filterBtn.addEventListener("click", () => openSheet("filterMenu"));
  themeBtn.addEventListener("click", () => openSheet("themeMenu"));

  hintBtn.addEventListener("click", () => openSheet("hintMenu"));
  menuBtn.addEventListener("click", () => openSheet("mainMenu"));

  homeStatusEl.addEventListener("click", () => {
    if (homeStatusEl.dataset.retry === "1") {
      homeStatusEl.dataset.retry = "0";
      homeStatusEl.textContent = "Syncing…";
      kickSync();
    }
  });

  document.body.addEventListener("click", async (e) => {
    const closeId = e.target?.getAttribute?.("data-close");
    if (closeId) closeSheet(closeId);

    if (e.target === hintMenu) closeSheet("hintMenu");
    if (e.target === mainMenu) closeSheet("mainMenu");
    if (e.target === restartConfirm) closeSheet("restartConfirm");
    if (e.target === sortMenu) closeSheet("sortMenu");
    if (e.target === filterMenu) closeSheet("filterMenu");
    if (e.target === themeMenu) closeSheet("themeMenu");
    if (e.target === congrats) return;

    const s = e.target?.getAttribute?.("data-sort");
    if (s) {
      sortMode = s;
      closeSheet("sortMenu");
      await renderHome();
    }

    const f = e.target?.getAttribute?.("data-filter");
    if (f) {
      filterMode = f;
      closeSheet("filterMenu");
      await renderHome();
    }

    const t = e.target?.getAttribute?.("data-theme");
    if (t) {
      setTheme(t);
      closeSheet("themeMenu");
    }
  });

  revealLetterBtn.addEventListener("click", async () => { closeSheet("hintMenu"); await hintRevealLetter(); });
  revealWordBtn.addEventListener("click", async () => { closeSheet("hintMenu"); await hintRevealWord(); });
  checkWordBtn.addEventListener("click", async () => { closeSheet("hintMenu"); await hintCheckWord(); });
  checkPuzzleBtn.addEventListener("click", async () => { closeSheet("hintMenu"); await hintCheckPuzzle(); });

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

  saveExitBtn.addEventListener("click", async () => { closeSheet("mainMenu"); await exitPuzzle(); });

  restartBtn.addEventListener("click", () => { closeSheet("mainMenu"); openSheet("restartConfirm"); });
  restartYesBtn.addEventListener("click", async () => { closeSheet("restartConfirm"); await restartPuzzle(); });

  congratsExitBtn.addEventListener("click", async () => {
    closeSheet("congrats");
    await exitPuzzle();
  });

  kbd.addEventListener("keydown", onKeyDown);

  document.addEventListener("visibilitychange", async () => {
    if (!current.key) return;
    if (document.hidden) await stopTimerAndSave();
    else await startTimerIfOpen();
  });

  // when coming back from app switcher / bfcache
  window.addEventListener("pageshow", async () => {
    if (!current.key) return;
    await startTimerIfOpen();
  });

  window.addEventListener("resize", () => {
    if (current.spec) computeCellSize(current.spec.rows, current.spec.cols);
  });

  await renderHome();
  kickSync(); // non-blocking
}

/* ---------- theme ---------- */

function applySavedTheme() {
  const t = localStorage.getItem("lovcrypticTheme") || "light";
  setTheme(t, { silent: true });
}
function setTheme(theme, opts = {}) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("lovcrypticTheme", theme);
  if (!opts.silent && current.spec) computeCellSize(current.spec.rows, current.spec.cols);
}

/* ---------- last updated label ---------- */

function applyLastUpdatedLabel() {
  const s = localStorage.getItem("lovcrypticLastUpdated");
  if (s) homeStatusEl.textContent = `Updated ${s}`;
}

function setLastUpdatedNow() {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  localStorage.setItem("lovcrypticLastUpdated", stamp);
  homeStatusEl.textContent = `Updated ${stamp}`;
}

/* ---------- home render (cards are buttons, sorting added) ---------- */

async function renderHome() {
  const puzzles = await idb.getAll("puzzles");
  const progress = await idb.getAll("progress");
  const progMap = new Map(progress.map((p) => [p.key, p]));

  // decorate with sort keys
  const items = puzzles.map(p => {
    const pr = progMap.get(p.key);
    const snap = pr?.snap || { pct: 0, filled: 0 };
    const isCompleted = !!pr?.progress?.completed;
    const elapsedMs = pr?.progress?.elapsedMs || 0;
    const runningSince = pr?.progress?.runningSince || null;
    const timeMs = elapsedMs + (runningSince ? (Date.now() - runningSince) : 0);
    const lastOpenedAt = pr?.progress?.lastOpenedAt || 0;

    return { p, pr, snap, isCompleted, timeMs, lastOpenedAt };
  });

  // sort
  if (sortMode === "recent") {
    items.sort((a,b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0) || (b.p.date < a.p.date ? -1 : 1));
  } else if (sortMode === "oldest") {
    items.sort((a,b) => (a.p.date < b.p.date ? -1 : 1));
  } else {
    // newest
    items.sort((a,b) => (a.p.date < b.p.date ? 1 : -1));
  }

  archiveEl.innerHTML = "";
  let shown = 0;

  for (const it of items) {
    const { p, pr, snap, isCompleted, timeMs } = it;

    const startedByTime = timeMs > 0;
    const isNotStarted = !startedByTime;

    // filter (exact)
    if (filterMode === "incomplete" && !(startedByTime && !isCompleted)) continue;
    if (filterMode === "completed" && !isCompleted) continue;
    if (filterMode === "not_started" && !isNotStarted) continue;

    const status = isCompleted ? "Completed" : (isNotStarted ? "Not started" : "In progress");
    const timeLabel = isNotStarted ? "Not started" : fmtTime(timeMs);

    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");

    card.innerHTML =
      `<div>
         <div><b>${escapeHtml(p.date)}</b></div>
         <small>${status} • ${timeLabel}</small>
       </div>
       <div class="pct"><b>${snap.pct ?? 0}%</b></div>`;

    const open = async () => { await openPuzzle(p.psid, p.date); };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });

    archiveEl.appendChild(card);
    shown++;
  }

  if (!puzzles.length) {
    archiveEl.innerHTML = `<div class="muted">No cached puzzles yet. Sync will populate automatically.</div>`;
  } else if (!shown) {
    archiveEl.innerHTML = `<div class="muted">No puzzles match this filter.</div>`;
  }
}

/* ---------- sync ---------- */

function kickSync() {
  if (syncInFlight) return;
  syncInFlight = true;

  homeStatusEl.textContent = "Syncing…";
  homeStatusEl.dataset.retry = "0";

  autoSync()
    .then(async () => {
      setLastUpdatedNow();
      await renderHome();
    })
    .catch(async () => {
      homeStatusEl.textContent = "Sync failed — tap to retry";
      homeStatusEl.dataset.retry = "1";
      await renderHome();
    })
    .finally(() => { syncInFlight = false; });
}

async function autoSync() {
  const psid = PSID_DEFAULT;
  const puzzles = await idb.getAll("puzzles");
  let dates = puzzles.filter(p => p.psid === psid).map(p => p.date).sort();

  const today = isoDate(new Date());
  const newest = dates.length ? dates[dates.length - 1] : null;
  const oldest = dates.length ? dates[0] : null;

  if (!newest) {
    await tryCache(psid, today);
    dates = [today];
  }

  const forwardCap = 10;
  let cursor = addDays(newest || today, 1);
  for (let i = 0; cursor <= today && i < forwardCap; i++) {
    await tryCache(psid, cursor);
    cursor = addDays(cursor, 1);
  }

  const state = loadSyncState();
  let backCursor = state.backCursor || addDays(oldest || today, -1);
  let failStreak = state.failStreak || 0;

  const backwardCap = 10;
  for (let i = 0; i < backwardCap; i++) {
    if (failStreak >= 21) break;
    const ok = await tryCache(psid, backCursor);
    failStreak = ok ? 0 : (failStreak + 1);
    backCursor = addDays(backCursor, -1);
  }

  saveSyncState({ backCursor, failStreak });
}

function loadSyncState() {
  try { return JSON.parse(localStorage.getItem("lovcrypticSyncState") || "{}"); }
  catch { return {}; }
}
function saveSyncState(s) {
  localStorage.setItem("lovcrypticSyncState", JSON.stringify(s));
}

async function tryCache(psid, date) {
  const key = `${psid}|${date}`;
  const existing = await idb.get("puzzles", key);
  if (existing) return true;

  try {
    const url = `https://data.puzzlexperts.com/puzzleapp-v3/data.php?psid=${encodeURIComponent(psid)}&date=${encodeURIComponent(date)}`;
    const data = await fetchJson(url);
    if (!data?.cells?.[0]?.meta?.data) return false;

    await idb.put("puzzles", { key, psid, date, fetchedAt: Date.now(), data });

    const spec = parsePuzzle(data);
    const progress = freshProgress(spec);
    await writeProgress(key, spec, progress);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url) {
  const fetchUrl = API_BASE ? `${API_BASE}${encodeURIComponent(url)}` : url;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(fetchUrl, { cache: "no-store", signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const txt = await resp.text();
    return JSON.parse(txt);
  } finally {
    clearTimeout(t);
  }
}

/* ---------- puzzle open/close ---------- */

async function openPuzzle(psid, date) {
  const key = `${psid}|${date}`;

  let puzzleRec = await idb.get("puzzles", key);
  if (!puzzleRec) {
    const ok = await tryCache(psid, date);
    if (!ok) return;
    puzzleRec = await idb.get("puzzles", key);
  }

  const spec = parsePuzzle(puzzleRec.data);
  const saved = await idb.get("progress", key);
  const progress = saved?.progress || freshProgress(spec);

  // mark opened
  progress.lastOpenedAt = Date.now();
  await idb.put("progress", { key, updatedAt: Date.now(), progress, snap: snapshot(spec, progress) });

  current = { key, psid, date, spec, progress, selected: null };

  toggleChecksBtn.setAttribute("aria-pressed", String(!!progress.wordChecks));
  toggleChecksBtn.textContent = `Word checks: ${progress.wordChecks ? "On" : "Off"}`;

  correctWordIds = new Set();

  homeView.classList.add("hidden");
  puzzleView.classList.remove("hidden");

  renderGrid(spec, progress);
  showClue(null);
  computeCellSize(spec.rows, spec.cols);

  setTimeout(() => kbd.focus(), 50);

  await startTimerIfOpen();

  if (current.progress.wordChecks) {
    recomputeCorrectWords();
    paintGreenFromSet();
  } else {
    clearAllGreen();
  }
}

async function exitPuzzle() {
  await stopTimerAndSave();

  current = { key:null, psid:PSID_DEFAULT, date:null, spec:null, progress:null, selected:null };
  correctWordIds.clear();

  puzzleView.classList.add("hidden");
  homeView.classList.remove("hidden");

  await renderHome();
}

async function restartPuzzle() {
  if (!current.spec) return;

  correctWordIds.clear();
  current.progress = freshProgress(current.spec);
  current.progress.lastOpenedAt = Date.now(); // counts as “recent”
  current.selected = null;

  renderGrid(current.spec, current.progress);
  showClue(null);
  computeCellSize(current.spec.rows, current.spec.cols);

  // timer: start immediately and make sure ticker is alive
  await startTimerForceRestart();
  await autosave(true);

  if (current.progress.wordChecks) {
    recomputeCorrectWords();
    paintGreenFromSet();
  } else {
    clearAllGreen();
  }
}

/* ---------- timer (robust) ---------- */

function ensureTimerTicker() {
  if (timerTick) return;
  timerTick = setInterval(() => {
    if (!current.progress) return;
    timerEl.textContent = fmtTime(getElapsedMs(current.progress));
  }, 250);
}

function stopTicker() {
  if (timerTick) { clearInterval(timerTick); timerTick = null; }
}

async function startTimerIfOpen() {
  if (!current.key || !current.progress) return;
  if (current.progress.completed) {
    stopTicker();
    timerEl.textContent = fmtTime(getElapsedMs(current.progress));
    return;
  }
  if (!current.progress.runningSince) {
    current.progress.runningSince = Date.now();
  }
  ensureTimerTicker();
  timerEl.textContent = fmtTime(getElapsedMs(current.progress));
  await autosave(true);
}

async function startTimerForceRestart() {
  stopTicker();
  current.progress.elapsedMs = 0;
  current.progress.runningSince = Date.now();
  ensureTimerTicker();
  timerEl.textContent = "00:00";
}

async function stopTimerAndSave() {
  if (!current.key || !current.progress) return;

  stopTicker();

  if (current.progress.runningSince) {
    const now = Date.now();
    current.progress.elapsedMs = (current.progress.elapsedMs || 0) + (now - current.progress.runningSince);
    current.progress.runningSince = null;
  }

  timerEl.textContent = fmtTime(getElapsedMs(current.progress));
  await autosave(true);
}

function getElapsedMs(progress) {
  const base = progress.elapsedMs || 0;
  return progress.runningSince ? base + (Date.now() - progress.runningSince) : base;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/* ---------- parse + persistence ---------- */

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
    wordsRaw.push({ idx:i, answer:w, clue: clue || "", dir, r:parseInt(r,10), c:parseInt(c,10) });
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
  const wordMap = new Map(words.map(w => [w.id, w]));
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
    lastOpenedAt: 0
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
  const allCorrect = (filled === total) && (correctFilled === total);
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
  }, delay);
}

/* ---------- grid render + sizing ---------- */

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

  timerEl.textContent = fmtTime(getElapsedMs(progress));
}

function computeCellSize(rows, cols) {
  // match CSS tighter bars
  const topbarH = 46;
  const clueH = clueBar.classList.contains("hidden") ? 0 : 34;

  const vpW = Math.floor(window.innerWidth);
  const vpH = Math.floor(window.innerHeight);

  const availW = vpW - 12; // slightly tighter
  const availH = vpH - topbarH - clueH - 12;

  const cell = Math.max(20, Math.floor(Math.min(availW / cols, availH / rows)));
  gridEl.style.setProperty("--cell", `${cell}px`);
}

/* ---------- selection + clue ---------- */

function onCellTap(cellIndex) {
  if (!current.spec || !current.progress) return;
  if (current.spec.isBlock[cellIndex]) return;

  const choices = getWordChoicesAtCell(cellIndex);

  let nextWordId = null;
  let nextDir = null;

  if (current.selected && current.selected.cellIndex === cellIndex && choices.length > 1) {
    const idx = choices.findIndex(c => c.wordId === current.selected.wordId);
    const next = choices[(idx + 1) % choices.length];
    nextWordId = next.wordId;
    nextDir = next.dir;
  } else if (current.selected) {
    const keep = choices.find(c => c.dir === current.selected.dir);
    if (keep) { nextWordId = keep.wordId; nextDir = keep.dir; }
  }

  if (!nextWordId) {
    const preferAcross = choices.find(c => c.dir === "a") || choices[0];
    nextWordId = preferAcross.wordId;
    nextDir = preferAcross.dir;
  }

  setSelection({ cellIndex, wordId: nextWordId, dir: nextDir });
  kbd.focus();
}

function getWordChoicesAtCell(cellIndex) {
  const m = current.spec.cellToWords[cellIndex];
  const out = [];
  for (const id of (m.a || [])) out.push({ wordId: id, dir: "a" });
  for (const id of (m.d || [])) out.push({ wordId: id, dir: "d" });
  return out;
}

function setSelection(sel) {
  current.selected = sel;
  paintSelection();
  showCurrentClue();
}

function paintSelection() {
  for (const el of gridEl.children) {
    el.classList.remove("selected", "word"); // do not touch wordOk
  }
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

  const dirName = w.dir === "a" ? "Across" : "Down";

  // avoid "(5) (5)" when clue already ends with a length
  const hasLen = /\(\s*\d+\s*\)\s*$/.test((w.clue || "").trim());
  const text = hasLen ? `${dirName} • ${w.clue}` : `${dirName} • ${w.clue} (${w.len})`;
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

/* ---------- word checks ---------- */

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
  // If any verified-correct word includes this cell, treat as “locked”
  const m = current.spec.cellToWords[cellIndex];
  const ids = [...(m.a || []), ...(m.d || [])];
  return ids.some(id => correctWordIds.has(id));
}

/* ---------- typing (including backspace rule) ---------- */

async function onKeyDown(e) {
  if (!current.spec || !current.progress || !current.selected) return;
  if (current.progress.completed) return;

  const { cellIndex, wordId } = current.selected;
  if (current.spec.isBlock[cellIndex]) return;

  const key = e.key;

  if (/^[a-zA-Z]$/.test(key)) {
    e.preventDefault();
    setCell(cellIndex, key.toUpperCase());
    await autosave();

    if (wordId) {
      const w = current.spec.wordMap.get(wordId);
      const pos = w.cells.indexOf(cellIndex);
      if (pos >= 0 && pos < w.cells.length - 1) {
        setSelection({ cellIndex: w.cells[pos + 1], wordId, dir: w.dir });
      } else {
        const next = nextWordAfter(wordId) || firstWord();
        if (next) setSelection({ cellIndex: next.cells[0], wordId: next.id, dir: next.dir });
      }
    }
    return;
  }

  if (key === "Backspace") {
    e.preventDefault();

    const filledHere = getCell(cellIndex);

    // New rule: if checks on AND this cell is part of a verified-correct word,
    // do NOT delete; move back as usual.
    if (filledHere && current.progress.wordChecks && cellIsVerifiedCorrect(cellIndex)) {
      moveBackOneCell(wordId, cellIndex);
      return;
    }

    // Normal behavior
    if (filledHere) {
      setCell(cellIndex, "");
      await autosave();
      return;
    }

    moveBackOneCell(wordId, cellIndex);
    return;
  }
}

function moveBackOneCell(wordId, cellIndex) {
  if (!wordId) return;
  const w = current.spec.wordMap.get(wordId);
  const pos = w.cells.indexOf(cellIndex);
  if (pos > 0) {
    const prev = w.cells[pos - 1];
    setSelection({ cellIndex: prev, wordId, dir: w.dir });
    // delete previous typed letter only if it isn't “locked”
    if (getCell(prev)) {
      if (!(current.progress.wordChecks && cellIsVerifiedCorrect(prev))) {
        setCell(prev, "");
        autosave();
      }
    }
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

/* ---------- hints ---------- */

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

/* ---------- sequencing ---------- */

function firstWord() { return current.spec.words[0] || null; }
function nextWordAfter(wordId) {
  const idx = current.spec.words.findIndex(w => w.id === wordId);
  if (idx < 0) return null;
  return current.spec.words[idx + 1] || null;
}

/* ---------- sheets ---------- */

function openSheet(id) {
  document.body.classList.add("modalOpen");
  $(`#${id}`).classList.remove("hidden");
}
function closeSheet(id) {
  $(`#${id}`).classList.add("hidden");
  const anyOpen = document.querySelector(".sheet:not(.hidden)");
  if (!anyOpen) document.body.classList.remove("modalOpen");
}

/* ---------- utils ---------- */

function isoDate(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addDays(iso, delta) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + delta);
  return isoDate(d);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}