// Apply edits coming from the overlay to the content files on disk.
//
// ops:
//   { op: "set",     ref: "data/copy.json#hero.title", value: "..." }
//   { op: "reorder", ref: "data/reviews.json#",        order: [2, 0, { copyOf: 1 }, 3] }
//
// "reorder" rebuilds an array from the listed original indices; entries that
// are missing are removed and { copyOf } entries are deep copies, so one op
// expresses any combination of move / delete / duplicate the overlay produced.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import TOML from "@iarna/toml";
import { splitRef, parsePath, getIn, setIn } from "./paths.js";

const FRONT = /^(---|\+\+\+)(\w*)\r?\n([\s\S]*?)\r?\n\1\r?\n?([\s\S]*)$/;

function coerce(oldValue, value) {
  if (typeof oldValue === "number" && typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  if (typeof oldValue === "boolean" && typeof value === "string") return value === "true";
  return value;
}

function reorderPlain(arr, order) {
  if (!Array.isArray(arr)) throw new Error("reorder target is not an array");
  return order.map((o) => {
    const i = typeof o === "object" ? o.copyOf : o;
    if (!(i in arr)) throw new Error(`reorder index ${i} out of range`);
    return typeof o === "object" ? structuredClone(arr[i]) : arr[i];
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
      const i = typeof o === "object" ? o.copyOf : o;
      if (!(i in items)) throw new Error(`reorder index ${i} out of range`);
      return typeof o === "object" ? doc.createNode(structuredClone(YAML.isNode(items[i]) ? items[i].toJSON() : items[i])) : items[i];
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
    const parts = op.order.map((o) => {
      const i = typeof o === "object" ? o.copyOf : o;
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

export function applyPatch(ops, { cwd = process.cwd() } = {}) {
  const byFile = new Map();
  for (const op of ops) {
    const { file, path: p } = splitRef(op.ref);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ tokens: parsePath(p), op });
  }
  const changed = [];
  for (const [file, fileOps] of byFile) {
    const abs = path.resolve(cwd, file);
    if (!abs.startsWith(path.resolve(cwd) + path.sep)) throw new Error(`refusing to write outside the project: ${file}`);
    const raw = fs.readFileSync(abs, "utf8");
    const ext = path.extname(abs).toLowerCase();
    let out;
    if (ext === ".json") out = writeJson(abs, raw, fileOps);
    else if (ext === ".yml" || ext === ".yaml") out = writeYaml(raw, fileOps);
    else if (ext === ".toml") out = writeToml(raw, fileOps);
    else if (ext === ".md" || ext === ".markdown") out = writeMarkdown(raw, fileOps);
    else throw new Error(`unsupported file type: ${file}`);
    if (out !== raw) {
      fs.writeFileSync(abs, out);
      changed.push(file);
    }
  }
  return { changed };
}
