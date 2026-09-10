# Loupe — matcher proof of concept

Loupe is an experiment in making any static site editable in place without
annotating templates. This directory contains the first piece: a **matcher**
that reads a site's structured content (JSON / YAML / TOML / Markdown front
matter and bodies, or `data/*.ts|js` modules) and its rendered HTML, and works
out which source value produced which piece of the page.

If the matcher works on sites we did not build, the rest of the product
(an in-page editing overlay that writes back to the content files as pull
requests) can be built once and reused for every site.

## Usage

```bash
cd loupe && npm install

node loupe/cli.js --content <dir|file> [--content ...] --output <built-site-dir> \
    [--write <annotated-dir>] [--verbose]
```

- `--content` may be given several times: a data directory, a content
  directory of Markdown files, a site config file, etc.
- `--output` is the built HTML.
- `--write` copies the HTML pages with `data-edit*` attributes added to every
  bound element (the hook the editing overlay will use).

Examples:

```bash
# Dave's site (control)
python3 build.py --no-fetch
node loupe/cli.js --content data --output dist --write /tmp/dave-annotated

# A Hugo theme example site we did not build
node loupe/cli.js --content hugo.yaml --content content --output public

# Eleventy
node loupe/cli.js --content content --output _site

# Jekyll
node loupe/cli.js --content _config.yml --content _data --content _posts --output _site
```

## Editing in place

```bash
node loupe/serve.js --content data --output dist \
    --build "python3 build.py --no-fetch" \
    --uploads assets/photos=/photos
# open http://localhost:4343/
```

The dev server runs the build, then serves every page matched, annotated and
overlaid with the editor:

- Click any bound text to edit it inline (Enter commits, Esc cancels). Values
  with line breaks or markup, and Markdown bodies, open in a side panel.
- Hover a list item for move / add / duplicate / delete, or drag items to
  reorder. "Add" inserts a fresh item shaped like its neighbour (strings
  emptied, booleans false) outlined in green; click its fields to fill it in.
- Click an image to change its `src` (and `alt` if bound); with `--uploads
  <dir>=<url>` you can drop a file onto the image or into the panel and it
  is written to `<dir>` and referenced as `<url>/<name>`.
- **Propose…** turns the pending edits into a commit on a new `loupe/*`
  branch built with git plumbing, so the working copy and HEAD are never
  touched. The branch is pushed to `--remote` (default `origin`); with
  `LOUPE_GITHUB_TOKEN` (or `GITHUB_TOKEN`) set the pull request is created
  directly, otherwise you get GitHub's pre-filled "open a pull request" link.
  The panel shows the changes as a redline before you confirm and the
  resulting diff afterwards. `--no-push` keeps the branch local.
- **Fields (N)** opens a drawer with every editable value that is rendered
  on *no* page at all — flags, URLs the build only follows, numbers used in
  logic, copy for pages that are not built. The server matches every page
  once per content change to work this out, so the list is exact rather than
  guessed. Fields are grouped by file (files that also appear on the current
  page first), and repeated array keys (`photos/*.json#*.med` × 144) fold
  into one expandable group. Edits here go through the same pending-ops path
  as in-place edits, so Save and Propose treat them identically.
- **Save & rebuild** is the local loop: writes the edits into the working
  copy, re-runs the build and reloads. **Changes** shows the basket of
  pending edits across the site (with per-edit undo) and the working-copy
  `git diff` below it.
- **Edits follow you around the site.** Pending edits are kept in
  `localStorage` per page and re-applied when you come back, so you can fix
  the nav on the homepage, a caption on a gallery page and a field in the
  drawer, then Save or Propose once. Links work in edit mode; Alt+click follows
  a link whose text is itself editable. Discard clears the whole session.
- **Right-click to correct the matcher.** *Change source…* / *Bind to a
  value…* opens a searchable picker over every editable value and pins the
  element to your choice; *Not content here* keeps an element out of matching
  on this page; *Never edit this value* ignores a ref everywhere; *Unpin*
  undoes a pin. These are written to `.loupe.json` in the project:

  ```json
  { "pin":    [{ "page": "/", "selector": "body > header span.brand__name", "ref": "data/copy.json#short_name" }],
    "ignore": [{ "ref": "data/copy.json#tagline" }, { "page": "/", "selector": ".ticker" }] }
  ```

  Pins are applied before anything the matcher would decide on its own and
  are outlined blue; `page` is optional. The file is included in proposals
  when it changed.
- **Proposals are verified.** When a `--build` command is known, the proposed
  commit is checked out in a throwaway worktree, built, and every page
  matched again; the panel and the pull request body report "build passed
  (0.1s, 6 pages); 2/3 edits render on the site" with the pages each edit
  appears on (values no page renders are labelled as fields). A failing
  build keeps the branch local instead of pushing it. `--no-verify` skips
  this.

Writes are surgical: JSON keeps its indentation, YAML is spliced by node
range so comments and blank lines survive, Markdown front matter and body
are rewritten separately. TOML is re-serialised (comments are lost). Edits
made inside items that were moved or added are re-indexed to where the
item ended up before they are applied.

### Content kept in code

Sites built with Next, Astro or Vite often keep their copy in
`data/site.ts` rather than in data files. Loupe evaluates such modules in a
child process (Node strips the type annotations itself; no TypeScript
toolchain is needed) and flattens the exports like any other content file,
with paths such as `data/site.ts#nav[1].name`. Edits replace the string
literal in the source, so the author's formatting and comments survive;
repeated literals are disambiguated by key and by their ordinal in
declaration order. Values that are not spelled out as literals (template
strings, `href: site.cvPath`) are marked computed and left read-only, and
lists in code cannot be reordered yet (they are flagged read-only in the
overlay).

### Framework dev servers

```bash
cd my-next-site && npm run dev            # http://localhost:3000
node loupe/serve.js --content data --output http://localhost:3000
# open http://localhost:4545/  (or whatever --port you pass)
```

When `--output` is a URL, Loupe proxies the running dev server (hot-reload
WebSocket included) and matches **in the browser** after the framework has
rendered, re-matching whenever the DOM changes. That covers client-rendered
content and means no `--build` is needed: saving writes the content file and
the framework reloads itself. The Fields drawer is not available in this
mode (there is no page list to scan). Verified on TessF (Next.js 13, three
`.ts` data modules): 35 refs bound on the homepage, edits to `site.ts` and
`content.ts` changed exactly the intended lines and hot-reloaded.

## What it does

1. **Loads content** and flattens it to leaf values with a path such as
   `data/status.json#[0].label`. Each leaf is classified (text, markdown,
   url, media, date, number, identifier, meta...). Identifiers, enum-like
   keys and framework metadata are excluded so they don't pollute matching.
2. **Indexes the DOM** of every page: attribute values, text nodes and
   whole-element text, under several normalisation tiers (exact, typographic
   folding, case/quote insensitive, Markdown stripped). Long Markdown bodies
   are matched by word containment against the smallest element that holds
   them.
3. **Resolves ambiguity.** When several leaves share a value, candidates are
   ranked by DOM proximity to already-bound siblings (same object, then same
   array, then same file) and, failing that, paired in document order when
   the page repeats the same block a whole number of times (e.g. a nav
   rendered twice).
4. **Detects lists.** If every child of a container binds to exactly one
   item of the same array, the container is tagged `data-edit-list` and the
   children `data-edit-item`, so items can be reordered / added / removed.
5. **Reports coverage**: how many editable text leaves bound uniquely, how
   many Markdown bodies bound, and what share of visible characters on each
   page is traceable to a source value.

## Results

| Site | Built with | Text leaves bound | Ambiguous | Markdown bodies | Page text coverage | Complete lists |
| --- | --- | --- | --- | --- | --- | --- |
| Dave's site (control) | own `build.py` | 219 / 229 (95.6%) | 0 | n/a | 87.3% (93.3% excl. aria-hidden) | 21 |
| [hugo-fresh](https://github.com/StefMa/hugo-fresh) example | Hugo, content in `hugo.yaml` params | 78 / 80 (97.5%) | 0 | 2 / 3 | 98.9% | 21 |
| [hugo-resume](https://github.com/eddiewebb/hugo-resume) example | Hugo, `data/*.json` + `config.toml` + Markdown | 142 / 159 (89.3%) | 6 | 11 / 15 | 73.4% | 32 |
| [eleventy-base-blog](https://github.com/11ty/eleventy-base-blog) | Eleventy, Markdown with YAML and JS front matter | 13 / 13 (100%) | 0 | 6 / 7 (7th is a draft, never rendered) | 56.5% | 2 |

The Hugo and Eleventy sites had never been seen by the matcher and required
zero annotation. Eleventy's `_data/metadata.js` is JavaScript, which the
loader deliberately does not evaluate, so its handful of site-wide strings
(title, author) are not candidates; that is most of the coverage gap on its
index and tag pages.

Markdown bodies bind either to a single wrapping element or, when the theme
renders them as sibling blocks straight into the layout, to a contiguous run
of siblings (`data-edit-rich-part="2/5"`). Bodies that share boilerplate
paragraphs (starter sites love duplicated lorem ipsum) are disambiguated by
word-overlap F1 and by whether the file's other fields, such as its title,
already bound on the page.

What remains unbound, and why:

- **Values rendered by JavaScript** (Dave's rotating hero words, form status
  copy). The matcher only sees server-rendered HTML. Fixable by matching
  against a headless-browser snapshot, or by binding to the inline script.
- **Values that never render** (a `title` used only for `<title>`
  de-duplication, a font name used in a CSS URL, config fields the theme
  ignores). Correctly unmatched.
- **Reformatted values** (`2019-01-01` rendered as `Jan 2019`). Needs a
  small set of date/number format probes.
- **True duplicates in the data** (hugo-resume has identical strings in
  different records); these are reported as ambiguous rather than guessed.
- **Aggregation pages** (tag lists, search, blog index) score low on coverage
  because most of their text is generated by the theme, not by content.
- **Content in executable files** (`_data/*.js`, `---js` front matter). The
  loader keeps the Markdown body but skips the data; evaluating it safely is
  a later problem.

## Layout

- `cli.js` — command line entry and report.
- `src/content.js` — loaders, front matter parsing, leaf classification.
- `src/normalize.js` — normalisation tiers.
- `src/match.js` — DOM indexing, matching, ambiguity resolution, list
  detection, annotation.

## Layout (editor)

- `serve.js` — dev server: build (queued, off the event loop), match,
  annotate, inject overlay, apply patches, uploads, proposals, overrides,
  expose the diff; or proxy a framework dev server.
- `src/patch.js` — apply `set` / `reorder` ops to JSON, YAML, TOML,
  Markdown and TS/JS module files with minimal diffs (`reorder` entries may
  be an index, `{ copyOf }` or `{ blankFrom }`).
- `src/propose.js` — patch from HEAD into blobs, build a tree via a
  temporary index, commit on a new branch, verify it in a worktree, push,
  open/link the PR.
- `src/paths.js` — `file#path` ref helpers.
- `overlay/overlay.js`, `overlay/overlay.css` — the in-page editor; session,
  basket, context menu.
- `overlay/client.js` — browser-side matcher runner for proxy mode.
- `.loupe.json` (in the site, not here) — pins and ignores.

## Next

1. Hosting: run `serve.js` somewhere Dave can reach with a login in front,
   so proposals do not require a developer's machine. The POST endpoints have
   no authentication today; that is fine on localhost and nothing else.
2. Editor gaps: editing text nodes that mix several values; reordering lists
   kept in code; registering a dropped photo as a new gallery entry (needs
   the site's own `add_photos` step, so a per-site hook).
3. Matcher robustness: date/number format probes, exclusion of trivial link
   values (`/`, `#`) from ambiguity reporting; TOML comment preservation.
