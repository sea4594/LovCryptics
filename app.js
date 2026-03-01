import * as idb from "./idb.js";

/**
 * If direct fetch is blocked by CORS, set API_BASE to your Cloudflare Worker URL:
 * const API_BASE = "https://YOUR-WORKER.workers.dev/?apiurl=";
 * and it will fetch: `${API_BASE}${encodeURIComponent(realUrl)}`
 */
const API_BASE = ""; // leave "" to fetch directly

const $ = (sel) => document.querySelector(sel);

const statusEl = $("#status");
const dateInput = $("#dateInput");
const psidInput = $("#psidInput");
const loadBtn = $("#loadBtn");
const cacheRangeBtn = $("#cacheRangeBtn");
const rangeDays = $("#rangeDays");
const archiveEl = $("#archive");

const solverPanel = $("#solverPanel");
const puzzleTitleEl = $("#puzzleTitle");
const puzzleMetaEl = $("#puzzleMeta");
const gridEl = $("#grid");
const acrossEl = $("#acrossClues");
const downEl = $("#downClues");
const saveBtn = $("#saveBtn");
const clearBtn = $("#clearBtn");
const checkToggleBtn = $("#checkToggleBtn");

const installDlg = $("#installDlg");
$("#installHintBtn").addEventListener("click", () => installDlg.showModal());

let current = {
  key: null,
  psid: null,
  date: null,
  spec: null,     // parsed puzzle spec (grid, clues, solution)
  progress: null, // { fills: string[] }
  check: false
};

init();

async function init() {
  // Default date = today (local)
  const now = new Date();
  dateInput.value = now.toISOString().slice(0, 10);

  // SW
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./sw.js"); } catch {}
  }

  loadBtn.addEventListener("click", () => loadPuzzle(dateInput.value));
  cacheRangeBtn.addEventListener("click", () => cacheLastNDays(parseInt(rangeDays.value, 10) || 14));
  saveBtn.addEventListener("click", () => saveProgress());
  clearBtn.addEventListener("click", () => clearFills());
  checkToggleBtn.addEventListener("click", () => {
    current.check = !current.check;
    checkToggleBtn.textContent = `Check: ${current.check ? "On" : "Off"}`;
    repaintChecks();
  });

  await refreshArchive();
  setStatus("Ready.");
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function keyFor(psid, date) {
  return `${psid}|${date}`;
}

async function cacheLastNDays(n) {
  const psid = psidInput.value.trim();
  const start = new Date(dateInput.value);
  if (Number.isNaN(start.getTime())) return;

  setStatus(`Caching ${n} day(s)…`);

  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    try {
      await loadPuzzle(iso, { silentRender: true, silentStatus: true, psidOverride: psid });
      setStatus(`Cached: ${iso} (${i + 1}/${n})`);
    } catch (e) {
      setStatus(`Failed ${iso}: ${humanErr(e)}`);
    }
  }

  await refreshArchive();
  setStatus(`Done. Cached ${n} day(s) (some may have failed).`);
}

async function loadPuzzle(date, opts = {}) {
  const psid = (opts.psidOverride || psidInput.value).trim();
  const key = keyFor(psid, date);
  current.key = key;
  current.psid = psid;
  current.date = date;

  if (!opts.silentStatus) setStatus(`Loading ${date}…`);

  // 1) Try cache first (our own DB)
  let puzzleRec = await idb.get("puzzles", key);
  if (!puzzleRec) {
    // fetch and store
    const url = `https://data.puzzlexperts.com/puzzleapp-v3/data.php?psid=${encodeURIComponent(psid)}&date=${encodeURIComponent(date)}`;
    const data = await fetchJson(url);
    puzzleRec = { key, psid, date, fetchedAt: Date.now(), data };
    await idb.put("puzzles", puzzleRec);
  }

  // 2) Parse puzzle into a usable spec
  const spec = parsePuzzle(puzzleRec.data);
  current.spec = spec;

  // 3) Load progress (fills)
  const saved = await idb.get("progress", key);
  current.progress = saved?.progress || freshProgress(spec);

  // 4) Render unless silent
  if (!opts.silentRender) {
    renderSolver(spec, current.progress, { date, psid });
    solverPanel.classList.remove("hidden");
    if (!opts.silentStatus) setStatus(`Loaded ${date}.`);
  }

  // 5) Update archive % immediately
  await writePercentSnapshot(key, spec, current.progress);
  await refreshArchive();
}

async function fetchJson(url) {
  const fetchUrl = API_BASE ? `${API_BASE}${encodeURIComponent(url)}` : url;
  const resp = await fetch(fetchUrl, { cache: "no-store" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const txt = await resp.text();
  try { return JSON.parse(txt); }
  catch { throw new Error("Non-JSON response (possible CORS/proxy issue)."); }
}

function humanErr(e) {
  const s = String(e?.message || e);
  if (s.toLowerCase().includes("cors")) return "CORS blocked (use proxy).";
  return s;
}

/**
 * The endpoint returns JSON with a cell meta.data string containing URL-encoded params:
 * word0=..., clue0=..., dir0=a|d, start_j0=row, start_k0=col, num_rows, num_columns, etc.
 * Example response is visible here.  [oai_citation:6‡Puzzle Experts](https://data.puzzlexperts.com/puzzleapp-v3/data.php?date=2026-03-01&psid=100000160)
 */
function parsePuzzle(apiJson) {
  const metaData = apiJson?.cells?.[0]?.meta?.data;
  if (!metaData) throw new Error("Unexpected JSON format: missing meta.data");

  const params = new URLSearchParams(metaData.startsWith("&") ? metaData.slice(1) : metaData);
  const rows = parseInt(params.get("num_rows") || "15", 10);
  const cols = parseInt(params.get("num_columns") || "15", 10);

  // Collect word entries (word0..wordN)
  const words = [];
  for (let i = 0; ; i++) {
    const w = params.get(`word${i}`);
    const clue = params.get(`clue${i}`);
    const dir = params.get(`dir${i}`);
    const r = params.get(`start_j${i}`);
    const c = params.get(`start_k${i}`);
    if (!w && !clue && !dir && r === null && c === null) break;
    if (!w || !dir || r === null || c === null) continue;
    words.push({
      idx: i,
      answer: w,
      clue: clue || "",
      dir,
      r: parseInt(r, 10),
      c: parseInt(c, 10)
    });
  }

  const title = params.get("title") || "Puzzle";
  const id = params.get("id") || "";
  const category = params.get("category") || "";

  // Build solution grid from words
  const solution = Array.from({ length: rows * cols }, () => null);
  for (const entry of words) {
    const dr = entry.dir === "d" ? 1 : 0;
    const dc = entry.dir === "a" ? 1 : 0;
    for (let k = 0; k < entry.answer.length; k++) {
      const rr = entry.r + dr * k;
      const cc = entry.c + dc * k;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const pos = rr * cols + cc;
      solution[pos] = entry.answer[k];
    }
  }

  // Cells with no solution letter become black squares
  const isBlack = solution.map((ch) => ch === null);

  // Clue lists (across/down)
  const across = [];
  const down = [];
  for (const entry of words) {
    const clueText = `${entry.clue} (${entry.answer.length})`;
    if (entry.dir === "a") across.push({ n: entry.idx + 1, text: clueText });
    else down.push({ n: entry.idx + 1, text: clueText });
  }

  return { rows, cols, title, id, category, solution, isBlack, across, down };
}

function freshProgress(spec) {
  return { fills: Array.from({ length: spec.rows * spec.cols }, () => "") };
}

function completionPercent(spec, progress) {
  let total = 0, filled = 0;
  for (let i = 0; i < spec.solution.length; i++) {
    if (spec.isBlack[i]) continue;
    total++;
    const got = (progress.fills[i] || "").toUpperCase();
    if (got) filled++;
  }
  return { total, filled, pct: total ? Math.round((filled / total) * 100) : 0 };
}

async function writePercentSnapshot(key, spec, progress) {
  const snap = completionPercent(spec, progress);
  const rec = await idb.get("progress", key);
  const next = {
    key,
    updatedAt: Date.now(),
    progress,
    snap
  };
  await idb.put("progress", next);
}

async function saveProgress() {
  if (!current.key) return;
  await writePercentSnapshot(current.key, current.spec, current.progress);
  await refreshArchive();
  setStatus("Saved.");
}

async function clearFills() {
  if (!current.key) return;
  current.progress = freshProgress(current.spec);
  renderSolver(current.spec, current.progress, { date: current.date, psid: current.psid });
  await saveProgress();
}

async function refreshArchive() {
  const puzzles = await idb.getAll("puzzles");
  const progress = await idb.getAll("progress");
  const progMap = new Map(progress.map((p) => [p.key, p]));

  // Sort newest date first (string ISO works)
  puzzles.sort((a, b) => (a.date < b.date ? 1 : -1));

  archiveEl.innerHTML = "";
  for (const p of puzzles) {
    const pr = progMap.get(p.key);
    const pct = pr?.snap?.pct ?? 0;
    const filled = pr?.snap?.filled ?? 0;
    const total = pr?.snap?.total ?? 0;

    const card = document.createElement("div");
    card.className = "card";

    const left = document.createElement("div");
    left.innerHTML = `<div><b>${escapeHtml(p.date)}</b> <small>${escapeHtml(p.psid)}</small></div>
                      <small>${filled}/${total} filled-correct</small>`;

    const right = document.createElement("div");
    right.innerHTML = `<div class="pct"><b>${pct}%</b></div>`;

    const btn = document.createElement("button");
    btn.textContent = "Open";
    btn.addEventListener("click", () => loadPuzzle(p.date, { psidOverride: p.psid }));

    right.appendChild(btn);
    card.appendChild(left);
    card.appendChild(right);
    archiveEl.appendChild(card);
  }

  if (!puzzles.length) {
    archiveEl.innerHTML = `<div class="status">No cached puzzles yet. Load one above.</div>`;
  }
}

function renderSolver(spec, progress, { date, psid }) {
  puzzleTitleEl.textContent = `${spec.title}`;
  puzzleMetaEl.textContent = `${date} • psid ${psid}${spec.id ? " • " + spec.id : ""}${spec.category ? " • " + spec.category : ""}`;

  // Clues
  acrossEl.innerHTML = "";
  downEl.innerHTML = "";
  for (const c of spec.across) {
    const li = document.createElement("li");
    li.textContent = c.text;
    acrossEl.appendChild(li);
  }
  for (const c of spec.down) {
    const li = document.createElement("li");
    li.textContent = c.text;
    downEl.appendChild(li);
  }

  // Grid
  gridEl.innerHTML = "";
  gridEl.style.gridTemplateColumns = `repeat(${spec.cols}, 28px)`;

  for (let i = 0; i < spec.rows * spec.cols; i++) {
    if (spec.isBlack[i]) {
      const div = document.createElement("div");
      div.className = "cell black";
      gridEl.appendChild(div);
      continue;
    }
    const inp = document.createElement("input");
    inp.className = "cell";
    inp.inputMode = "text";
    inp.maxLength = 1;
    inp.value = (progress.fills[i] || "").toUpperCase();

    inp.addEventListener("input", async () => {
      const v = (inp.value || "").toUpperCase().replace(/[^A-Z]/g, "");
      inp.value = v;
      progress.fills[i] = v;
      if (current.check) paintCellCheck(inp, spec, progress, i);
      // persist lightly (debounce-less but cheap)
      await writePercentSnapshot(current.key, spec, progress);
      await refreshArchive();
    });

    inp.addEventListener("focus", () => inp.select());
    gridEl.appendChild(inp);
  }

  repaintChecks();
}

function repaintChecks() {
  if (!current.spec) return;
  const inputs = Array.from(gridEl.querySelectorAll("input.cell"));
  // inputs excludes black squares, so we must map carefully:
  let inpIdx = 0;
  for (let i = 0; i < current.spec.isBlack.length; i++) {
    if (current.spec.isBlack[i]) continue;
    const inp = inputs[inpIdx++];
    inp.classList.remove("good", "bad");
    if (current.check) paintCellCheck(inp, current.spec, current.progress, i);
  }
}

function paintCellCheck(inp, spec, progress, i) {
  inp.classList.remove("good", "bad");
  const got = (progress.fills[i] || "").toUpperCase();
  if (!got) return;
  const want = (spec.solution[i] || "").toUpperCase();
  if (got === want) inp.classList.add("good");
  else inp.classList.add("bad");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}
