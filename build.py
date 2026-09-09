#!/usr/bin/env python3
"""
Build the static site into ./dist.

    python3 build.py              # normal build (fetches the newsletter feed)
    python3 build.py --no-fetch   # skip the network; use data/newsletter_posts.json

Everything editable lives in data/ (see README). Photos are served from
assets/photos/ when a local copy exists, otherwise from the URL in the photo
entry. No dependencies beyond the Python standard library.
"""
import argparse
import datetime
import email.utils
import glob
import html
import json
import os
import re
import shutil
import sys
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
DATA = os.path.join(ROOT, "data")
ASSETS_PHOTOS = os.path.join(ROOT, "assets", "photos")
DIST = os.path.join(ROOT, "dist")
SIZES = (600, 1200, 1920)


def warn(msg):
    print("warning: " + msg, file=sys.stderr)


def esc(s):
    return html.escape(str(s if s is not None else ""), quote=True)


def esc_br(s):
    """Escape, then turn line breaks into <br> (for headings edited as multi-line text)."""
    return "<br>".join(esc(line.strip()) for line in str(s or "").splitlines())


def esc_q(s):
    """Escape, then wrap "quoted phrases" in <q> so they get proper curly quotes."""
    return re.sub(r"&quot;(.+?)&quot;", r"<q>\1</q>", esc(s))


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)


def render(tpl, ctx):
    for k, v in ctx.items():
        tpl = tpl.replace("{{" + k + "}}", str(v))
    return tpl


def frame_label(i):
    n = i // 2 + 1
    return "%d%s" % (n, "A" if i % 2 else "")


def stars(n):
    n = max(1, min(5, int(n or 0)))
    return '<span class="stars" aria-label="%d out of 5 stars">%s%s</span>' % (
        n, "&#9733;" * n, '<span class="off">%s</span>' % ("&#9733;" * (5 - n)) if n < 5 else ""
    )


def copyright_years(start, year):
    try:
        start = int(start)
    except (TypeError, ValueError):
        start = None
    if start and start < year:
        return "%d&ndash;<span id=\"year\">%d</span>" % (start, year)
    return '<span id="year">%d</span>' % year


# ------------------------------------------------------------------ photos
def photo_urls(p):
    """Prefer a self-hosted copy in assets/photos/, fall back to the URLs in the entry."""
    local = ["photos/%s_%d.jpg" % (p["id"], s) for s in SIZES]
    if all(os.path.exists(os.path.join(ASSETS_PHOTOS, os.path.basename(l))) for l in local):
        return tuple(local)
    urls = (p.get("thumb"), p.get("med"), p.get("full"))
    if not all(urls):
        raise SystemExit("photo %s has no local files in assets/photos/ and no thumb/med/full URLs" % p["id"])
    return urls


def pick_frame(series, frame, what):
    """1-based frame number -> photo, with a forgiving fallback so a typo in the CMS can't break the build."""
    photos = series["photos"]
    try:
        idx = int(frame) - 1
    except (TypeError, ValueError):
        idx = -1
    if not 0 <= idx < len(photos):
        warn("%s: frame %r is not in %s (1-%d); using frame 1" % (what, frame, series["slug"], len(photos)))
        idx = 0
    return idx, photos[idx]


def load_series():
    series = load("series.json")
    for s in series:
        path = os.path.join(DATA, "photos", s["slug"] + ".json")
        s["photos"] = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []
        if not s["photos"]:
            warn("series %s has no photos (%s)" % (s["slug"], os.path.relpath(path, ROOT)))
        s["count"] = len(s["photos"])
    return [s for s in series if s["photos"]]


# -------------------------------------------------------------- newsletter
def fetch_posts(feed_url, limit, fallback, allow_network=True):
    """Pull recent issues from the Substack RSS feed; fall back to the hand-kept list."""
    if not allow_network or not feed_url:
        return fallback
    try:
        req = urllib.request.Request(feed_url, headers={"User-Agent": "Mozilla/5.0 (site build)"})
        with urllib.request.urlopen(req, timeout=15) as r:
            root = ET.fromstring(r.read())
    except Exception as e:  # noqa: BLE001
        warn("could not fetch newsletter feed (%s); using data/newsletter_posts.json" % e)
        return fallback
    posts = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if not title or not link:
            continue
        # Substack titles look like "If You Get Confused #068: Bob Weir's Legacy, To Me"
        m = re.match(r"^(?:.*?#\s*(\d+)\s*[:\-\u2013\u2014]\s*)?(.*)$", title)
        n, title = (m.group(1) or ""), m.group(2).strip()
        date = ""
        try:
            date = email.utils.parsedate_to_datetime(item.findtext("pubDate") or "").strftime("%b %Y")
        except Exception:  # noqa: BLE001
            pass
        posts.append({"n": n, "title": title, "sub": (item.findtext("description") or "").strip(), "date": date, "url": link})
        if len(posts) >= limit:
            break
    if not posts:
        warn("newsletter feed had no items; using data/newsletter_posts.json")
        return fallback
    return posts


# ------------------------------------------------------------------- build
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-fetch", action="store_true", help="don't hit the network for the newsletter feed")
    args = ap.parse_args()

    copy = load("copy.json")
    status = load("status.json")
    reviews = load("reviews.json")
    bucket_list = load("bucket_list.json")
    film_stocks = load("film_stocks.json")
    homepage = load("homepage.json")
    sets = load_series()
    if not sets:
        raise SystemExit("no photo series found in data/series.json")
    by_slug = {s["slug"]: s for s in sets}
    total = sum(s["count"] for s in sets)
    year = datetime.date.today().year
    links = copy["links"]
    nav = copy["nav"]
    nl = copy["newsletter"]
    worn_copy = copy["worn_on_tour"]
    film_log = copy["film_log"]

    posts = fetch_posts(nl.get("feed_url"), int(nl.get("max_posts") or 7), load("newsletter_posts.json"), not args.no_fetch)

    # Fresh dist.
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    shutil.copytree(os.path.join(SRC, "css"), os.path.join(DIST, "css"))
    shutil.copytree(os.path.join(SRC, "js"), os.path.join(DIST, "js"))
    if os.path.isdir(ASSETS_PHOTOS):
        shutil.copytree(ASSETS_PHOTOS, os.path.join(DIST, "photos"))

    write(os.path.join(DIST, "favicon.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#f4c542"/>'
          '<text x="32" y="41" text-anchor="middle" font-family="Space Mono, Menlo, monospace" font-weight="700" font-size="26" fill="#1b1600">%s</text></svg>\n'
          % esc("".join(w[0] for w in copy["name"].split()[:2]).upper()))

    base = read(os.path.join(SRC, "templates", "base.html"))

    def shell(title, description, content, og, body_class="", scripts="", home=""):
        return render(base, {
            "title": esc(title),
            "description": esc(description),
            "og_image": og,
            "content": content,
            "body_class": body_class,
            "scripts": scripts,
            "home": home,
            "cur_photos": 'aria-current="page"' if home else "",
            "name": esc(copy["name"]),
            "initials": esc("".join(w[0] for w in copy["name"].split()[:2]).upper()),
            "location": esc(copy["location"]),
            "nav_photos": esc(nav["photos"]),
            "nav_worn": esc(nav["worn"]),
            "nav_reviewed": esc(nav["reviewed"]),
            "nav_newsletter": esc(nav["newsletter"]),
            "nav_bucket": esc(nav["bucket"]),
            "nav_hi": esc(nav["hi"]),
            "copyright_years": copyright_years(copy.get("copyright_start"), year),
            "footer_line": esc(copy["footer_line"]),
            "newsletter": links["newsletter"],
            "instagram": links["instagram_worn"],
            "worn_handle": esc(worn_copy["handle"]),
        })

    # ------------------------------------------------------------------ index
    strip = []
    for pick in homepage.get("filmstrip", []):
        s = by_slug.get(pick.get("series"))
        if not s:
            warn("filmstrip: unknown series %r, skipping" % pick.get("series"))
            continue
        idx, p = pick_frame(s, pick.get("frame"), "filmstrip")
        thumb, med, full = photo_urls(p)
        strip.append(
            '<a class="frame" href="%s.html#f%d" aria-label="%s, frame %d">'
            '<img src="%s" width="%d" height="%d" alt="" loading="lazy" decoding="async">'
            '<span class="frame__n">%s</span><span class="frame__set">%s</span></a>'
            % (s["slug"], idx + 1, esc(s["title"]), idx + 1, med, p["w"], p["h"], frame_label(idx), esc(s["title"]))
        )
    strip_html = "\n    ".join(strip)

    edge_top = "".join("<span><b>KODAK</b> PORTRA 800 &nbsp; %d &nbsp; %dA</span>" % (i, i) for i in range(1, 12))
    edge_bottom = "".join("<span>135-36 &nbsp; T-MAX 3200 &nbsp; %d &nbsp; %dA</span>" % (i, i) for i in range(12, 24))

    status_items = "\n      ".join(
        '<div class="status__item"><dt class="mono">%s</dt><dd>%s</dd></div>' % (esc(i["label"]), esc(i["value"]))
        for i in status
    )

    cards = []
    for n, s in enumerate(sets, 1):
        cidx, cover = pick_frame(s, s.get("cover", 1), "cover for %s" % s["slug"])
        thumb, med, full = photo_urls(cover)
        stocks = sorted({p["stock"] for p in s["photos"] if p.get("stock")})
        meta = " · ".join(stocks) if stocks else ("35mm" if s["medium"] == "film" else "Digital")
        cards.append(
            '<a class="roll roll--%s reveal" href="%s.html">'
            '<img src="%s" srcset="%s 1200w, %s 1920w" sizes="(max-width: 900px) 100vw, 50vw" alt="%s" loading="%s" decoding="async">'
            '<div class="roll__top mono"><span class="n">Roll %02d &nbsp;·&nbsp; %d frames</span><span class="stock">%s</span></div>'
            '<div class="roll__body"><h3>%s</h3><p>%s</p><span class="roll__go mono">%s</span></div>'
            '</a>'
            % (esc(s["medium"]), s["slug"], med, med, full, esc(s["title"]), "eager" if n <= 2 else "lazy",
               n, s["count"], esc(meta), esc(s["title"]), esc(s["blurb"]), esc(copy["photos_section"]["card_cta"]))
        )

    polaroids = []
    worn = by_slug.get("worn-on-tour")
    if worn:
        for pick in homepage.get("polaroids", []):
            idx, p = pick_frame(worn, pick.get("frame"), "polaroid")
            thumb, med, full = photo_urls(p)
            polaroids.append(
                '<a class="polaroid" href="worn-on-tour.html#f%d"><img src="%s" alt="%s portrait %d" loading="lazy" decoding="async">'
                '<span class="hand">%s</span></a>' % (idx + 1, med, esc(worn_copy["title"]), idx + 1, esc(pick.get("caption", "")))
            )
    else:
        warn("no worn-on-tour series; polaroid wall will be empty")

    words = ["zero", "one", "two", "three", "four", "five"]
    review_cards = []
    for r in reviews:
        n = max(1, min(5, int(r.get("stars") or 0)))
        thing = r["thing"]
        verdict_name = thing if r.get("proper_noun") else (thing[:1].lower() + thing[1:])
        review_cards.append(
            '<article class="review"><h3 class="review__thing"><small>%s</small>%s</h3>%s<p class="review__note">%s</p>'
            '<div class="review__verdict">I give %s %s star%s.</div></article>'
            % (esc(copy["reviews_section"]["kicker"]), esc(thing), stars(n), esc(r["note"]),
               esc(verdict_name), words[n], "" if n == 1 else "s")
        )

    post_items = "\n        ".join(
        '<li class="post"><a href="%s" target="_blank" rel="noopener">'
        '<span class="post__n mono">%s</span>'
        '<span><h3 class="post__title">%s</h3><p class="post__sub">%s</p></span>'
        '<span class="post__date mono">%s</span></a></li>'
        % (esc(p["url"]), ("#" + esc(p["n"])) if p.get("n") else "", esc(p["title"]), esc(p.get("sub")), esc(p.get("date")))
        for p in posts
    )

    done = sum(1 for v in bucket_list if v.get("done"))
    bucket_items = "\n      ".join(
        '<li class="venue%s"><span class="check" aria-hidden="true"></span>'
        '<div><h3 class="venue__name">%s</h3><div class="venue__place mono">%s</div><p class="venue__note">%s</p></div>'
        '<span class="venue__status mono">%s</span></li>'
        % (" is-done" if v.get("done") else "", esc(v["venue"]), esc(v.get("place")), esc(v.get("note")),
           "Been" if v.get("done") else "Not yet")
        for v in bucket_list
    )

    film_rows = "\n          ".join(
        '<tr><td>%s</td><td class="iso">%s</td><td>%s</td><td class="use">%s</td></tr>'
        % (esc(f["name"]), esc(f.get("iso")), esc(f.get("type")), esc(f.get("used_for")))
        for f in film_stocks
    )

    contact = copy["contact"]
    email_button = ('<a class="btn" href="mailto:%s">Email</a>' % esc(links["email"])) if links.get("email") else ""
    if links.get("form_endpoint"):
        form_attrs = 'action="%s" method="POST"' % esc(links["form_endpoint"])
        form_note = contact["form_connected_note"]
    else:
        alert = json.dumps(contact["form_missing_alert"])[1:-1].replace("'", "\\'")
        form_attrs = 'data-demo="true" onsubmit="event.preventDefault(); alert(\'%s\')"' % esc(alert)
        form_note = contact["form_missing_note"]

    nl_title_words = nl["title"].split()
    nl_heading = "%s <em>%s</em>" % (esc(" ".join(nl_title_words[:-1])), esc(nl_title_words[-1])) if len(nl_title_words) > 1 else esc(nl["title"])

    index_tpl = read(os.path.join(SRC, "templates", "index.html"))
    index_html = render(index_tpl, {
        "name": esc(copy["name"]),
        "name_l1": esc(copy["name"].split()[0]),
        "name_l2": esc(" ".join(copy["name"].split()[1:])),
        "hero_frames": " &nbsp; ".join("%d &nbsp;%dA" % (i, i) for i in range(1, 7)),
        "hero_words_json": esc(json.dumps(copy["hero"]["words"])),
        "hero_word_0": esc(copy["hero"]["words"][0] if copy["hero"]["words"] else ""),
        "hero_intro": esc(copy["hero"]["intro"]),
        "hero_note": esc_br(copy["hero"]["note"]),
        "hero_scroll": esc(copy["hero"]["scroll_label"]),
        "total_frames": total,
        "location": esc(copy["location"]),
        "edge_top": edge_top,
        "edge_bottom": edge_bottom,
        "strip_frames": strip_html,
        "status_label": esc(copy["status_section"]["label"]),
        "status_note": esc(copy["status_section"]["note"]),
        "status_items": status_items,
        "photos_kicker": esc(copy["photos_section"]["kicker"]),
        "photos_heading": esc_br(copy["photos_section"]["heading"]),
        "photos_lede": esc(copy["photos_section"]["lede"]),
        "series_aside": "%d series &nbsp;·&nbsp; %d frames" % (len(sets), total),
        "series_cards": "\n      ".join(cards),
        "worn_kicker": esc(worn_copy["kicker"]),
        "worn_handle": esc(worn_copy["handle"]),
        "worn_title": esc(worn_copy["title"]),
        "worn_note": esc(worn_copy["note"]),
        "worn_quote": esc(worn_copy["quote"]),
        "worn_body": esc(worn_copy["body"]),
        "worn_cta": esc(worn_copy["cta"]),
        "worn_secondary_cta": esc(worn_copy["secondary_cta"]),
        "worn_polaroids": "\n      ".join(polaroids),
        "instagram": links["instagram_worn"],
        "reviews_kicker": esc(copy["reviews_section"]["kicker"]),
        "reviews_heading": esc_br(copy["reviews_section"]["heading"]),
        "reviews_intro": esc(copy["reviews_section"]["intro"]),
        "review_cards": "\n      ".join(review_cards),
        "review_source": esc(copy["reviews_section"]["source_url"]),
        "review_source_label": esc(copy["reviews_section"]["source_label"]),
        "nl_kicker": esc(nl["kicker"]),
        "nl_heading": nl_heading,
        "nl_title": esc(nl["title"]),
        "nl_subtitle": esc(nl["subtitle"]),
        "nl_origin": esc_q(nl["origin"]),
        "nl_subscribe_label": esc(nl["subscribe_label"]),
        "nl_archive_label": esc(nl["archive_label"]),
        "nl_footnote": esc(nl["footnote"]),
        "newsletter": links["newsletter"],
        "newsletter_subscribe": links["newsletter_subscribe"],
        "post_items": post_items,
        "bucket_kicker": esc(copy["bucket_section"]["kicker"]),
        "bucket_heading": esc_br(copy["bucket_section"]["heading"]),
        "bucket_intro": esc(copy["bucket_section"]["intro"]),
        "bucket_tally": "<b style='color:var(--yellow);font-weight:400'>%d</b> / %d checked off" % (done, len(bucket_list)),
        "bucket_items": bucket_items,
        "film_kicker": esc(film_log["kicker"]),
        "film_heading": esc_br(film_log["heading"]),
        "film_format": esc(film_log["format"]),
        "film_lab": esc(film_log["lab"]),
        "film_rows": film_rows,
        "contact_heading": esc(contact["heading"]),
        "contact_body": esc(contact["body"]),
        "contact_burrito": esc(contact["burrito_line"]),
        "contact_placeholder": esc(contact["message_placeholder"]),
        "email_button": email_button,
        "form_attrs": form_attrs,
        "form_note": esc(form_note),
    })

    og_set = by_slug.get("concerts", sets[0])
    og_cover = photo_urls(pick_frame(og_set, og_set.get("cover", 1), "og cover")[1])[1]
    write(os.path.join(DIST, "index.html"),
          shell(copy["page_title"], copy["meta_description"], index_html, og_cover, "home"))

    # --------------------------------------------------------------- galleries
    gal_tpl = read(os.path.join(SRC, "templates", "gallery.html"))
    for s in sets:
        shots = []
        for i, p in enumerate(s["photos"]):
            thumb, med, full = photo_urls(p)
            alt = "%s, frame %d%s" % (s["title"], i + 1, (" — " + p["place"]) if p.get("place") else "")
            shots.append(
                '<figure class="shot" style="--w:%d;--h:%d" data-full="%s" data-place="%s" data-stock="%s" data-alt="%s">'
                '<img src="%s" srcset="%s 600w, %s 1200w" sizes="(max-width: 720px) 50vw, 33vw" width="%d" height="%d" alt="%s" loading="%s" decoding="async">'
                '<figcaption class="shot__meta mono"><span class="shot__n">%s</span><span class="shot__place">%s</span></figcaption>'
                '</figure>'
                % (p["w"], p["h"], full, esc(p.get("place")), esc(p.get("stock")), esc(alt),
                   thumb, thumb, med, p["w"], p["h"], esc(alt), "eager" if i < 6 else "lazy",
                   frame_label(i), esc(p.get("place")))
            )
        stocks = sorted({p["stock"] for p in s["photos"] if p.get("stock")})
        if s["medium"] == "film":
            stocks_line = "Stock: <b>%s</b>" % esc(" · ".join(stocks)) if stocks else "Stock: <b>35mm, various</b>"
            lab_line = "Scanned by <b>%s</b>" % esc(film_log["lab_short"])
        else:
            stocks_line = "Shot <b>digital</b>"
            lab_line = esc(film_log["digital_line"])
        extra = ('<a href="%s" target="_blank" rel="noopener" style="color:var(--yellow)">%s on Instagram &rarr;</a>'
                 % (esc(s["instagram"]), esc(worn_copy["handle"]))) if s.get("instagram") else ""
        setnav = "\n      ".join(
            '<a href="%s.html"%s>%s<span class="mono">%d</span></a>'
            % (o["slug"], ' aria-current="page"' if o["slug"] == s["slug"] else "", esc(o["title"]), o["count"])
            for o in sets
        )
        content = render(gal_tpl, {
            "kicker": esc(s["kicker"]),
            "title": esc(s["title"]),
            "blurb": esc(s["blurb"]),
            "count": s["count"],
            "stocks_line": stocks_line,
            "lab_line": lab_line,
            "extra_link": extra,
            "setnav": setnav,
            "slug": s["slug"],
            "shots": "\n    ".join(shots),
        })
        cover = photo_urls(pick_frame(s, s.get("cover", 1), "cover for %s" % s["slug"])[1])[1]
        write(os.path.join(DIST, s["slug"] + ".html"),
              shell("%s — %s" % (s["title"], copy["name"]), s["blurb"], content, cover, "gallery",
                    '<script src="js/gallery.js" defer></script>', home="index.html"))

    local = len(glob.glob(os.path.join(ASSETS_PHOTOS, "*_600.jpg")))
    print("built %d pages into %s (%d frames, %d self-hosted, %d newsletter posts)" % (len(sets) + 1, DIST, total, local, len(posts)))


if __name__ == "__main__":
    main()
