"""Build the Portuguese ISBN index for My Shelves.

Downloads the Portuguese National Bibliography from the National Library of Portugal's open-data
feed (OAI-PMH, CC0 licence) and writes small JSON files that the app looks ISBNs up in:

    pt-isbn/<3 digits>.json   ->  {"9789722544733": ["Title", "Author", "2023", "Publisher", 32], ...}

The 3 digits are positions 10-12 of the ISBN-13, which spreads books evenly over 1000 files.

Usage (from the my-shelves folder):
    python tools/build_pt_index.py harvest     # download (resumable; re-run to continue or to fetch new records)
    python tools/build_pt_index.py build       # write pt-isbn/*.json from what was downloaded
    python tools/build_pt_index.py all         # both

Downloaded records are kept in .cache/pt/ (not committed). A later "harvest" only asks for records
added or changed since the previous complete run.
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

BASE = "https://oai.bnportugal.gov.pt/servlet/OAIHandler"
SETS = ["bibliografianacional", "bibliografianacional2001"]  # since 2002, and 1935-2001
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "pt")
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


def person(name):
    # "Horikoshi, Kohei, 1986-" -> "Kohei Horikoshi"
    parts = [p.strip() for p in clean(name).split(",")]
    parts = [p for p in parts if p and not re.fullmatch(r"[\d?\-. ]+|fl\..*|ca\..*", p)]
    if len(parts) >= 2:
        return f"{parts[1]} {parts[0]}"
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
    publisher = clean((get("publisher") or [""])[0])
    year = next((m.group(0) for d in get("date") for m in [re.search(r"\d{4}", d)] if m), "")
    pg = next((p for f in get("format") for p in [pages(f)] if p), None)
    entry = [title, author, year, publisher, pg]
    while entry and entry[-1] in ("", None):  # trim empty trailing fields to save space
        entry.pop()
    return [(i, entry) for i in isbns]


# ---------- Harvest ----------
def fetch(params, tries=6):
    url = BASE + "?" + urllib.parse.urlencode(params)
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # network hiccup or server busy: back off and retry
            wait = min(300, 10 * 2 ** attempt)
            print(f"  request failed ({e}); retrying in {wait}s", flush=True)
            time.sleep(wait)
    raise SystemExit("The library's server kept failing. Run the same command again later to continue.")


def state_path(s):
    return os.path.join(CACHE, f"{s}.state.json")


def harvest_set(set_name):
    os.makedirs(CACHE, exist_ok=True)
    st_file = state_path(set_name)
    st = json.load(open(st_file, encoding="utf8")) if os.path.exists(st_file) else {}
    out = os.path.join(CACHE, f"{set_name}.jsonl")

    if st.get("token"):
        params = {"verb": "ListRecords", "resumptionToken": st["token"]}
        print(f"[{set_name}] continuing from record {st.get('cursor', '?')}", flush=True)
    else:
        params = {"verb": "ListRecords", "metadataPrefix": "oai_dc", "set": set_name}
        if st.get("complete_at"):
            params["from"] = st["complete_at"][:10]  # only records new or changed since the last full run
            print(f"[{set_name}] fetching changes since {params['from']}", flush=True)
        else:
            print(f"[{set_name}] starting", flush=True)
        st["started_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    with open(out, "a", encoding="utf8") as f:
        while True:
            body = fetch(params)
            root = ET.fromstring(body)
            err = root.find("oai:error", NS)
            if err is not None:
                code = err.get("code")
                if code == "noRecordsMatch":
                    break
                if code == "badResumptionToken":  # token expired: restart this set from the top
                    print(f"[{set_name}] the library's position marker expired; restarting this set", flush=True)
                    st.pop("token", None)
                    json.dump(st, open(st_file, "w", encoding="utf8"))
                    return harvest_set(set_name)
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
            total = tok.get("completeListSize") if tok is not None else "?"
            cursor = tok.get("cursor") if tok is not None else "?"
            print(f"[{set_name}] {cursor}/{total} records read, {n} ISBNs from this page", flush=True)
            if not token:
                break
            st["token"], st["cursor"] = token, cursor
            json.dump(st, open(st_file, "w", encoding="utf8"))
            params = {"verb": "ListRecords", "resumptionToken": token}
            time.sleep(PAUSE)

    st.pop("token", None)
    st.pop("cursor", None)
    st["complete_at"] = st.get("started_at")
    json.dump(st, open(st_file, "w", encoding="utf8"))
    print(f"[{set_name}] done", flush=True)


# ---------- Build ----------
def build():
    index = {}
    for s in reversed(SETS):  # older set first, so newer records win on duplicates
        p = os.path.join(CACHE, f"{s}.jsonl")
        if not os.path.exists(p):
            continue
        with open(p, encoding="utf8") as f:
            for line in f:
                try:
                    isbn, entry = json.loads(line)
                except ValueError:  # a line cut off by an interrupted download
                    continue
                old = index.get(isbn)
                # Later lines are newer versions; keep them unless they lost information.
                if old is None or len(entry) >= len(old):
                    index[isbn] = entry
    if not index:
        raise SystemExit("Nothing downloaded yet. Run: python tools/build_pt_index.py harvest")
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
            "source": "Bibliografia Nacional Portuguesa, Biblioteca Nacional de Portugal (CC0 1.0)",
            "url": "https://opendata.bnportugal.gov.pt/",
            "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "isbns": len(index),
            "fields": ["title", "author", "year", "publisher", "pages"],
        }, f, ensure_ascii=False, indent=2)
    size = sum(os.path.getsize(os.path.join(OUT, n)) for n in os.listdir(OUT))
    print(f"Wrote {len(index):,} ISBNs into {len(shards)} files ({size / 1e6:.1f} MB) in {OUT}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("harvest", "all"):
        for s in SETS:
            harvest_set(s)
    if cmd in ("build", "all"):
        build()
    if cmd not in ("harvest", "build", "all"):
        print(__doc__)
