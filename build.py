#!/usr/bin/env python3
"""
Build the static site into ./dist.

    python3 build.py            # photos served from Dave's existing CDN
    python3 build.py --local    # photos served from dist/photos (run scripts/fetch_photos.py first)

No dependencies beyond the Python standard library.
"""
import argparse
import html
import json
import os
import shutil
import datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
DIST = os.path.join(ROOT, "dist")

STRIP_PICKS = [  # (set slug, 0-based index) — frames for the homepage filmstrip
    ("concerts", 9), ("travel", 6), ("new-york-city", 21), ("worn-on-tour", 1),
    ("concerts", 13), ("travel", 17), ("new-york-city", 6), ("sports", 7),
    ("concerts", 44), ("travel", 11), ("new-york-city", 22), ("worn-on-tour", 10),
    ("concerts", 21), ("travel", 15), ("new-york-city", 10), ("concerts", 0),
]
WORN_PICKS = [(1, "Neil Young"), (10, "The Smiths"), (3, "Support Live Music"), (6, "no. 07"), (4, "no. 05"), (11, "no. 12")]


def esc(s):
    return html.escape(s or "", quote=True)


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def render(tpl, ctx):
    for k, v in ctx.items():
        tpl = tpl.replace("{{" + k + "}}", str(v))
    return tpl


def photo_urls(p, local):
    if local:
        return (
            "photos/%s_600.jpg" % p["id"],
            "photos/%s_1200.jpg" % p["id"],
            "photos/%s_1920.jpg" % p["id"],
        )
    return p["thumb"], p["med"], p["full"]


def frame_label(i):
    n = i // 2 + 1
    return "%d%s" % (n, "A" if i % 2 else "")


def stars(n):
    return '<span class="stars" aria-label="%d out of 5 stars">%s%s</span>' % (
        n, "&#9733;" * n, '<span class="off">%s</span>' % ("&#9733;" * (5 - n)) if n < 5 else ""
    )


def stock_short(stock):
    if not stock:
        return ""
    name = stock["film"]
    name = name.replace("Kodak Professional ", "Kodak ").replace("Arista.EDU ULTRA", "Arista EDU Ultra").replace("ULTRA MAX", "Ultra Max")
    return name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", action="store_true", help="use dist/photos/* instead of CDN URLs")
    args = ap.parse_args()

    site = json.load(open(os.path.join(ROOT, "data", "site.json"), encoding="utf-8"))
    photos = json.load(open(os.path.join(ROOT, "data", "photos.json"), encoding="utf-8"))
    sets = photos["sets"]
    by_slug = {s["slug"]: s for s in sets}
    total = sum(s["count"] for s in sets)
    year = datetime.date.today().year

    base = read(os.path.join(SRC, "templates", "base.html"))
    links = site["links"]

    # Clean dist but keep locally fetched photos.
    if os.path.isdir(DIST):
        for name in os.listdir(DIST):
            if name == "photos":
                continue
            p = os.path.join(DIST, name)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    shutil.copytree(os.path.join(SRC, "css"), os.path.join(DIST, "css"))
    shutil.copytree(os.path.join(SRC, "js"), os.path.join(DIST, "js"))

    write(os.path.join(DIST, "favicon.svg"),
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#f4c542"/>'
          '<text x="32" y="41" text-anchor="middle" font-family="Space Mono, Menlo, monospace" font-weight="700" font-size="26" fill="#1b1600">DB</text></svg>\n')

    def shell(title, description, content, og, body_class="", scripts="", home=""):
        return render(base, {
            "title": title,
            "description": esc(description),
            "og_image": og,
            "content": content,
            "body_class": body_class,
            "scripts": scripts,
            "home": home,
            "cur_photos": 'aria-current="page"' if home else "",
            "year": year,
            "footer_line": esc(site["footer_line"]),
            "newsletter": links["newsletter"],
            "instagram": links["instagram_worn"],
        })

    # ------------------------------------------------------------------ index
    strip = []
    for slug, idx in STRIP_PICKS:
        s = by_slug[slug]
        p = s["photos"][idx]
        thumb, med, full = photo_urls(p, args.local)
        strip.append(
            '<a class="frame" href="%s.html#f%d" aria-label="%s, frame %d">'
            '<img src="%s" width="%d" height="%d" alt="" loading="lazy" decoding="async">'
            '<span class="frame__n">%s</span><span class="frame__set">%s</span></a>'
            % (slug, idx + 1, esc(s["title"]), idx + 1, med, p["w"], p["h"], frame_label(idx), esc(s["title"]))
        )
    strip_html = "\n    ".join(strip)

    edge_top = "".join("<span><b>KODAK</b> PORTRA 800 &nbsp; %d &nbsp; %dA</span>" % (i, i) for i in range(1, 12))
    edge_bottom = "".join("<span>135-36 &nbsp; T-MAX 3200 &nbsp; %d &nbsp; %dA</span>" % (i, i) for i in range(12, 24))

    status_items = "\n      ".join(
        '<div class="status__item"><dt class="mono">%s</dt><dd>%s</dd></div>' % (esc(i["label"]), esc(i["value"]))
        for i in site["status"]
    )

    cards = []
    for n, s in enumerate(sets, 1):
        cover = s["photos"][s["cover"]]
        thumb, med, full = photo_urls(cover, args.local)
        stocks = sorted({stock_short(p["stock"]) for p in s["photos"] if p["stock"]})
        meta = " · ".join(stocks) if stocks else ("35mm" if s["medium"] == "film" else "Digital")
        cards.append(
            '<a class="roll roll--%s reveal" href="%s.html">'
            '<img src="%s" srcset="%s 1200w, %s 1920w" sizes="(max-width: 900px) 100vw, 50vw" alt="%s" loading="%s" decoding="async">'
            '<div class="roll__top mono"><span class="n">Roll %02d &nbsp;·&nbsp; %d frames</span><span class="stock">%s</span></div>'
            '<div class="roll__body"><h3>%s</h3><p>%s</p><span class="roll__go mono">Open the roll</span></div>'
            '</a>'
            % (s["medium"], s["slug"], med, med, full, esc(s["title"]), "eager" if n <= 2 else "lazy",
               n, s["count"], esc(meta), esc(s["title"]), esc(s["blurb"]))
        )

    worn = by_slug["worn-on-tour"]
    polaroids = []
    for idx, cap in WORN_PICKS:
        p = worn["photos"][idx]
        thumb, med, full = photo_urls(p, args.local)
        polaroids.append(
            '<a class="polaroid" href="worn-on-tour.html#f%d"><img src="%s" alt="Worn on Tour portrait %d" loading="lazy" decoding="async">'
            '<span class="hand">%s</span></a>' % (idx + 1, med, idx + 1, esc(cap))
        )

    reviews = "\n      ".join(
        '<article class="review"><h3 class="review__thing"><small>Reviewed</small>%s</h3>%s<p class="review__note">%s</p>'
        '<div class="review__verdict">I give %s %s star%s.</div></article>'
        % (esc(r["thing"]), stars(r["stars"]), esc(r["note"]),
           esc(r["thing"][0].lower() + r["thing"][1:]) if r["thing"] not in ("Anora",) else esc(r["thing"]),
           ["zero", "one", "two", "three", "four", "five"][r["stars"]], "" if r["stars"] == 1 else "s")
        for r in site["reviews"]
    )

    posts = "\n        ".join(
        '<li class="post"><a href="%s" target="_blank" rel="noopener">'
        '<span class="post__n mono">#%s</span>'
        '<span><h3 class="post__title">%s</h3><p class="post__sub">%s</p></span>'
        '<span class="post__date mono">%s</span></a></li>'
        % (p["url"], esc(p["n"]), esc(p["title"]), esc(p["sub"]), esc(p["date"]))
        for p in site["newsletter"]["posts"]
    )

    done = sum(1 for v in site["bucket_list"] if v["done"])
    bucket = "\n      ".join(
        '<li class="venue%s"><span class="check" aria-hidden="true"></span>'
        '<div><h3 class="venue__name">%s</h3><div class="venue__place mono">%s</div><p class="venue__note">%s</p></div>'
        '<span class="venue__status mono">%s</span></li>'
        % (" is-done" if v["done"] else "", esc(v["venue"]), esc(v["place"]), esc(v["note"]),
           "Been" if v["done"] else "Not yet")
        for v in site["bucket_list"]
    )

    film_rows = "\n          ".join(
        '<tr><td>%s</td><td class="iso">%d</td><td>%s</td><td class="use">%s</td></tr>'
        % (esc(f["name"]), f["iso"], esc(f["type"]), esc(f["used_for"]))
        for f in site["film_log"]["stocks"]
    )

    email_button = ('<a class="btn" href="mailto:%s">Email</a>' % esc(links["email"])) if links.get("email") else ""
    if links.get("form_endpoint"):
        form_attrs = 'action="%s" method="POST"' % esc(links["form_endpoint"])
        form_note = "Goes straight to my inbox. I read everything, I reply to most."
    else:
        form_attrs = 'data-demo="true" onsubmit="event.preventDefault(); alert(\'The form isn\\u2019t wired up yet. DM @worn.on.tour on Instagram or reply to any newsletter.\')"'
        form_note = "Form not connected yet. Instagram DM or a newsletter reply is fastest."

    index_tpl = read(os.path.join(SRC, "templates", "index.html"))
    index_html = render(index_tpl, {
        "hero_frames": " &nbsp; ".join("%d &nbsp;%dA" % (i, i) for i in range(1, 7)),
        "hero_words_json": esc(json.dumps(site["hero_words"])),
        "hero_word_0": esc(site["hero_words"][0]),
        "hero_intro": esc(site["hero_intro"]),
        "total_frames": total,
        "location": esc(site["location"]),
        "edge_top": edge_top,
        "edge_bottom": edge_bottom,
        "strip_frames": strip_html,
        "status_items": status_items,
        "series_aside": "%d series &nbsp;·&nbsp; %d frames" % (len(sets), total),
        "series_cards": "\n      ".join(cards),
        "worn_handle": esc(site["worn_on_tour"]["handle"]),
        "worn_title": esc(site["worn_on_tour"]["title"]),
        "worn_quote": esc(site["worn_on_tour"]["quote"]),
        "worn_body": esc(site["worn_on_tour"]["body"]),
        "worn_cta": esc(site["worn_on_tour"]["cta"]),
        "worn_polaroids": "\n      ".join(polaroids),
        "instagram": links["instagram_worn"],
        "reviews_intro": esc(site["reviews_intro"]),
        "review_cards": reviews,
        "review_source": "https://ifyougetconfused.substack.com/p/if-you-get-confused-067-2025-reviewed",
        "nl_subtitle": esc(site["newsletter"]["subtitle"]),
        "nl_origin": site["newsletter"]["origin"].replace('"If you get confused, listen to the music play."', '<q>If you get confused, listen to the music play.</q>'),
        "newsletter": links["newsletter"],
        "newsletter_subscribe": links["newsletter_subscribe"],
        "post_items": posts,
        "bucket_intro": esc(site["bucket_list_intro"]),
        "bucket_tally": "<b style='color:var(--yellow);font-weight:400'>%d</b> / %d checked off" % (done, len(site["bucket_list"])),
        "bucket_items": bucket,
        "film_format": esc(site["film_log"]["format"]),
        "film_lab": esc(site["film_log"]["lab"]),
        "film_rows": film_rows,
        "contact_heading": esc(site["contact"]["heading"]),
        "contact_body": esc(site["contact"]["body"]),
        "contact_burrito": esc(site["contact"]["burrito_line"]),
        "email_button": email_button,
        "form_attrs": form_attrs,
        "form_note": esc(form_note),
    })

    og_cover = photo_urls(by_slug["concerts"]["photos"][by_slug["concerts"]["cover"]], args.local)[1]
    write(os.path.join(DIST, "index.html"),
          shell("David Burton — film photography, live music, Brooklyn", site["meta_description"], index_html, og_cover, "home"))

    # --------------------------------------------------------------- galleries
    gal_tpl = read(os.path.join(SRC, "templates", "gallery.html"))
    for s in sets:
        shots = []
        for i, p in enumerate(s["photos"]):
            thumb, med, full = photo_urls(p, args.local)
            alt = "%s, frame %d%s" % (s["title"], i + 1, (" — " + p["place"]) if p.get("place") else "")
            shots.append(
                '<figure class="shot" style="--w:%d;--h:%d" data-full="%s" data-place="%s" data-stock="%s" data-alt="%s">'
                '<img src="%s" srcset="%s 600w, %s 1200w" sizes="(max-width: 720px) 50vw, 33vw" width="%d" height="%d" alt="%s" loading="%s" decoding="async">'
                '<figcaption class="shot__meta mono"><span class="shot__n">%s</span><span class="shot__place">%s</span></figcaption>'
                '</figure>'
                % (p["w"], p["h"], full, esc(p.get("place") or ""), esc(stock_short(p["stock"])), esc(alt),
                   thumb, thumb, med, p["w"], p["h"], esc(alt), "eager" if i < 6 else "lazy",
                   frame_label(i), esc(p.get("place") or ""))
            )
        stocks = sorted({stock_short(p["stock"]) for p in s["photos"] if p["stock"]})
        if s["medium"] == "film":
            stocks_line = "Stock: <b>%s</b>" % esc(" · ".join(stocks)) if stocks else "Stock: <b>35mm, various</b>"
            lab_line = "Scanned by <b>Nice Film Club</b>"
        else:
            stocks_line = "Shot <b>digital</b>"
            lab_line = "No lab, no waiting, less fun"
        extra = ('<a href="%s" target="_blank" rel="noopener" style="color:var(--yellow)">%s &rarr;</a>' % (s["instagram"], "@worn.on.tour on Instagram")) if s.get("instagram") else ""
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
        cover = photo_urls(s["photos"][s["cover"]], args.local)[1]
        write(os.path.join(DIST, s["slug"] + ".html"),
              shell("%s — David Burton" % s["title"], s["blurb"], content, cover, "gallery",
                    '<script src="js/gallery.js" defer></script>', home="index.html"))

    print("built %d pages into %s (%d frames, %s photos)" % (len(sets) + 1, DIST, total, "local" if args.local else "CDN"))


if __name__ == "__main__":
    main()
