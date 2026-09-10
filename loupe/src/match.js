// Core matcher. DOM-agnostic: works on any standards-compliant `document`
// (jsdom at build time, the real DOM at runtime).
import { strict, loose, caseless, stripMarkdown, words, looksLikeMarkdown } from "./normalize.js";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "svg"]);
const ATTRS = ["alt", "title", "placeholder", "aria-label", "content", "href", "src", "value", "datetime"];
const MATCHABLE = new Set(["text", "url", "link", "media", "date", "number", "email", "phone", "markdown"]);
const PARTIAL_MIN = 6;

function quoteless(s) {
  return caseless(s).replace(/["'“”‘’«»]/g, "");
}

const TIERS = [
  ["strict", strict],
  ["loose", loose],
  ["caseless", (s) => (loose(s).length >= 8 ? quoteless(s) : null)],
  ["markdown", (s) => (looksLikeMarkdown(s) || /[*_`[\]]/.test(s) ? quoteless(stripMarkdown(s)) : null)],
];

function depth(n) {
  let d = 0;
  while ((n = n.parentNode)) d++;
  return d;
}

function lca(a, b) {
  const seen = new Set();
  for (let n = a; n; n = n.parentNode) seen.add(n);
  for (let n = b; n; n = n.parentNode) if (seen.has(n)) return n;
  return null;
}

function distance(a, b) {
  const l = lca(a, b);
  return l ? depth(a) + depth(b) - 2 * depth(l) : Infinity;
}

// textContent, but <br> becomes a newline so multi-line headings can match.
function textWithBreaks(el) {
  let out = "";
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3) out += n.nodeValue;
    else if (n.nodeType === 1) {
      if (SKIP_TAGS.has(n.tagName)) return;
      out += n.tagName === "BR" ? "\n" : textWithBreaks(n);
    }
  });
  return out;
}

function isHidden(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    if (n.getAttribute("aria-hidden") === "true" || n.hasAttribute("hidden")) return true;
  }
  return false;
}

function objectContext(path) {
  return path.replace(/\.[^.[\]]+$/, "");
}

export function buildIndex(leaves) {
  const idx = new Map(TIERS.map(([t]) => [t, new Map()]));
  for (const leaf of leaves) {
    if (!MATCHABLE.has(leaf.type)) continue;
    const s = String(leaf.value);
    if (leaf.type === "number" && s.length < 2) continue;
    if (leaf.type === "markdown" && words(s).length >= 30) continue; // long bodies go through matchRich
    const add = (tier, key) => {
      if (!key) return;
      const m = idx.get(tier);
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(leaf);
    };
    for (const [tier, fn] of TIERS) add(tier, fn(s));
    if (leaf.type === "email") add("strict", "mailto:" + s);
    if (leaf.type === "phone") { add("strict", "tel:" + s); add("strict", "tel:" + s.replace(/[^\d+]/g, "")); }
  }
  return idx;
}

function lookup(idx, text) {
  for (const [tier, fn] of TIERS) {
    // DOM text has no Markdown to strip, so use the caseless key on the markdown tier.
    const key = tier === "markdown" ? (loose(text).length >= 3 ? quoteless(text) : null) : fn(text);
    if (!key) continue;
    const hit = idx.get(tier).get(key);
    if (hit) return { tier, leaves: hit };
  }
  return null;
}

// Rich values (Markdown bodies, multi-paragraph fields) render as several block
// elements. Find the smallest element whose words contain nearly all of the
// value's words.
function matchRich(elements, richLeaves, bindings, boundLeaves) {
  if (!richLeaves.length) return;
  const elWords = new Map();
  const wordsOf = (el) => {
    if (!elWords.has(el)) elWords.set(el, words(textWithBreaks(el)));
    return elWords.get(el);
  };
  // Score every (leaf, region) pair by F1 of word overlap so that a body which
  // is a strict subset of another (shared boilerplate paragraphs) still binds
  // to its own page, then assign greedily without letting regions overlap.
  const candidates = [];
  // Inline HTML, image syntax and link targets never show up as page text.
  const visibleWords = (s) =>
    words(
      String(s)
        .replace(/<[^>]+>/g, " ")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\]\([^)]*\)/g, "]"),
    );
  for (const leaf of richLeaves) {
    const need = visibleWords(leaf.value);
    if (need.length < 5) continue;
    const needSet = new Set(need);
    const short = need.length < 12;
    const minLen = need.length * 0.8;
    const maxLen = need.length * (short ? 1.5 : 2.5);
    const consider = (have, el, span) => {
      if (have.length < minLen || have.length > maxLen) return;
      const haveSet = new Set(have);
      let hit = 0;
      for (const w of needSet) if (haveSet.has(w)) hit++;
      const recall = hit / needSet.size;
      const precision = hit / haveSet.size;
      if (recall < (short ? 1 : 0.9)) return;
      const f1 = (2 * precision * recall) / (precision + recall);
      if (f1 < 0.8) return;
      candidates.push({ leaf, el, span, nodes: span || [el], size: have.length, recall, f1 });
    };
    for (const el of elements) consider(wordsOf(el), el);
    // A body often renders as sibling blocks (h1, p, p...) with no wrapper of its
    // own, next to layout chrome. Try contiguous runs of element children.
    for (const el of elements) {
      const kids = Array.from(el.children);
      if (kids.length < 2) continue;
      for (let i = 0; i < kids.length; i++) {
        let have = [];
        for (let j = i; j < kids.length; j++) {
          have = have.concat(wordsOf(kids[j]));
          if (have.length > maxLen) break;
          if (j > i) consider(have, el, kids.slice(i, j + 1));
        }
      }
    }
  }
  // Tie-break near-identical bodies (starter sites love duplicated lorem ipsum)
  // by whether the file's other fields, e.g. its title, already bound on this page.
  const filesOnPage = new Set(bindings.filter((b) => b.leaves.length === 1).map((b) => b.leaves[0].file));
  const score = (c) => c.f1 + (filesOnPage.has(c.leaf.file) ? 0.05 : 0);
  candidates.sort((a, b) => score(b) - score(a) || a.size - b.size);
  const used = [];
  const overlaps = (nodes) => used.some((u) => nodes.some((n) => u.contains(n) || n.contains(u)));
  for (const c of candidates) {
    if (boundLeaves.has(c.leaf) || overlaps(c.nodes)) continue;
    bindings.push({ kind: "rich", el: c.el, span: c.span, leaves: [c.leaf], tier: "rich", text: `${Math.round(c.recall * 100)}% of words` });
    boundLeaves.add(c.leaf);
    used.push(...c.nodes);
  }
}

export function match(document, leaves, bodies = []) {
  const idx = buildIndex(leaves.concat(bodies));
  const root = document.body || document.documentElement;
  const bindings = []; // { kind, node, el, attr, leaves, tier, text }
  const boundLeaves = new Set();
  const boundTextNodes = new Set();

  // 1. Text nodes and attributes.
  const textNodes = [];
  const elements = [];
  const visit = (el) => {
    if (SKIP_TAGS.has(el.tagName)) return;
    elements.push(el);
    if (el.attributes) {
      for (const { name: a, value: v } of el.attributes) {
        if (!ATTRS.includes(a) && !a.startsWith("data-")) continue;
        if (!v || !strict(v)) continue;
        const hit = lookup(idx, v);
        if (hit) bindings.push({ kind: "attr", el, attr: a, leaves: hit.leaves, tier: hit.tier, text: v });
      }
    }
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) {
        const t = strict(n.nodeValue);
        if (t) textNodes.push({ node: n, text: t, el });
      } else if (n.nodeType === 1) visit(n);
    });
  };
  if (document.head) {
    const title = document.head.querySelector("title");
    if (title) visit(title);
    document.head.querySelectorAll("meta[content]").forEach(visit);
  }
  visit(root);

  for (const tn of textNodes) {
    const hit = lookup(idx, tn.text);
    if (hit) {
      bindings.push({ kind: "text", node: tn.node, el: tn.el, leaves: hit.leaves, tier: hit.tier, text: tn.text });
      boundTextNodes.add(tn.node);
    }
  }

  // 2. Element-level matches (value split across inline children or <br>).
  for (const el of elements.slice().reverse()) {
    if (!el.firstElementChild) continue;
    const t = strict(textWithBreaks(el));
    if (!t || t.length < 3) continue;
    const hit = lookup(idx, t);
    if (!hit) continue;
    const already = bindings.some((b) => b.kind === "text" && el.contains(b.node) && b.leaves.some((l) => hit.leaves.includes(l)));
    if (already) continue;
    bindings.push({ kind: "element", el, leaves: hit.leaves, tier: hit.tier, text: t });
    el.querySelectorAll("*").forEach((d) => d.childNodes.forEach((n) => n.nodeType === 3 && boundTextNodes.add(n)));
    el.childNodes.forEach((n) => n.nodeType === 3 && boundTextNodes.add(n));
  }

  // 2b. Rich values: Markdown bodies and fields that render as several blocks.
  const richLeaves = bodies.concat(leaves.filter((l) => l.type === "markdown" || (l.type === "text" && looksLikeMarkdown(l.value))))
    .filter((l) => !bindings.some((b) => b.leaves.includes(l)));
  matchRich(elements, richLeaves, bindings, boundLeaves);

  // 3. Resolve ambiguity (same value, different paths) by proximity to already
  // bound fields from the same object, then the same array, then the same file.
  for (const b of bindings) if (b.leaves.length === 1) boundLeaves.add(b.leaves[0]);
  const anchors = bindings.filter((b) => b.leaves.length === 1);
  const contexts = [
    (p) => objectContext(p),
    (p) => p.replace(/\[\d+\].*$/, ""),
    () => "",
  ];
  for (const b of bindings) {
    if (b.leaves.length === 1) continue;
    const node = b.node || b.el;
    let best = null;
    for (const ctxOf of contexts) {
      const scored = [];
      for (const leaf of b.leaves) {
        const ctx = ctxOf(leaf.path);
        const siblings = anchors.filter((a) => a.leaves[0].file === leaf.file && a.leaves[0] !== leaf && ctxOf(a.leaves[0].path) === ctx);
        if (!siblings.length) continue;
        scored.push({ leaf, d: Math.min(...siblings.map((a) => distance(node, a.node || a.el))) });
      }
      if (!scored.length) continue;
      scored.sort((x, y) => x.d - y.d);
      if (scored.length === 1 || scored[0].d < scored[1].d) best = scored[0];
      break;
    }
    if (best) {
      b.leaves = [best.leaf];
      b.resolved = "proximity";
      boundLeaves.add(best.leaf);
    } else {
      b.ambiguous = true;
    }
  }
  // Same value, several places, no sibling context (e.g. three "Dropdown item"
  // entries): if the DOM has exactly as many occurrences as the data, pair them
  // in document order. Lower confidence, so it's flagged.
  const groups = new Map();
  for (const b of bindings) if (b.ambiguous) {
    if (!groups.has(b.leaves)) groups.set(b.leaves, []);
    groups.get(b.leaves).push(b);
  }
  for (const [leafSet, bs] of groups) {
    // Allow whole multiples: a nav rendered twice (desktop + mobile) shows 2n occurrences of n values.
    if (bs.length % leafSet.length !== 0) continue;
    bs.sort((x, y) => {
      const nx = x.node || x.el, ny = y.node || y.el;
      return nx === ny ? 0 : nx.compareDocumentPosition(ny) & 4 ? -1 : 1; // 4 = DOCUMENT_POSITION_FOLLOWING
    });
    bs.forEach((b, i) => {
      const leaf = leafSet[i % leafSet.length];
      b.leaves = [leaf];
      b.ambiguous = false;
      b.resolved = "order";
      boundLeaves.add(leaf);
    });
  }

  // 4. Partial matches: a leaf embedded in a larger, otherwise unbound text node.
  const remaining = leaves.filter((l) => l.type === "text" && loose(String(l.value)).length >= PARTIAL_MIN);
  for (const tn of textNodes) {
    if (boundTextNodes.has(tn.node)) continue;
    const hay = loose(tn.text);
    for (const leaf of remaining) {
      const needle = loose(String(leaf.value));
      if (hay.includes(needle) && (needle.length >= 12 || hay.length <= needle.length * 3)) {
        bindings.push({ kind: "partial", node: tn.node, el: tn.el, leaves: [leaf], tier: "loose", text: tn.text });
        boundLeaves.add(leaf);
      }
    }
  }

  // 5. Lists. An array item can be rendered in several places on one page (a
  // photo in the filmstrip, as a cover, and in its gallery), so we can't take
  // one LCA per item. Instead, look for container elements whose children each
  // hold bindings from exactly one item; the same array may form several lists.
  const lists = [];
  const byArray = new Map();
  for (const b of bindings) {
    if (b.ambiguous) continue;
    const leaf = b.leaves[0];
    const m = leaf.path.match(/^(.*?)\[(\d+)\]/);
    if (!m) continue;
    const key = `${leaf.file}#${m[1]}`;
    if (!byArray.has(key)) byArray.set(key, []);
    const node = b.node || b.el;
    byArray.get(key).push({ el: node.nodeType === 3 ? node.parentNode : node, i: Number(m[2]), weak: leaf.type === "number" });
  }
  for (const [key, occurrences] of byArray) {
    const itemCount = new Set(occurrences.map((o) => o.i)).size;
    if (itemCount < 2) continue;
    // ancestor -> (child on the path -> { items: Set<index>, strong: bool })
    const table = new Map();
    for (const { el, i, weak } of occurrences) {
      for (let child = el, anc = el.parentNode; anc && anc.nodeType === 1; child = anc, anc = anc.parentNode) {
        if (!table.has(anc)) table.set(anc, new Map());
        const kids = table.get(anc);
        if (!kids.has(child)) kids.set(child, { items: new Set(), strong: false });
        const k = kids.get(child);
        k.items.add(i);
        if (!weak) k.strong = true;
      }
    }
    const candidates = [];
    for (const [container, kids] of table) {
      if (kids.size < 2) continue;
      // A child that mixes items is not an item boundary; a child anchored only by a bare number is noise.
      if ([...kids.values()].some((k) => k.items.size !== 1 || !k.strong)) continue;
      const items = new Map();
      let duplicated = false;
      for (const [child, k] of kids) {
        const i = [...k.items][0];
        if (items.has(i)) duplicated = true;
        else items.set(i, child);
      }
      if (items.size < 2) continue;
      candidates.push({ container, items, duplicated, coverage: items.size });
    }
    // Prefer the deepest container; drop ancestors of a candidate with equal coverage.
    const kept = candidates.filter((c) => !candidates.some((o) => o !== c && c.container !== o.container && c.container.contains(o.container) && o.coverage >= c.coverage));
    for (const c of kept) {
      lists.push({ key, items: c.items, container: c.container, regular: true, duplicated: c.duplicated, coverage: c.coverage, of: itemCount });
    }
  }

  // 6. Page coverage: how much of the visible text is now bound to a source.
  let total = 0, bound = 0, decorative = 0;
  for (const tn of textNodes) {
    if (tn.el.closest && tn.el.closest("title, head")) continue;
    const len = tn.text.length;
    total += len;
    if (isHidden(tn.el)) decorative += len;
    if (boundTextNodes.has(tn.node) || bindings.some((b) => b.kind === "rich" && (b.span || [b.el]).some((e) => e.contains(tn.node)))) bound += len;
    else {
      const partial = bindings.filter((b) => b.kind === "partial" && b.node === tn.node);
      for (const p of partial) bound += Math.min(len, loose(String(p.leaves[0].value)).length);
    }
  }

  return { bindings, lists, boundLeaves, page: { totalChars: total, boundChars: bound, decorativeChars: decorative } };
}

export function annotate(document, result) {
  const ref = (leaf) => `${leaf.file}#${leaf.path}`;
  for (const b of result.bindings) {
    const el = b.kind === "text" || b.kind === "partial" ? b.node.parentNode : b.el;
    if (!el || el.nodeType !== 1) continue;
    if (b.ambiguous) {
      el.setAttribute("data-edit-ambiguous", b.leaves.map(ref).join(" "));
      continue;
    }
    const r = ref(b.leaves[0]);
    if (b.kind === "attr") el.setAttribute(`data-edit-attr-${b.attr}`, r);
    else if (b.kind === "rich" && b.span) {
      b.span.forEach((part, i) => {
        part.setAttribute("data-edit-rich", r);
        part.setAttribute("data-edit-rich-part", `${i + 1}/${b.span.length}`);
      });
      continue;
    } else if (b.kind === "rich") el.setAttribute("data-edit-rich", r);
    else if (b.kind === "partial") el.setAttribute("data-edit-partial", ((el.getAttribute("data-edit-partial") || "") + " " + r).trim());
    else el.setAttribute("data-edit", r);
    if (b.tier !== "strict") el.setAttribute("data-edit-tier", b.tier);
    if (b.resolved) el.setAttribute("data-edit-resolved", b.resolved);
  }
  for (const list of result.lists) {
    if (list.container) list.container.setAttribute("data-edit-list", list.key);
    for (const [i, el] of list.items) if (el && el.setAttribute) el.setAttribute("data-edit-item", `${list.key}[${i}]`);
  }
}
