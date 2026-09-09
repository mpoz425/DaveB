# David Burton — home base

A static site for Dave: 35mm concert, travel and New York photography, the
**Worn on Tour** portrait project, the **If You Get Confused** newsletter, a
five-star "Reviewed" section, and his concert-venue bucket list.

No framework. Python 3 (standard library only) renders a handful of templates
into `dist/`. Vercel runs that build on every push to `main`, so the site
updates itself whenever content in `data/` changes.

## For Dave: editing the site

You never need to touch code. Everything on the site is edited through
**Pages CMS** at [app.pagescms.org](https://app.pagescms.org). Sign in, open
this repo, and you get a screen for each part of the site:

| Screen | What it changes |
| --- | --- |
| Currently (status board) | Listening / Loaded / Eating / Running / Reading / Writing |
| Reviewed (five-star cards) | The review cards. Stars are 1–5. |
| Venue bucket list | Venues. Flip "Been there" to check one off. |
| Film log | The "What's in the bag" table |
| Homepage photo picks | Which frames appear in the scrolling filmstrip and on the polaroid wall |
| Photos → Series | Title, kicker, blurb and cover frame for each roll |
| Photos → Concerts / Travel / … | Captions ("place") and film stock for every frame |
| Newsletter posts (backup list) | Only used if the Substack feed can't be reached |
| Site copy & links | Every other sentence: hero, section headings, handwritten notes, contact section, menu labels, links, footer |

Hit **Save** and the site redeploys on its own. Give it about a minute.

Things that take care of themselves:

- **Copyright year** in the footer. It reads "© 2020–<current year>" and the
  end year updates automatically. Change the start year under Site copy & links.
- **Newsletter posts** come straight from the Substack RSS feed at build time,
  and the site rebuilds every Monday so new issues show up without doing anything.
  The "Redeploy site" button in Pages CMS forces a rebuild right away.

### Adding photos

1. In Pages CMS open **Media → New photos (drop zone)**.
2. Go into the folder for the series (`concerts`, `travel`, `new-york-city`,
   `worn-on-tour`, `sports`) and upload your JPEGs. Full-size scans are fine.
3. Wait a couple of minutes. A GitHub Action resizes them (600 / 1200 / 1920 px,
   camera metadata stripped), adds them to the end of that series, clears the
   drop zone, and the site redeploys.
4. Optional: open **Photos → <series>** and add a caption or film stock to the new frames.

New photos are appended, so existing frame numbers (and the homepage picks that
point at them) don't move. If you delete a frame from the middle of a series,
the frames after it shift down by one; double-check the homepage picks afterwards.

## For developers

```
data/
  copy.json             all site-wide copy, links, menu labels, section headers
  status.json           the "Currently" board
  reviews.json          five-star cards
  bucket_list.json      venues
  film_stocks.json      the film log table (also the list of valid photo stocks)
  homepage.json         filmstrip frames + polaroid wall picks (1-based frame numbers)
  newsletter_posts.json fallback when the RSS feed is unreachable
  series.json           one entry per photo series (slug, title, blurb, cover frame…)
  photos/<slug>.json    the frames in each series, in display order
assets/photos/          self-hosted images as <id>_600.jpg / _1200.jpg / _1920.jpg (created on demand)
incoming/<slug>/        drop zone for new photos; emptied by the photos workflow
src/
  templates/            base.html (shell), index.html (home), gallery.html (one per series)
  css/style.css         the design system
  js/main.js            nav, rotating hero word, scroll reveals, live copyright year
  js/gallery.js         lightbox (keyboard, swipe, deep links like concerts.html#f12)
scripts/
  add_photos.py         resize + register photos (needs Pillow); also powers the workflow
  fetch_photos.py       pull the remaining Adobe-CDN photos into assets/photos/
.github/workflows/
  photos.yml            processes incoming/ on push
  redeploy.yml          weekly + Jan 1 + on-demand Vercel deploy hook
.pages.yml              Pages CMS screens and fields
vercel.json             build command + output directory for Vercel
build.py                renders everything into dist/ (git-ignored)
```

### Build locally

```bash
python3 build.py                      # fetches the newsletter feed
python3 build.py --no-fetch           # offline; uses data/newsletter_posts.json
python3 -m http.server -d dist 8000   # preview at http://localhost:8000
```

### Photos

A photo entry is `{id, w, h, place, stock, thumb, med, full}`. `w`/`h` are the
600px thumbnail's dimensions (aspect ratio only). If `assets/photos/<id>_600.jpg`
etc. exist, the build serves those and ignores the URLs; otherwise it uses the
`thumb`/`med`/`full` URLs (currently the old Adobe Portfolio CDN).

```bash
pip install pillow
python3 scripts/add_photos.py concerts ~/Desktop/roll-12/*.jpg --stock "Kodak Portra 800"
python3 scripts/add_photos.py --incoming          # what the GitHub Action runs
python3 scripts/fetch_photos.py                   # self-host everything still on the CDN (~200 MB)
```

Adding a **new series** is a dev task: add an entry to `data/series.json`, create
`data/photos/<slug>.json` (`[]`) and `incoming/<slug>/.gitkeep`, and add the slug
to the `series` select and a new photos file entry in `.pages.yml`.

### One-time setup checklist

1. **Vercel** — `vercel.json` sets the build command (`python3 build.py`) and
   output directory (`dist`), overriding whatever the project dashboard says.
   Nothing else to configure; pushes to `main` deploy. On any other host
   (Netlify, Cloudflare Pages, GitHub Pages) use the same build command and
   point the publish directory at `dist`, otherwise the root URL will 404.
2. **Deploy hook** — Vercel → Project → Settings → Git → Deploy Hooks → create
   one for `main`. Add its URL as a GitHub Actions secret named
   `VERCEL_DEPLOY_HOOK_URL`. This powers the weekly rebuild and the CMS
   "Redeploy site" button.
3. **Pages CMS** — sign in at [app.pagescms.org](https://app.pagescms.org) with
   the GitHub account that owns the repo, install the GitHub App on it, and open
   the repo. `.pages.yml` is already in place. Then invite Dave as a
   collaborator (Settings → Collaborators, by email) so he can edit without a
   GitHub account.
4. **GitHub Actions** — make sure Actions are enabled for the repo and that
   workflows have read/write permission (Settings → Actions → General →
   Workflow permissions).

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
