// Apply edits coming from the overlay to the content files on disk.
//
// ops:
//   { op: "set",     ref: "data/copy.json#hero.title", value: "..." }
//   { op: "reorder", ref: "data/reviews.json#",        order: [2, 0, { copyOf: 1 }, 3] }
//
// "reorder" rebuilds an array from the listed original indices; entries that
// are missing are removed, { copyOf } entries are deep copies and { blankFrom }
// entries are copies with every string emptied (a fresh item shaped like an
// existing one), so one op expresses any combination of move / delete /
// duplicate / add the overlay produced.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import TOML from "@iarna/toml";
import { splitRef, parsePath, getIn, setIn } from "./paths.js";
import { MODULE_EXT, loadModule, spellings, walk, sourceOrder } from "./content.js";
import os from "node:os";

const FRONT = /^(---|\+\+\+)(\w*)\r?\n([\s\S]*?)\r?\n\1\r?\n?([\s\S]*)$/;

function coerce(oldValue, value) {
  if (typeof oldValue === "number" && typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  if (typeof oldValue === "boolean" && typeof value === "string") return value === "true";
  return value;
}

function blank(v) {
  if (typeof v === "string") return "";
  if (typeof v === "boolean") return false;
  if (Array.isArray(v)) return [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x)]));
  return v;
}

function orderIndex(o) {
  return typeof o === "object" ? (o.copyOf ?? o.blankFrom) : o;
}

function derive(o, value) {
  if (typeof o !== "object") return value;
  return "blankFrom" in o ? blank(structuredClone(value)) : structuredClone(value);
}

function reorderPlain(arr, order) {
  if (!Array.isArray(arr)) throw new Error("reorder target is not an array");
  return order.map((o) => {
    const i = orderIndex(o);
    if (!(i in arr)) throw new Error(`reorder index ${i} out of range`);
    return derive(o, arr[i]);
  });
}

function applyToPlain(data, tokens, op) {
  if (op.op === "set") {
    setIn(data, tokens, coerce(getIn(data, tokens), op.value));
  } else if (op.op === "reorder") {
    const arr = tokens.length ? getIn(data, tokens) : data;
    const next = reorderPlain(arr, op.order);
    if (tokens.length) setIn(data, tokens, next);
    else {
      arr.length = 0;
      arr.push(...next);
    }
  } else throw new Error(`unknown op ${op.op}`);
}

function applyToYamlDoc(doc, tokens, op) {
  if (op.op === "set") {
    const old = doc.getIn(tokens);
    doc.setIn(tokens, coerce(old, op.value));
  } else if (op.op === "reorder") {
    const seq = tokens.length ? doc.getIn(tokens, true) : doc.contents;
    if (!YAML.isSeq(seq)) throw new Error("reorder target is not a sequence");
    const items = seq.items;
    seq.items = op.order.map((o) => {
      const i = orderIndex(o);
      if (!(i in items)) throw new Error(`reorder index ${i} out of range`);
      return typeof o === "object" ? doc.createNode(derive(o, YAML.isNode(items[i]) ? items[i].toJSON() : items[i])) : items[i];
    });
  } else throw new Error(`unknown op ${op.op}`);
}

function detectJsonIndent(raw) {
  let best = null;
  for (const m of raw.matchAll(/^([ \t]+)\S/gm)) if (best === null || m[1].length < best.length) best = m[1];
  return best ?? 2;
}

function writeJson(file, raw, ops) {
  const data = JSON.parse(raw);
  for (const { tokens, op } of ops) applyToPlain(data, tokens, op);
  return JSON.stringify(data, null, detectJsonIndent(raw)) + (raw.endsWith("\n") ? "\n" : "");
}

// The yaml library's round trip moves comments and blank lines around, which
// would turn a one-word edit into a 200-line diff. Splice the source text
// using node ranges instead, and only fall back to a full re-serialisation
// for shapes that are awkward to splice (multi-line scalars, flow sequences).
function spliceYaml(raw, tokens, op) {
  const doc = YAML.parseDocument(raw);
  if (op.op === "set") {
    const node = tokens.length ? doc.getIn(tokens, true) : null;
    if (!YAML.isScalar(node) || !node.range) return null;
    const value = coerce(node.value, op.value);
    if (typeof value === "string" && /\n/.test(value)) return null;
    const tmp = doc.createNode(value);
    if (YAML.isScalar(tmp) && node.type !== YAML.Scalar.BLOCK_LITERAL && node.type !== YAML.Scalar.BLOCK_FOLDED) tmp.type = node.type;
    let text = YAML.stringify(tmp, { lineWidth: 0 }).trimEnd();
    if (/\n/.test(text)) return null;
    return raw.slice(0, node.range[0]) + text + raw.slice(node.range[1]);
  }
  if (op.op === "reorder") {
    const seq = tokens.length ? doc.getIn(tokens, true) : doc.contents;
    if (!YAML.isSeq(seq) || seq.flow || !seq.items.length || !seq.items.every((it) => YAML.isNode(it) && it.range)) return null;
    // Each item slice runs from the start of its value to the start of the next
    // item's value, so it carries the separator ("\n  - ") that follows it.
    const starts = seq.items.map((it) => it.range[0]);
    const end = seq.range[2];
    const slices = starts.map((s, i) => raw.slice(s, i + 1 < starts.length ? starts[i + 1] : end));
    const sepOf = (i) => (i + 1 < starts.length ? raw.slice(seq.items[i].range[2], starts[i + 1]) : null);
    const seps = new Set(slices.map((_, i) => sepOf(i)).filter((s) => s !== null));
    if (seps.size > 1) return null;
    const sep = seps.size ? [...seps][0] : null;
    const valueOf = (i) => raw.slice(seq.items[i].range[0], seq.items[i].range[2]);
    if (op.order.some((o) => typeof o === "object" && "blankFrom" in o)) return null; // needs re-serialisation
    const parts = op.order.map((o) => {
      const i = orderIndex(o);
      if (!(i in seq.items)) throw new Error(`reorder index ${i} out of range`);
      return valueOf(i);
    });
    if (!parts.length) return null;
    if (parts.length > 1 && sep === null) return null;
    return raw.slice(0, starts[0]) + parts.join(sep ?? "") + raw.slice(seq.items[seq.items.length - 1].range[2]);
  }
  return null;
}

function writeYaml(raw, ops) {
  let text = raw;
  for (const { tokens, op } of ops) {
    const spliced = spliceYaml(text, tokens, op);
    if (spliced !== null) {
      text = spliced;
      continue;
    }
    const doc = YAML.parseDocument(text);
    applyToYamlDoc(doc, tokens, op);
    text = doc.toString({ lineWidth: 0 });
  }
  return text;
}

function writeToml(raw, ops) {
  const data = TOML.parse(raw);
  for (const { tokens, op } of ops) applyToPlain(data, tokens, op);
  return TOML.stringify(data);
}

function writeMarkdown(raw, ops) {
  const m = raw.match(FRONT);
  let fence = m ? m[1] : "---", lang = m ? m[2] : "", front = m ? m[3] : null, body = m ? m[4] : raw;
  const bodyOps = ops.filter((o) => o.tokens[0] === "body");
  const frontOps = ops.filter((o) => o.tokens[0] !== "body");
  for (const { op } of bodyOps) {
    if (op.op !== "set") throw new Error("only set is supported on body");
    body = String(op.value).replace(/\r\n/g, "\n");
    if (!body.endsWith("\n")) body += "\n";
  }
  if (frontOps.length) {
    if (front === null) throw new Error("file has no front matter");
    if (lang === "js" || lang === "javascript") throw new Error("JavaScript front matter is not editable");
    if (fence === "+++" || lang === "toml") front = writeToml(front, frontOps).replace(/\n$/, "");
    else if (lang === "json") {
      const data = JSON.parse(front);
      for (const { tokens, op } of frontOps) applyToPlain(data, tokens, op);
      front = JSON.stringify(data, null, detectJsonIndent(front));
    } else front = writeYaml(front, frontOps).replace(/\n$/, "");
  }
  return front === null ? body : `${fence}${lang}\n${front}\n${fence}\n${body}`;
}

// Content modules (data/site.ts). There is no serialiser that would keep the
// author's formatting, so edit the source text: find the literal that holds
// the current value and replace it in place. The module is evaluated to know
// the current values and to count earlier occurrences of the same key/value,
// which disambiguates repeated literals ("year: 2023" in several entries).
function evalModuleText(file, raw) {
  const ext = path.extname(file);
  const relativeImports = /from\s+["']\.{1,2}\//.test(raw) || /import\(["']\.{1,2}\//.test(raw);
  const dir = relativeImports ? path.dirname(path.resolve(file)) : os.tmpdir();
  const tmp = path.join(dir, `.loupe-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, raw);
  try {
    return loadModule(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalForms(value) {
  if (typeof value === "string") return spellings(value);
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  return null;
}

// All places where `value` is spelled out, optionally preceded by `key:`.
function occurrences(raw, value, key) {
  const forms = literalForms(value);
  if (!forms) return [];
  const lit = `(${forms.map(escapeRe).join("|")})`;
  const re = key !== null
    ? new RegExp(`(?<=^|[\\s,{])(?:${escapeRe(key)}|["']${escapeRe(key)}["'])\\s*:\\s*${lit}(?=\\s*[,}\\n]|\\s*//|\\s*$)`, "gm")
    : new RegExp(lit + (typeof value === "string" ? "" : "(?![\\w.])"), "g");
  const out = [];
  for (const m of raw.matchAll(re)) {
    const start = m.index + m[0].length - m[1].length;
    out.push({ start, end: start + m[1].length, text: m[1] });
  }
  return out;
}

function renderLiteral(sample, value) {
  if (typeof value !== "string") return String(value);
  const q = sample[0];
  const [dq, sq, bt] = spellings(value);
  return q === "'" ? sq : q === "`" ? bt : dq;
}

function writeModule(file, raw, ops) {
  const data = sourceOrder(evalModuleText(file, raw), raw);
  let text = raw;
  for (const { tokens, op } of ops) {
    if (op.op !== "set") throw new Error(`${path.basename(file)}: reordering lists kept in code is not supported yet`);
    const old = getIn(data, tokens);
    if (old === undefined) throw new Error(`no value at ${tokens.join(".")} in ${file}`);
    const value = coerce(old, op.value);
    if (value === old) continue;
    const last = tokens[tokens.length - 1];
    const key = typeof last === "string" ? last : null;
    // Ordinal among earlier leaves with the same (key,) value in source order.
    let keyed = 0, bare = 0, found = false;
    const target = tokens.join(".");
    for (const leaf of walk(data, "", null)) {
      const p = leaf.path.replace(/\[(\d+)\]/g, ".$1");
      if (p === target) {
        found = true;
        break;
      }
      if (leaf.value !== old) continue;
      bare++;
      if (key !== null && p.endsWith("." + key)) keyed++;
    }
    if (!found) throw new Error(`no value at ${target} in ${file}`);
    let hits = key !== null ? occurrences(text, old, key) : [];
    let hit = hits[keyed];
    if (!hit) {
      hits = occurrences(text, old, null);
      hit = hits[bare];
    }
    if (!hit) throw new Error(`could not find the literal for ${target} in ${file}; edit the source directly`);
    text = text.slice(0, hit.start) + renderLiteral(hit.text, value) + text.slice(hit.end);
    setIn(data, tokens, value);
  }
  return text;
}

// Group ops by file, keeping their order within each file.
export function groupOps(ops) {
  const byFile = new Map();
  for (const op of ops) {
    const { file, path: p } = splitRef(op.ref);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ tokens: parsePath(p), op });
  }
  return byFile;
}

// Apply one file's ops to its text and return the new text.
export function patchText(file, raw, fileOps) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") return writeJson(file, raw, fileOps);
  if (ext === ".yml" || ext === ".yaml") return writeYaml(raw, fileOps);
  if (ext === ".toml") return writeToml(raw, fileOps);
  if (ext === ".md" || ext === ".markdown") return writeMarkdown(raw, fileOps);
  if (MODULE_EXT.test(file)) return writeModule(file, raw, fileOps);
  throw new Error(`unsupported file type: ${file}`);
}

export function safePath(cwd, file) {
  const abs = path.resolve(cwd, file);
  if (!abs.startsWith(path.resolve(cwd) + path.sep)) throw new Error(`refusing to touch a path outside the project: ${file}`);
  return abs;
}

export function applyPatch(ops, { cwd = process.cwd() } = {}) {
  const changed = [];
  for (const [file, fileOps] of groupOps(ops)) {
    const abs = safePath(cwd, file);
    const raw = fs.readFileSync(abs, "utf8");
    const out = patchText(file, raw, fileOps);
    if (out !== raw) {
      fs.writeFileSync(abs, out);
      changed.push(file);
    }
  }
  return { changed };
}
