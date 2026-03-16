import os, json, datetime, pathlib, urllib.request, urllib.error

PSID = os.getenv("PSID", "100000160").strip()
BACKFILL = (os.getenv("BACKFILL", "false").lower() == "true")

OUT_DIR = pathlib.Path("puzzles") / PSID
OUT_DIR.mkdir(parents=True, exist_ok=True)

INDEX_PATH = pathlib.Path("puzzles") / "index.json"
INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)

def iso(d: datetime.date) -> str:
    return d.strftime("%Y-%m-%d")

def fetch_date(date_str: str) -> dict | None:
    url = f"https://data.puzzlexperts.com/puzzleapp-v3/data.php?psid={PSID}&date={date_str}"
    req = urllib.request.Request(url, headers={"User-Agent": "lovcryptic-cache/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            txt = r.read().decode("utf-8", "ignore")
        data = json.loads(txt)
        if not (data.get("cells") and data["cells"][0].get("meta") and data["cells"][0]["meta"].get("data")):
            return None
        return data
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError):
        return None

def load_index():
    if INDEX_PATH.exists():
        return json.loads(INDEX_PATH.read_text("utf-8"))
    return {"psid": PSID, "dates": []}

idx = load_index()
dates = sorted(set(idx.get("dates", [])))

today = datetime.date.today()
ahead_days = 3
end = today + datetime.timedelta(days=ahead_days)

# Build a complete view of known dates from both index and existing files.
file_dates = []
for p in OUT_DIR.glob("*.json"):
    try:
        datetime.date.fromisoformat(p.stem)
        file_dates.append(p.stem)
    except ValueError:
        continue

known_dates = sorted(set(dates + file_dates))

if known_dates:
    oldest = datetime.date.fromisoformat(known_dates[0])
else:
    oldest = today

# Gap fill from oldest through end so any previously missed day is retried.
cursor = oldest
while cursor <= end:
    ds = iso(cursor)
    out_file = OUT_DIR / f"{ds}.json"
    # Always attempt missing files, even if index/date history has gaps.
    if not out_file.exists():
        data = fetch_date(ds)
        if data:
            out_file.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
            dates.append(ds)
    else:
        # Keep index in sync with files that already exist on disk.
        dates.append(ds)
    cursor += datetime.timedelta(days=1)

# Optional backfill
if BACKFILL:
    misses = 0
    max_misses = 30
    if dates:
        oldest = datetime.date.fromisoformat(dates[0])
    else:
        oldest = today
    cursor = oldest - datetime.timedelta(days=1)

    while misses < max_misses:
        ds = iso(cursor)
        out_file = OUT_DIR / f"{ds}.json"
        if not out_file.exists():
            data = fetch_date(ds)
            if data:
                out_file.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
                dates.append(ds)
                misses = 0
            else:
                misses += 1
        cursor -= datetime.timedelta(days=1)

dates = sorted(set(dates))
idx = {"psid": PSID, "dates": dates}
INDEX_PATH.write_text(json.dumps(idx, ensure_ascii=False), "utf-8")
print(f"Cached {len(dates)} dates for psid={PSID}")
