import * as idb from "./idb.js";

/**
 * If direct fetch is blocked by CORS, set API_BASE to your Cloudflare Worker URL:
 * const API_BASE = "https://YOUR-WORKER.workers.dev/?apiurl=";
 */
const API_BASE = ""; // "" = direct

const PSID_DEFAULT = "100000160";

const $ = (s) => document.querySelector(s);

const homeView = $("#homeView");
const puzzleView = $("#puzzleView");

const archiveEl = $("#archive");
const homeStatusEl = $("#homeStatus");
const filterBtn = $("#filterBtn");

const gridEl = $("#grid");
const clueBar = $("#clueBar");
const timerEl = $("#timer");
const kbd = $("#kbd");

const hintBtn = $("#hintBtn");
const menuBtn = $("#menuBtn");
const hintMenu = $("#hintMenu");
const mainMenu = $("#mainMenu");

const revealLetterBtn = $("#revealLetterBtn");
const revealWordBtn = $("#revealWordBtn");
const checkWordBtn = $("#checkWordBtn");
const checkPuzzleBtn = $("#checkPuzzleBtn");

const toggleChecksBtn = $("#toggleChecksBtn");
const saveExitBtn = $("#saveExitBtn");
const restartBtn = $("#restartBtn");

let showIncompleteOnly = false;

let current = {
  key: null,
  psid: PSID_DEFAULT,
  date: null,
  spec: null,         // {rows, cols, title, solution[], isBlock[], words[] ...}
  progress: null,     // { fills[], elapsedMs, runningSince?, checksOn }
  selected: null      // { cellIndex, wordId, dir }
};

let timerTick = null;

/* ---------- boot ---------- */

init();

async function init() {
  // SW
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./sw.js"); } catch {}
  }

  filterBtn.addEventListener("click", async () => {
    showIncompleteOnly = !showIncompleteOnly;
    filterBtn.setAttribute("aria-pressed", String(showIncompleteOnly));
    filterBtn.textContent = showIncompleteOnly ? "Showing incomplete" : "Show incomplete";
    await renderHome();
  });

  hintBtn.addEventListener("click", () => openSheet("hintMenu"));
  menuBtn.addEventListener("click", () => openSheet("mainMenu"));

  document.body.addEventListener("click", (e) => {
    const closeId = e.target?.getAttribute?.("data-close");
    if (closeId) closeSheet(closeId);
    if (e.target === hintMenu) closeSheet("hintMenu");
    if (e.target === mainMenu) closeSheet("mainMenu");
  });

  revealLetterBtn.addEventListener("click", async () => { closeSheet("hintMenu"); await hintRevealLetter(); });
  revealWordBtn.addEventListener("click", async () => { closeSheet("hintMenu"); await hintRevealWord(); });
  checkWordBtn.addEventListener("click", async () => { closeSheet("hintMenu"); await hintCheckWord(); });
  checkPuzzleBtn.addEventListener("click", async () => { closeSheet("hintMenu"); await hintCheckPuzzle(); });

  toggleChecksBtn.addEventListener("click", async () => {
    if (!current.progress) return;
    current.progress.checksOn = !current.progress.checksOn;
    toggleChecksBtn.setAttribute("aria-pressed", String(current.progress.checksOn));
    toggleChecksBtn.textContent = `Word checks: ${current.progress.checksOn ? "On" : "Off"}`;
    await autosave();
    repaintChecks();
  });

  saveExitBtn.addEventListener("click", async () => { closeSheet("mainMenu"); await exitPuzzle(); });
  restartBtn.addEventListener("click", async () => { closeSheet("mainMenu"); await restartPuzzle(); });

  // Keyboard handling
  kbd.addEventListener("keydown", onKeyDown);

  // Stop timer when app hides; resume accurately.
  document.addEventListener("visibilitychange", async () => {
    if (!current.key) return;
    if (document.hidden) await stopTimerAndSave();
    else await startTimerIfPuzzleOpen();
  });

  window.addEventListener("resize", () => {
    if (current.spec) computeCellSize(current.spec.rows, current.spec.cols);
  });

  await renderHome();
  // Efficient incremental sync (newer first, then older probing).
  await autoSync();
  await renderHome();
}

/* ---------- home ---------- */

async function renderHome() {
  const puzzles = await idb.getAll("puzzles");
  const progress = await idb.getAll("progress");
  const progMap = new Map(progress.map((p) => [p.key, p]));

  puzzles.sort((a, b) => (a.date < b.date ? 1 : -1));

  archiveEl.innerHTML = "";
  let shown = 0;

  for (const p of puzzles) {
    const pr = progMap.get(p.key);
    const snap = pr?.snap || null;
    const pct = snap?.pct ?? 0;
    const filled = snap?.filled ?? 0;
    const total = snap?.total ?? 0;

    if (showIncompleteOnly && total > 0 && filled >= total) continue;

    const card = document.createElement("div");
    card.className = "card";

    const left = document.createElement("div");
    left.innerHTML =
      `<div><b>${escapeHtml(p.date)}</b></div>
       <small>${filled}/${total} filled</small>`;

    const right = document.createElement("div");
    right.innerHTML = `<div class="pct"><b>${pct}%</b></div>`;

    const btn = document.createElement("button");
    btn.className = "openBtn";
    btn.textContent = "Open";
    btn.addEventListener("click", async () => {
      await openPuzzle(p.psid, p.date);
    });

    right.appendChild(btn);
    card.appendChild(left);
    card.appendChild(right);
    archiveEl.appendChild(card);
    shown++;
  }

  if (!puzzles.length) {
    archiveEl.innerHTML = `<div class="muted">No cached puzzles yet. Sync will populate automatically.</div>`;
  } else if (!shown) {
    archiveEl.innerHTML = `<div class="muted">No puzzles match the current filter.</div>`;
  }
}

/* ---------- sync (efficient probing) ---------- */

/**
 * Strategy:
 * 1) Fetch forward from newest cached date → today (bounded per session).
 * 2) Probe backward from oldest cached date to discover older puzzles:
 *    - Keep a persistent "probe cursor" and "fail streak" in localStorage.
 *    - Stop after bounded requests each session.
 */
async function autoSync() {
  const psid = PSID_DEFAULT;
  const puzzles = await idb.getAll("puzzles");
  let dates = puzzles.filter(p => p.psid === psid).map(p => p.date);
  dates.sort(); // ascending ISO

  const today = isoDate(new Date());

  const newest = dates.length ? dates[dates.length - 1] : null;
  const oldest = dates.length ? dates[0] : null;

  // If empty, seed with today first (quick win).
  if (!newest) {
    homeStatusEl.textContent = "Fetching today…";
    await tryCache(psid, today);
    homeStatusEl.textContent = "Syncing…";
    dates = [today];
  }

  // 1) Forward fill: newest+1 .. today (cap)
  const forwardCap = 10;
  let forwardCount = 0;
  let cursor = addDays(newest || today, 1);

  while (cursor <= today && forwardCount < forwardCap) {
    homeStatusEl.textContent = `Fetching ${cursor}…`;
    const ok = await tryCache(psid, cursor);
    // even if not ok (no puzzle), still move forward
    cursor = addDays(cursor, 1);
    forwardCount++;
  }

  // 2) Backward probing (cap)
  const state = loadSyncState();
  let backCursor = state.backCursor || addDays(oldest || today, -1);
  let failStreak = state.failStreak || 0;

  const backwardCap = 10;
  let backwardCount = 0;

  while (backwardCount < backwardCap) {
    // Hard stop: if we've had many consecutive misses, assume no more historical content.
    if (failStreak >= 21) break;

    homeStatusEl.textContent = `Probing ${backCursor}…`;
    const ok = await tryCache(psid, backCursor);

    if (ok) failStreak = 0;
    else failStreak++;

    backCursor = addDays(backCursor, -1);
    backwardCount++;
  }

  saveSyncState({ backCursor, failStreak });
  homeStatusEl.textContent = "Up to date (incremental).";
}

function loadSyncState() {
  try { return JSON.parse(localStorage.getItem("crypticSyncState") || "{}"); }
  catch { return {}; }
}
function saveSyncState(s) {
  localStorage.setItem("crypticSyncState", JSON.stringify(s));
}

async function tryCache(psid, date) {
  const key = `${psid}|${date}`;
  const existing = await idb.get("puzzles", key);
  if (existing) return true;

  try {
    const url = `https://data.puzzlexperts.com/puzzleapp-v3/data.php?psid=${encodeURIComponent(psid)}&date=${encodeURIComponent(date)}`;
    const data = await fetchJson(url);
    // Some “no puzzle” responses are still JSON; reject if missing expected fields.
    if (!data?.cells?.[0]?.meta?.data) return false;

    const rec = { key, psid, date, fetchedAt: Date.now(), data };
    await idb.put("puzzles", rec);

    // Initialize progress/snapshot
    const spec = parsePuzzle(data);
    const progress = freshProgress(spec);
    await writeProgress(key, spec, progress);
    return true;
  } catch {
    return false;
  }
}

/* ---------- puzzle open/close ---------- */

async function openPuzzle(psid, date) {
  const key = `${psid}|${date}`;

  const puzzleRec = await idb.get("puzzles", key);
  if (!puzzleRec) {
    // On-demand fetch if user opened a not-yet-cached date (rare if sync is running)
    homeStatusEl.textContent = `Fetching ${date}…`;
    const ok = await tryCache(psid, date);
    if (!ok) return;
  }

  const finalRec = await idb.get("puzzles", key);
  const spec = parsePuzzle(finalRec.data);

  const saved = await idb.get("progress", key);
  const progress = saved?.progress || freshProgress(spec);

  current = {
    key, psid, date, spec,
    progress,
    selected: null
  };

  // UI: switch view
  homeView.classList.add("hidden");
  puzzleView.classList.remove("hidden");

  // Configure menu text
  toggleChecksBtn.setAttribute("aria-pressed", String(!!progress.checksOn));
  toggleChecksBtn.textContent = `Word checks: ${progress.checksOn ? "On" : "Off"}`;

  // Render
  renderGrid(spec, progress);
  computeCellSize(spec.rows, spec.cols);
  showClue(null);

  // Focus keyboard
  setTimeout(() => kbd.focus(), 50);

  await startTimerIfPuzzleOpen();
}

async function exitPuzzle() {
  await stopTimerAndSave();
  current = { key: null, psid: PSID_DEFAULT, date: null, spec: null, progress: null, selected: null };

  puzzleView.classList.add("hidden");
  homeView.classList.remove("hidden");

  await renderHome();
}

async function restartPuzzle() {
  if (!current.spec) return;
  current.progress = freshProgress(current.spec);
  current.selected = null;
  renderGrid(current.spec, current.progress);
  computeCellSize(current.spec.rows, current.spec.cols);
  showClue(null);
  await autosave();
}

/* ---------- timer ---------- */

async function startTimerIfPuzzleOpen() {
  if (!current.key || !current.progress) return;

  // Avoid double-start
  if (current.progress.runningSince) return;

  current.progress.runningSince = Date.now();
  // tick UI
  if (timerTick) clearInterval(timerTick);
  timerTick = setInterval(() => {
    timerEl.textContent = fmtTime(getElapsedMs(current.progress));
  }, 250);

  timerEl.textContent = fmtTime(getElapsedMs(current.progress));
  await autosave(); // persist runningSince
}

async function stopTimerAndSave() {
  if (!current.key || !current.progress) return;

  if (timerTick) { clearInterval(timerTick); timerTick = null; }

  if (current.progress.runningSince) {
    const now = Date.now();
    current.progress.elapsedMs = (current.progress.elapsedMs || 0) + (now - current.progress.runningSince);
    current.progress.runningSince = null;
  }
  timerEl.textContent = fmtTime(getElapsedMs(current.progress));
  await autosave();
}

function getElapsedMs(progress) {
  const base = progress.elapsedMs || 0;
  if (progress.runningSince) return base + (Date.now() - progress.runningSince);
  return base;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/* ---------- parsing ---------- */

function parsePuzzle(apiJson) {
  const metaData = apiJson?.cells?.[0]?.meta?.data;
  if (!metaData) throw new Error("Unexpected JSON format: missing meta.data");

  const params = new URLSearchParams(metaData.startsWith("&") ? metaData.slice(1) : metaData);
  const rows = parseInt(params.get("num_rows") || "15", 10);
  const cols = parseInt(params.get("num_columns") || "15", 10);

  const title = params.get("title") || "Puzzle";

  // Collect word entries
  const wordsRaw = [];
  for (let i = 0; ; i++) {
    const w = params.get(`word${i}`);
    const clue = params.get(`clue${i}`);
    const dir = params.get(`dir${i}`);
    const r = params.get(`start_j${i}`);
    const c = params.get(`start_k${i}`);
    if (!w && !clue && !dir && r === null && c === null) break;
    if (!w || !dir || r === null || c === null) continue;

    wordsRaw.push({
      idx: i,
      answer: w,
      clue: clue || "",
      dir, // "a" or "d"
      r: parseInt(r, 10),
      c: parseInt(c, 10)
    });
  }

  // Build solution grid
  const solution = Array.from({ length: rows * cols }, () => null);

  // Build word objects with cell lists
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
    return {
      id: `${entry.dir}:${entry.idx}`,
      dir: entry.dir,
      clue: entry.clue,
      len: entry.answer.length,
      cells
    };
  });

  const isBlock = solution.map((ch) => ch === null);

  // Map each cell -> available wordIds by direction
  const cellToWords = Array.from({ length: rows * cols }, () => ({ a: [], d: [] }));
  for (const w of words) {
    for (const cell of w.cells) {
      if (w.dir === "a") cellToWords[cell].a.push(w.id);
      else cellToWords[cell].d.push(w.id);
    }
  }

  // Map id -> word
  const wordMap = new Map(words.map(w => [w.id, w]));

  return { rows, cols, title, solution, isBlock, words, wordMap, cellToWords };
}

function freshProgress(spec) {
  return {
    fills: Array.from({ length: spec.rows * spec.cols }, () => ""),
    elapsedMs: 0,
    runningSince: null,
    checksOn: false
  };
}

/* ---------- progress metric (letters filled) ---------- */

function completionSnapshot(spec, progress) {
  let total = 0, filled = 0;
  for (let i = 0; i < spec.solution.length; i++) {
    if (spec.isBlock[i]) continue;
    total++;
    if ((progress.fills[i] || "").trim()) filled++;
  }
  const pct = total ? Math.round((filled / total) * 100) : 0;
  return { total, filled, pct };
}

async function writeProgress(key, spec, progress) {
  const snap = completionSnapshot(spec, progress);
  await idb.put("progress", {
    key,
    updatedAt: Date.now(),
    progress,
    snap
  });
}

/* ---------- fetch ---------- */

async function fetchJson(url) {
  const fetchUrl = API_BASE ? `${API_BASE}${encodeURIComponent(url)}` : url;
  const resp = await fetch(fetchUrl, { cache: "no-store" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const txt = await resp.text();
  try { return JSON.parse(txt); }
  catch { throw new Error("Non-JSON response (CORS/proxy issue?)."); }
}

/* ---------- grid rendering & selection ---------- */

function renderGrid(spec, progress) {
  gridEl.innerHTML = "";
  gridEl.style.gridTemplateColumns = `repeat(${spec.cols}, var(--cell))`;

  for (let i = 0; i < spec.rows * spec.cols; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.i = String(i);
    cell.setAttribute("role", "gridcell");

    if (spec.isBlock[i]) {
      cell.classList.add("block");
      cell.textContent = "";
    } else {
      cell.textContent = (progress.fills[i] || "").toUpperCase();
      cell.addEventListener("click", () => {
        onCellTap(i);
      });
    }
    gridEl.appendChild(cell);
  }

  repaintChecks();
}

function computeCellSize(rows, cols) {
  // Available height = viewport - topbar - (clueBar if visible)
  const topbarH = 52;
  const clueH = clueBar.classList.contains("hidden") ? 0 : 40;

  const vpW = Math.floor(window.innerWidth);
  const vpH = Math.floor(window.innerHeight);

  // Padding in gridShell: 8px each side, plus safe rounding
  const availW = vpW - 16;
  const availH = vpH - topbarH - clueH - 16 - safeInsetTop() - safeInsetBottom();

  const cell = Math.max(20, Math.floor(Math.min(availW / cols, availH / rows)));
  gridEl.style.setProperty("--cell", `${cell}px`);
}

function safeInsetTop() {
  // iOS exposes env() only in CSS; we approximate 0 in JS.
  return 0;
}
function safeInsetBottom() { return 0; }

function onCellTap(cellIndex) {
  if (!current.spec || !current.progress) return;

  // Ignore blocks
  if (current.spec.isBlock[cellIndex]) return;

  const choices = getWordChoicesAtCell(cellIndex);

  if (!choices.length) {
    // still select single cell
    setSelection({ cellIndex, wordId: null, dir: null });
    return;
  }

  // Toggle logic:
  // - If tapping same cell again and there are multiple words, cycle through them.
  // - Else choose: keep current direction if valid; otherwise pick across then down.
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
  // Clear all selection/word highlights
  for (const el of gridEl.children) {
    el.classList.remove("selected", "word");
  }

  if (!current.selected) return;

  const { cellIndex, wordId } = current.selected;

  // Selected cell border
  const selEl = gridEl.querySelector(`[data-i="${cellIndex}"]`);
  if (selEl) selEl.classList.add("selected");

  // Highlight word cells
  if (wordId) {
    const w = current.spec.wordMap.get(wordId);
    if (w) {
      for (const c of w.cells) {
        const el = gridEl.querySelector(`[data-i="${c}"]`);
        if (el) el.classList.add("word");
      }
    }
  }
  repaintChecks();
}

function showCurrentClue() {
  if (!current.selected || !current.selected.wordId) {
    showClue(null);
    return;
  }
  const w = current.spec.wordMap.get(current.selected.wordId);
  if (!w) { showClue(null); return; }
  const dirName = w.dir === "a" ? "Across" : "Down";
  showClue(`${dirName} • ${w.clue} (${w.len})`);
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

/* ---------- typing rules ---------- */

async function onKeyDown(e) {
  if (!current.spec || !current.progress || !current.selected) return;

  const spec = current.spec;
  const prog = current.progress;

  const { cellIndex, wordId } = current.selected;
  if (spec.isBlock[cellIndex]) return;

  const key = e.key;

  // Letters
  if (/^[a-zA-Z]$/.test(key)) {
    e.preventDefault();
    setCell(cellIndex, key.toUpperCase());
    await autosave();

    // Move to next cell in selected word
    if (wordId) {
      const w = spec.wordMap.get(wordId);
      const pos = w.cells.indexOf(cellIndex);
      if (pos >= 0 && pos < w.cells.length - 1) {
        setSelection({ cellIndex: w.cells[pos + 1], wordId, dir: w.dir });
      } else {
        // last letter entered: jump to first cell of next word (same direction), else fallback to any next.
        const next = nextWordAfter(wordId) || firstWord();
        if (next) setSelection({ cellIndex: next.cells[0], wordId: next.id, dir: next.dir });
      }
    }
    return;
  }

  // Backspace: delete current cell if filled; else move back one (unless at first cell)
  if (key === "Backspace") {
    e.preventDefault();

    if (getCell(cellIndex)) {
      setCell(cellIndex, "");
      await autosave();
      return;
    }

    if (wordId) {
      const w = spec.wordMap.get(wordId);
      const pos = w.cells.indexOf(cellIndex);
      if (pos > 0) {
        const prevCell = w.cells[pos - 1];
        setSelection({ cellIndex: prevCell, wordId, dir: w.dir });
        // delete previous typed letter
        if (getCell(prevCell)) {
          setCell(prevCell, "");
          await autosave();
        }
      } // if pos==0 do nothing
    }
    return;
  }
}

/* ---------- cell updates ---------- */

function getCell(i) {
  return (current.progress.fills[i] || "").toUpperCase();
}

function setCell(i, v) {
  current.progress.fills[i] = v;
  const el = gridEl.querySelector(`[data-i="${i}"]`);
  if (el) el.textContent = v;

  // If checks are on, re-evaluate visuals
  repaintChecks();
}

function repaintChecks() {
  if (!current.spec || !current.progress) return;
  const checksOn = !!current.progress.checksOn;

  for (const el of gridEl.children) {
    el.classList.remove("good", "bad");
  }
  if (!checksOn) return;

  // If a word is selected, check that word only; else do nothing.
  if (!current.selected?.wordId) return;

  const w = current.spec.wordMap.get(current.selected.wordId);
  if (!w) return;

  for (const c of w.cells) {
    const el = gridEl.querySelector(`[data-i="${c}"]`);
    if (!el) continue;

    const got = (current.progress.fills[c] || "").toUpperCase();
    if (!got) continue;

    const want = (current.spec.solution[c] || "").toUpperCase();
    if (got === want) el.classList.add("good");
    else el.classList.add("bad");
  }
}

/* ---------- hint actions ---------- */

async function hintRevealLetter() {
  if (!current.selected) return;
  const i = current.selected.cellIndex;
  if (current.spec.isBlock[i]) return;

  const want = (current.spec.solution[i] || "").toUpperCase();
  if (want) setCell(i, want);
  await autosave();
}

async function hintRevealWord() {
  const w = getSelectedWord();
  if (!w) return;
  for (const c of w.cells) {
    const want = (current.spec.solution[c] || "").toUpperCase();
    if (want) setCell(c, want);
  }
  await autosave();
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
  await autosave();
}

async function hintCheckPuzzle() {
  for (let i = 0; i < current.spec.solution.length; i++) {
    if (current.spec.isBlock[i]) continue;
    const got = (current.progress.fills[i] || "").toUpperCase();
    if (!got) continue;
    const want = (current.spec.solution[i] || "").toUpperCase();
    if (got !== want) setCell(i, "");
  }
  await autosave();
}

function getSelectedWord() {
  const id = current.selected?.wordId;
  if (!id) return null;
  return current.spec.wordMap.get(id) || null;
}

/* ---------- autosave ---------- */

let savePending = null;

async function autosave() {
  if (!current.key || !current.spec || !current.progress) return;

  // Debounce saves slightly (mobile friendly)
  if (savePending) clearTimeout(savePending);
  savePending = setTimeout(async () => {
    savePending = null;
    await writeProgress(current.key, current.spec, current.progress);
    // home list updates are cheap but avoid doing it every keystroke; only update snap
    // If user is in puzzle view, we don't re-render the home list.
  }, 120);
}

/* ---------- word sequencing ---------- */

function firstWord() {
  return current.spec.words[0] || null;
}

function nextWordAfter(wordId) {
  const idx = current.spec.words.findIndex(w => w.id === wordId);
  if (idx < 0) return null;
  return current.spec.words[idx + 1] || null;
}

/* ---------- sheets ---------- */

function openSheet(id) {
  $(`#${id}`).classList.remove("hidden");
}
function closeSheet(id) {
  $(`#${id}`).classList.add("hidden");
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