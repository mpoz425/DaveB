#!/usr/bin/env python3
"""
Add photos to a series: resize them into assets/photos/ and register them in
data/photos/<series>.json. Photos are appended, so existing frame numbers
(and the homepage picks that point at them) never shift.

    python3 scripts/add_photos.py concerts ~/Desktop/roll-12/*.jpg
    python3 scripts/add_photos.py travel IMG_01.jpg IMG_02.jpg --place "Tetons, WY" --stock "Kodak Portra 800"
    python3 scripts/add_photos.py --incoming     # process everything dropped in incoming/<series>/

Needs Pillow:  pip install pillow
"""
import argparse
import json
import os
import sys
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
ASSETS = os.path.join(ROOT, "assets", "photos")
INCOMING = os.path.join(ROOT, "incoming")
SIZES = (600, 1200, 1920)
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover
    sys.exit("This script needs Pillow. Install it with:  pip install pillow")


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")


def known_series():
    return {s["slug"]: s for s in load_json(os.path.join(DATA, "series.json"), [])}


def known_stocks():
    return {s["name"].lower(): s["name"] for s in load_json(os.path.join(DATA, "film_stocks.json"), [])}


def resize_into_assets(src):
    """Write 600/1200/1920-wide JPEGs for one image; return (id, w, h) of the 600 version."""
    pid = str(uuid.uuid4())
    os.makedirs(ASSETS, exist_ok=True)
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        dims = None
        for width in SIZES:
            out = im
            if im.width > width:
                out = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
            # Saving without exif drops camera metadata (including any GPS) from the public copies.
            out.save(os.path.join(ASSETS, "%s_%d.jpg" % (pid, width)), "JPEG", quality=82, optimize=True, progressive=True)
            if width == SIZES[0]:
                dims = out.size
    return pid, dims[0], dims[1]


def add(slug, files, place=None, stock=None):
    series = known_series()
    if slug not in series:
        sys.exit("unknown series %r. Known: %s" % (slug, ", ".join(sorted(series))))
    stocks = known_stocks()
    if stock:
        if stock.lower() not in stocks:
            sys.exit("unknown film stock %r. Known: %s" % (stock, ", ".join(sorted(stocks.values()))))
        stock = stocks[stock.lower()]
    path = os.path.join(DATA, "photos", slug + ".json")
    photos = load_json(path, [])
    added = 0
    for src in files:
        if os.path.splitext(src)[1].lower() not in IMAGE_EXT:
            print("skip (not an image):", src)
            continue
        pid, w, h = resize_into_assets(src)
        photos.append({"id": pid, "w": w, "h": h, "place": place, "stock": stock, "thumb": None, "med": None, "full": None})
        added += 1
        print("  %s  ->  %s frame %d" % (os.path.basename(src), slug, len(photos)))
    if added:
        save_json(path, photos)
    print("added %d photo%s to %s (%d frames now)" % (added, "" if added == 1 else "s", slug, len(photos)))
    return added


def process_incoming():
    """Every image in incoming/<series>/ gets added to that series, then removed from incoming/."""
    if not os.path.isdir(INCOMING):
        print("no incoming/ folder; nothing to do")
        return 0
    total = 0
    for slug in sorted(os.listdir(INCOMING)):
        folder = os.path.join(INCOMING, slug)
        if not os.path.isdir(folder):
            continue
        files = sorted(
            os.path.join(folder, f) for f in os.listdir(folder)
            if os.path.splitext(f)[1].lower() in IMAGE_EXT and not f.startswith(".")
        )
        if not files:
            continue
        if slug not in known_series():
            print("incoming/%s: not a known series, leaving files alone" % slug, file=sys.stderr)
            continue
        print("incoming/%s: %d file%s" % (slug, len(files), "" if len(files) == 1 else "s"))
        total += add(slug, files)
        for f in files:
            os.remove(f)
    print("processed %d photo%s from incoming/" % (total, "" if total == 1 else "s"))
    return total


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("series", nargs="?", help="series slug, e.g. concerts")
    ap.add_argument("files", nargs="*", help="image files to add")
    ap.add_argument("--place", help="caption shown under the frame, e.g. 'Brooklyn Steel'")
    ap.add_argument("--stock", help="film stock name from data/film_stocks.json, e.g. 'Kodak Portra 800'")
    ap.add_argument("--incoming", action="store_true", help="process incoming/<series>/ folders instead")
    args = ap.parse_args()

    if args.incoming:
        process_incoming()
    elif args.series and args.files:
        add(args.series, args.files, args.place, args.stock)
    else:
        ap.print_help()
        sys.exit(2)


if __name__ == "__main__":
    main()
