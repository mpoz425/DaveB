#!/usr/bin/env python3
"""
Download every photo referenced in data/photos.json into dist/photos/ so the
site no longer depends on the old Adobe Portfolio CDN.

    python3 scripts/fetch_photos.py
    python3 build.py --local

Expect roughly 150-250 MB for all three sizes (600 / 1200 / 1920).
Standard library only; re-runs skip files that already exist.
"""
import json
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "dist", "photos")


def fetch(job):
    url, path = job
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        return "skip"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as f:
            f.write(r.read())
        return "ok"
    except Exception as e:  # noqa: BLE001
        if os.path.exists(path):
            os.remove(path)
        return "fail %s (%s)" % (url, e)


def main():
    os.makedirs(OUT, exist_ok=True)
    data = json.load(open(os.path.join(ROOT, "data", "photos.json"), encoding="utf-8"))
    jobs = []
    for s in data["sets"]:
        for p in s["photos"]:
            for key, size in (("thumb", 600), ("med", 1200), ("full", 1920)):
                jobs.append((p[key], os.path.join(OUT, "%s_%d.jpg" % (p["id"], size))))
    print("fetching %d files into %s" % (len(jobs), OUT))
    fails = 0
    with ThreadPoolExecutor(max_workers=12) as ex:
        for i, res in enumerate(ex.map(fetch, jobs), 1):
            if res.startswith("fail"):
                fails += 1
                print(res, file=sys.stderr)
            if i % 50 == 0:
                print("  %d / %d" % (i, len(jobs)))
    print("done, %d failures" % fails)
    if not fails:
        print("now run: python3 build.py --local")


if __name__ == "__main__":
    main()
