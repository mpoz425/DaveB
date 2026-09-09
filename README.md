# David Burton — home base

A static site for Dave: 35mm concert, travel and New York photography, the
**Worn on Tour** portrait project, the **If You Get Confused** newsletter, a
five-star "Reviewed" section, and his concert-venue bucket list.

No framework, no build tooling to install. Python 3 renders a handful of
templates into `dist/`, which you can drop onto Netlify, Vercel, GitHub Pages,
Cloudflare Pages, or any static host.

```
data/
  site.json      copy, status board, reviews, newsletter posts, bucket list, links
  photos.json    every photo (CDN URLs, dimensions, film stock, place) grouped by series
src/
  templates/     base.html (shell), index.html (home), gallery.html (one per series)
  css/style.css  the design system
  js/main.js     nav, rotating hero word, scroll reveals
  js/gallery.js  lightbox (keyboard, swipe, deep links like concerts.html#f12)
scripts/
  fetch_photos.py  optional: pull all photos local so the site stops depending on Adobe's CDN
build.py         renders everything into dist/
dist/            the deployable site (committed, so it can be deployed as-is)
```

## Build

```bash
python3 build.py          # photos load from the existing Adobe Portfolio CDN
python3 -m http.server -d dist 8000   # preview at http://localhost:8000
```

To self-host the images (recommended before the Adobe Portfolio is shut off):

```bash
python3 scripts/fetch_photos.py   # ~200 MB into dist/photos/
python3 build.py --local
```

## Editing content

Everything Dave will want to touch lives in `data/site.json`:

| Key | What it drives |
| --- | --- |
| `hero_words` | the rotating phrase after "Brooklyn guy who…" |
| `hero_intro` | the paragraph in the hero (currently in his own words from the newsletter) |
| `status` | the "Currently" board: listening / loaded / eating / running / reading / writing |
| `reviews` | the five-star cards. `stars` is 1–5 |
| `newsletter.posts` | recent issues shown on the home page (title, subtitle, date, url) |
| `bucket_list` | venues; flip `done` to `true` to check one off |
| `film_log.stocks` | the "What's in the bag" table |
| `links.email` | if set, adds an Email button in the contact section |
| `links.form_endpoint` | e.g. a Formspree URL. Until set, the form shows a friendly "not wired up yet" note |

Then run `python3 build.py` again.

### Adding photos

`data/photos.json` has one entry per series (`sets[]`) with a `photos[]` list.
Each photo needs `id`, `w`, `h`, `thumb` (≈600px), `med` (≈1200px), `full`
(≈1920px), and optionally `stock` (`{film, iso, format, lab}`) and `place`.
The `cover` index on each set picks the card image on the home page.
`STRIP_PICKS` and `WORN_PICKS` at the top of `build.py` choose the frames in
the homepage filmstrip and the Worn on Tour polaroid wall.

## Design notes

- Palette: warm near-black (unexposed film), cream type, Kodak yellow accent,
  stage-light magenta/cyan only as glow. One cream "paper" section for the reviews.
- Type: Archivo (variable width, used wide for the big names and narrow for
  section heads), Space Mono for film-edge markings and labels, Instrument Serif
  italic for asides, Caveat for Sharpie-on-a-contact-sheet notes.
- Motifs: sprocket-hole filmstrip, frame numbers (1, 1A, 2, 2A…), DX-style edge
  codes, polaroids for the portrait project, star ratings borrowed from his own
  year-in-review format.
- Grain: a very light animated SVG noise overlay; disabled with `prefers-reduced-motion`.

All copy on the site is grounded in Dave's own newsletter and portfolio
captions. Anything speculative is flagged in `data/site.json` comments-by-naming
(e.g. the Red Rocks bucket-list note).
