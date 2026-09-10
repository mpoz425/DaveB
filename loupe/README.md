# Loupe — matcher proof of concept

Loupe is an experiment in making any static site editable in place without
annotating templates. This directory contains the first piece: a **matcher**
that reads a site's structured content (JSON / YAML / TOML / Markdown front
matter and bodies) and its rendered HTML, and works out which source value
produced which piece of the page.

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
- **Save & rebuild** is the local loop: writes the edits into the working
  copy, re-runs the build and reloads. **Changes** shows the working-copy
  `git diff`.

Writes are surgical: JSON keeps its indentation, YAML is spliced by node
range so comments and blank lines survive, Markdown front matter and body
are rewritten separately. TOML is re-serialised (comments are lost). Edits
made inside items that were moved or added are re-indexed to where the
item ended up before they are applied.

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

- `serve.js` — dev server: build, match, annotate, inject overlay, apply
  patches, uploads, proposals, expose the diff.
- `src/patch.js` — apply `set` / `reorder` ops to JSON, YAML, TOML and
  Markdown files with minimal diffs (`reorder` entries may be an index,
  `{ copyOf }` or `{ blankFrom }`).
- `src/propose.js` — patch from HEAD into blobs, build a tree via a
  temporary index, commit on a new branch, push, open/link the PR.
- `src/paths.js` — `file#path` ref helpers.
- `overlay/overlay.js`, `overlay/overlay.css` — the in-page editor.

## Next

1. Hosting: run `serve.js` somewhere Dave can reach with a login in front,
   so proposals do not require a developer's machine.
2. Editor gaps: editing text nodes that mix several values; registering a
   dropped photo as a new gallery entry (needs the site's own `add_photos`
   step, so a per-site hook).
3. Matcher robustness: JS-rendered snapshot, date/number format probes,
   exclusion of trivial link values (`/`, `#`) from ambiguity reporting.
