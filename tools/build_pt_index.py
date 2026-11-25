"""Build the Portuguese ISBN index for My Shelves.

Uses two open-data sources from the National Library of Portugal (both CC0) and writes small JSON
files that the app looks ISBNs up in:

    pt-isbn/<3 digits>.json   ->  {"9789722544733": ["Title", "Author", "2023", "Publisher", 32], ...}

The 3 digits are positions 10-12 of the ISBN-13, which spreads books evenly over 1000 files.

Sources:
  - The library's whole catalogue as one file (catalogo.csv.zip, about 150 MB, updated monthly).
    This holds nearly everything, old books included.
  - The Portuguese National Bibliography feed (OAI-PMH) for books since 2002, fetched month by month.
    This adds records newer than the catalogue file.

Usage (from the my-shelves folder):
    python tools/build_pt_index.py all         # download both, then build (use this to refresh)
    python tools/build_pt_index.py download    # the catalogue file only
    python tools/build_pt_index.py harvest     # the feed only (resumable; later runs fetch only changes)
    python tools/build_pt_index.py build       # write pt-isbn/*.json from what was downloaded

Downloads are kept in .cache/ (not committed).
"""
import csv
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone

BASE = "https://oai.bnportugal.gov.pt/servlet/OAIHandler"
SETS = ["bibliografianacional"]  # books since 2002. Older books come from the catalogue file: the feed
# serves them as one 344,000-record list that restarts from zero whenever a page fails.
CATALOGUE_URL = "https://opendata.bnportugal.gov.pt/docs/catalogo.csv.zip"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "pt")
CATALOGUE = os.path.join(ROOT, ".cache", "bulk", "catalogo.csv.zip")
OUT = os.path.join(ROOT, "pt-isbn")
PAUSE = 1.0  # seconds between requests, to be gentle on the library's server
UA = "MyShelvesIndexBuilder/1.0 (+https://bmtalves.github.io/my-shelves/)"

NS = {
    "oai": "http://www.openarchives.org/OAI/2.0/",
    "dc": "http://purl.org/dc/elements/1.1/",
}


# ---------- ISBN helpers ----------
def isbn13_valid(d):
    if not re.fullmatch(r"\d{13}", d):
        return False
    s = sum(int(c) * (3 if i % 2 else 1) for i, c in enumerate(d[:12]))
    return (10 - s % 10) % 10 == int(d[12])


def isbn10_valid(d):
    if not re.fullmatch(r"\d{9}[\dX]", d):
        return False
    s = sum((10 if c == "X" else int(c)) * (10 - i) for i, c in enumerate(d))
    return s % 11 == 0


def to_isbn13(raw):
    d = re.sub(r"[^0-9X]", "", raw.upper())
    if len(d) == 13 and d.startswith(("978", "979")) and isbn13_valid(d):
        return d
    if len(d) == 10 and isbn10_valid(d):
        b = "978" + d[:9]
        s = sum(int(c) * (3 if i % 2 else 1) for i, c in enumerate(b))
        return b + str((10 - s % 10) % 10)
    return None


# ---------- Record cleaning ----------
def clean(s):
    # \x98 / \x9c mark the non-sorting start of a title ("\x98As \x9ccasas" -> "As casas").
    s = (s or "").replace("\x98", "").replace("\x9c", "")
    return re.sub(r"\s+", " ", s).strip(" /:;,.")


def publisher_name(s):
    s = clean(re.sub(r"[\[\]]", "", s or ""))
    return "" if s.lower() in ("s.n", "s.n.", "sn") else s


def person(name):
    # "Horikoshi, Kohei, 1986-" -> "Kohei Horikoshi"
    parts = [p.strip() for p in clean(name).split(",")]
    parts = [p for p in parts if p and not re.fullmatch(r"[\d?\-. ]+|fl\..*|ca\..*", p)]
    if len(parts) >= 2:
        first = parts[1] + ("." if re.search(r"(?:^| )[A-Z]$", parts[1]) else "")  # "C. R" -> "C. R."
        return f"{first} {parts[0]}"
    return parts[0] if parts else ""


def pages(fmt):
    # "177, [15] p., il., 19 cm" -> 177 ; "[32] p." -> 32 ; "2 vol." -> None
    m = re.search(r"^(.*?)\s*(?:p\.|págs?\.?|pp\.)", fmt or "")
    if not m:
        return None
    plain = re.findall(r"(?<![\[\d])(\d+)(?![\]\d])", m.group(1))   # numbered pages, e.g. 177
    bracketed = re.findall(r"\[(\d+)\]", m.group(1))                 # unnumbered pages, e.g. [15]
    nums = plain or bracketed
    return int(nums[-1]) if nums else None


def parse_record(rec):
    """One oai_dc record -> list of (isbn13, entry). Records with several ISBNs give several entries."""
    if rec.find("oai:header", NS) is not None and rec.find("oai:header", NS).get("status") == "deleted":
        return []
    md = rec.find("oai:metadata", NS)
    if md is None:
        return []
    get = lambda tag: [e.text or "" for e in md.iter("{%s}%s" % (NS["dc"], tag))]
    isbns = []
    for ident in get("identifier"):
        m = re.match(r"\s*URN:ISBN:\s*(.+)", ident, re.I)
        if m:
            i13 = to_isbn13(m.group(1))
            if i13 and i13 not in isbns:
                isbns.append(i13)
    if not isbns:
        return []
    title = clean((get("title") or [""])[0])
    if not title:
        return []
    creators = get("creator")
    author = person(creators[0]) if creators else ""
    publisher = publisher_name((get("publisher") or [""])[0])
    year = next((m.group(0) for d in get("date") for m in [re.search(r"\d{4}", d)] if m), "")
    pg = next((p for f in get("format") for p in [pages(f)] if p), None)
    return [(i, make_entry(title, author, year, publisher, pg)) for i in isbns]


def make_entry(*fields):
    entry = list(fields)
    while entry and entry[-1] in ("", None):  # trim empty trailing fields to save space
        entry.pop()
    return entry


# ---------- Catalogue file ----------
def download_catalogue():
    os.makedirs(os.path.dirname(CATALOGUE), exist_ok=True)
    part = CATALOGUE + ".part"
    print("Downloading the library's catalogue file (about 150 MB)...", flush=True)
    for attempt in range(5):
        try:
            req = urllib.request.Request(CATALOGUE_URL, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=600) as r, open(part, "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            zipfile.ZipFile(part).testzip()  # make sure the download is complete
            os.replace(part, CATALOGUE)
            print(f"Saved {os.path.getsize(CATALOGUE) / 1e6:.0f} MB to {CATALOGUE}", flush=True)
            return
        except Exception as e:
            wait = 30 * (attempt + 1)
            print(f"  download failed ({e}); retrying in {wait}s", flush=True)
            time.sleep(wait)
    raise SystemExit("Couldn't download the catalogue file. Try again later.")


def catalogue_entries():
    """Portuguese ISBNs from catalogo.csv -> {isbn13: entry}."""
    csv.field_size_limit(2**31 - 1)  # a few records list hundreds of contributors
    z = zipfile.ZipFile(CATALOGUE)
    name = next(n for n in z.namelist() if n.endswith("/catalogo.csv") or n == "catalogo.csv")
    # The file is UTF-8 apart from about a hundred stray bytes, which become �.
    text = z.open(name).read().decode("utf8", errors="replace")
    out = {}
    for row in csv.DictReader(io.StringIO(text, newline="")):
        raw = row.get("ISBN") or ""
        if not raw:
            continue
        found = (to_isbn13(t) for t in re.findall(r"(?:97[89][\s-]?)?\d[\d\s-]{7,15}[\dXx]", raw))
        isbn = next((i for i in found if i), None)
        if not isbn or not isbn.startswith(("978972", "978989")):
            continue
        title = clean(row.get("Title"))
        if not title:
            continue
        sub = clean(row.get("Subtitle"))
        if sub:
            title = f"{title}: {sub}"
        authors = (row.get("Authors") or "").split(" ; ")
        year = (re.search(r"\d{4}", row.get("Date of Publication") or "") or [""])[0]
        out[isbn] = make_entry(title, person(authors[0]) if authors[0] else "", year,
                               publisher_name(row.get("Name of Publisher")), pages(row.get("Extent of Item")))
    return out


# ---------- Harvest ----------
def fetch(params, tries=6):
    url = BASE + "?" + urllib.parse.urlencode(params)
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=600) as r:
                return r.read()
        except Exception as e:  # network hiccup or server busy: back off and retry
            wait = min(300, 10 * 2 ** attempt)
            print(f"  request failed ({e}); retrying in {wait}s", flush=True)
            time.sleep(wait)
    raise SystemExit("The library's server kept failing. Run the same command again later to continue.")


def state_path(s):
    return os.path.join(CACHE, f"{s}.state.json")


def windows(since):
    """Date ranges to ask for, one month each. A failure then only repeats that month, because the
    library's position markers work once and a lost one means asking for the range again."""
    today = datetime.now(timezone.utc).date()
    y, m = (int(since[:4]), int(since[5:7])) if since else (2008, 1)
    out = [] if since else [(None, "2007-12-31")]
    while (y, m) <= (today.year, today.month):
        ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
        last = (datetime(ny, nm, 1) - datetime(y, m, 1)).days
        frm = since if since and (y, m) == (int(since[:4]), int(since[5:7])) else f"{y}-{m:02d}-01"
        out.append((frm, f"{y}-{m:02d}-{last:02d}"))
        y, m = ny, nm
    return out


def harvest_set(set_name):
    os.makedirs(CACHE, exist_ok=True)
    st_file = state_path(set_name)
    st = json.load(open(st_file, encoding="utf8")) if os.path.exists(st_file) else {}
    if "done" not in st:  # first run, or a state file from the old one-long-list version
        since = (st.get("complete_at") or "")[:10] or None
        st = {"since": since, "done": [], "started_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "complete_at": st.get("complete_at")}
    save = lambda: json.dump(st, open(st_file, "w", encoding="utf8"))
    save()
    out = os.path.join(CACHE, f"{set_name}.jsonl")
    todo = [w for w in windows(st["since"]) if f"{w[0]}..{w[1]}" not in st["done"]]
    print(f"[{set_name}] {len(todo)} months to fetch", flush=True)

    with open(out, "a", encoding="utf8") as f:
        for frm, until in todo:
            key = f"{frm}..{until}"
            for attempt in range(5):
                params = {"verb": "ListRecords", "metadataPrefix": "oai_dc", "set": set_name, "until": until}
                if frm:
                    params["from"] = frm
                ok = True
                while True:
                    root = ET.fromstring(fetch(params))
                    err = root.find("oai:error", NS)
                    if err is not None:
                        code = err.get("code")
                        if code == "noRecordsMatch":
                            break
                        if code == "badResumptionToken":  # marker used up by a failed request
                            print(f"[{set_name}] {key}: lost the library's position marker; fetching this range again", flush=True)
                            ok = False
                            break
                        raise SystemExit(f"OAI error {code}: {err.text}")
                    lr = root.find("oai:ListRecords", NS)
                    n = 0
                    for rec in lr.findall("oai:record", NS):
                        for isbn, entry in parse_record(rec):
                            f.write(json.dumps([isbn, entry], ensure_ascii=False) + "\n")
                            n += 1
                    f.flush()
                    tok = lr.find("oai:resumptionToken", NS)
                    token = (tok.text or "").strip() if tok is not None else ""
                    where = f"{tok.get('cursor')}/{tok.get('completeListSize')} records read" if tok is not None and tok.get("cursor") else "last page"
                    print(f"[{set_name}] {key}: {where}, {n} ISBNs from this page", flush=True)
                    if not token:
                        break
                    params = {"verb": "ListRecords", "resumptionToken": token}
                    time.sleep(PAUSE)
                if ok:
                    break
            else:
                raise SystemExit("The library's server kept failing. Run the same command again later to continue.")
            st["done"].append(key)
            save()
            time.sleep(PAUSE)

    st = {"complete_at": st["started_at"]}  # next run only asks for records changed since this one began
    save()
    print(f"[{set_name}] done", flush=True)


# ---------- Build ----------
def build():
    index = {}
    if os.path.exists(CATALOGUE):
        index.update(catalogue_entries())
        print(f"Catalogue file: {len(index):,} Portuguese ISBNs", flush=True)
    for s in SETS:  # the feed is newer than the catalogue file, so it wins on duplicates
        p = os.path.join(CACHE, f"{s}.jsonl")
        if not os.path.exists(p):
            continue
        with open(p, encoding="utf8") as f:
            for line in f:
                try:
                    isbn, entry = json.loads(line)
                except ValueError:  # a line cut off by an interrupted download
                    continue
                index[isbn] = entry  # later lines are newer versions
    if not index:
        raise SystemExit("Nothing downloaded yet. Run: python tools/build_pt_index.py all")
    shards = {}
    for isbn, entry in index.items():
        shards.setdefault(isbn[9:12], {})[isbn] = entry
    os.makedirs(OUT, exist_ok=True)
    for name in os.listdir(OUT):
        if name.endswith(".json"):
            os.remove(os.path.join(OUT, name))
    for key, data in shards.items():
        with open(os.path.join(OUT, f"{key}.json"), "w", encoding="utf8") as f:
            json.dump(dict(sorted(data.items())), f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(OUT, "about.json"), "w", encoding="utf8") as f:
        json.dump({
            "source": "Biblioteca Nacional de Portugal: catalogue and Bibliografia Nacional Portuguesa (CC0 1.0)",
            "url": "https://opendata.bnportugal.gov.pt/",
            "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "isbns": len(index),
            "fields": ["title", "author", "year", "publisher", "pages"],
        }, f, ensure_ascii=False, indent=2)
    size = sum(os.path.getsize(os.path.join(OUT, n)) for n in os.listdir(OUT))
    print(f"Wrote {len(index):,} ISBNs into {len(shards)} files ({size / 1e6:.1f} MB) in {OUT}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("download", "all"):
        download_catalogue()
    if cmd in ("harvest", "all"):
        for s in SETS:
            harvest_set(s)
    if cmd in ("build", "all"):
        build()
    if cmd not in ("download", "harvest", "build", "all"):
        print(__doc__)
