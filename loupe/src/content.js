// Load structured content files (JSON, YAML, TOML, Markdown front matter) and
// flatten them into leaf values with a stable path, e.g.
//   { file: "data/reviews.json", path: "[2].note", value: "Thirty-six chances…", type: "text" }
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import TOML from "@iarna/toml";

export const MODULE_EXT = /\.(m?[jt]s|cjs)$/i;
export const CONTENT_EXT = /\.(json|ya?ml|toml|md|markdown|m?[jt]s|cjs)$/i;

const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|svg|mp4|webm|mp3|pdf|ico)$/i;
const ID_KEYS = /(^|[_-])(id|uuid|slug|key|ref|type|kind|medium|series|layout|template|status|variant|icon|logo|weight|lang|locale|code|font|section|field|tracker|trackerID|analytics)s?$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{7,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function classify(value, key) {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return /^(w|h|width|height|size|bytes|ratio)$/i.test(key || "") ? "meta" : "number";
  if (typeof value !== "string") return "other";
  if (!value.trim()) return "empty";
  if (/^https?:\/\//i.test(value) || value.startsWith("mailto:") || value.startsWith("tel:")) return "url";
  if (EMAIL.test(value)) return "email";
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "date";
  if (PHONE.test(value) && /\d{3}/.test(value)) return "phone";
  if (MEDIA_EXT.test(value) || /^\/?[\w\-/.]+\.(svg|png|jpe?g)$/i.test(value)) return "media";
  if (/^[#/][\w\-/.#?=&]*$/.test(value)) return "link";
  if (/^\d+$/.test(value)) return "number";
  if (UUID.test(value) || /^[0-9a-f]{16,}$/i.test(value)) return "identifier";
  if (!/\s/.test(value) && /^[\w.-]+$/.test(value) && (ID_KEYS.test(key || "") || /(fields?|sections?|keys?|ids?|types?|kinds?)$/i.test(key || ""))) return "identifier";
  if (/\n\n/.test(value) && value.length > 200) return "markdown";
  if (/^[\w.-]*(color|colour|hex)$/i.test(key || "") || /^#[0-9a-f]{3,8}$/i.test(value)) return "token";
  return "text";
}

export function* walk(value, p, key) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* walk(value[i], `${p}[${i}]`, key);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* walk(v, p ? `${p}.${k}` : k, k);
  } else {
    yield { path: p, value, type: classify(value, key) };
  }
}

function parseFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") return { data: JSON.parse(raw) };
  if (ext === ".yml" || ext === ".yaml") return { data: YAML.parse(raw) };
  if (ext === ".toml") return { data: TOML.parse(raw) };
  if (ext === ".md" || ext === ".markdown") {
    const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, "");
    // Eleventy allows a language tag on the opening fence (---js, ---json, ---toml).
    const m = raw.match(/^(---|\+\+\+)(\w*)\r?\n([\s\S]*?)\r?\n\1\r?\n?([\s\S]*)$/);
    if (m) {
      const lang = m[2].toLowerCase();
      let fm = {};
      try {
        if (m[1] === "+++" || lang === "toml") fm = TOML.parse(m[3]);
        else if (lang === "json") fm = JSON.parse(m[3]);
        else if (lang === "" || lang === "yaml" || lang === "yml") fm = YAML.parse(m[3]);
        // JavaScript front matter cannot be evaluated safely; keep the body and skip the data.
      } catch {
        fm = {};
      }
      return { data: fm || {}, body: stripComments(m[4]) };
    }
    if (raw.trimStart().startsWith("{")) {
      // Hugo also accepts a leading JSON object as front matter.
      const end = closingBrace(raw, raw.indexOf("{"));
      if (end > 0) {
        try {
          return { data: JSON.parse(raw.slice(raw.indexOf("{"), end + 1)), body: stripComments(raw.slice(end + 1)) };
        } catch {
          /* fall through: treat the whole file as body */
        }
      }
    }
    return { data: {}, body: stripComments(raw) };
  }
  if (MODULE_EXT.test(file)) return { data: sourceOrder(loadModule(file), raw), module: true, raw };
  return null;
}

// Content kept in code (data/site.ts in a Next.js project): evaluate the module
// in a child process and take its exports as the data. Node strips the type
// annotations itself, so no TypeScript toolchain is needed. Values that are not
// spelled out as literals in the source (template strings, references to other
// values) are marked computed: they can be matched but not edited.
export function loadModule(file) {
  const script = `import * as m from ${JSON.stringify("file://" + path.resolve(file))};
const out = {};
for (const [k, v] of Object.entries(m)) if (typeof v !== "function") out[k] = v;
process.stdout.write(JSON.stringify(out));`;
  const flags = ["--no-warnings", "--input-type=module"];
  if (/\.m?ts$/i.test(file)) flags.unshift("--experimental-strip-types");
  const r = spawnSync(process.execPath, [...flags, "-e", script], { encoding: "utf8", timeout: 20000, cwd: path.dirname(file) });
  if (r.status !== 0) throw new Error(`could not load ${file}: ${(r.stderr || "").trim().split("\n").slice(-3).join(" ")}`);
  return JSON.parse(r.stdout || "{}");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A module namespace lists exports alphabetically; ordinals must follow the
// source, so put the exports back in declaration order.
export function sourceOrder(data, raw) {
  const pos = (name) => {
    const re = name === "default" ? /\bexport\s+default\b/ : new RegExp(`\\b(?:const|let|var|function|class)\\s+${escapeRe(name)}\\b|\\bexport\\s*\\{[^}]*\\b${escapeRe(name)}\\b`);
    const m = re.exec(raw);
    return m ? m.index : Infinity;
  };
  return Object.fromEntries(Object.entries(data).sort(([a], [b]) => pos(a) - pos(b)));
}

// Does the module source spell this string out as a literal?
export function literalIn(raw, value) {
  if (typeof value !== "string") return true;
  return spellings(value).some((s) => raw.includes(s));
}

export function spellings(value) {
  const json = JSON.stringify(value);
  const inner = json.slice(1, -1);
  return [json, `'${inner.replace(/\\"/g, '"').replace(/'/g, "\\'")}'`, "`" + value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`"];
}

function closingBrace(s, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

// Generator config files mix site content with build settings. Keep only the
// parts a content editor would touch.
const CONFIG_FILE = /^(config|hugo|_config)\.(toml|ya?ml|json)$/i;
const CONFIG_CONTENT = /^(title|description|author|params|menus?|social|copyright|footer|header|nav)(\.|\[|$)/i;
// Front matter keys that drive the build rather than describe content.
const META_KEYS = /^(draft|layout|type|outputs?|weight|aliases|url|menu|sitemap|resources|cascade|headless|build|translationKey|slug|permalink|published|sidebarlogo)(\.|\[|$)/i;

function isContentLeaf(file, leaf) {
  const base = path.basename(file);
  if (CONFIG_FILE.test(base)) return CONFIG_CONTENT.test(leaf.path);
  if (/\.(md|markdown)$/i.test(base)) return !META_KEYS.test(leaf.path);
  // Eleventy directory data files (blog.11tydata.js) carry build settings for a folder of posts.
  if (/\.11tydata\.[mc]?js$/i.test(base)) return !META_KEYS.test(leaf.path.replace(/^default\./, "")) && !/^(default\.)?(tags|eleventy\w*)(\.|\[|$)/.test(leaf.path);
  return true;
}

export function loadContent(roots, { cwd = process.cwd() } = {}) {
  const files = [];
  for (const root of roots) {
    const abs = path.resolve(cwd, root);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isFile()) {
      files.push(abs);
      continue;
    }
    for (const entry of fs.readdirSync(abs, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      if (CONTENT_EXT.test(entry.name) && !entry.name.startsWith(".") && !/\.(d|test|spec|config)\.[mc]?[jt]s$/i.test(entry.name)) files.push(full);
    }
  }
  const leaves = [];
  const bodies = [];
  const capabilities = {};
  for (const file of files.sort()) {
    let parsed;
    try {
      parsed = parseFile(file);
    } catch (e) {
      console.error(`loupe: skipping ${path.relative(cwd, file)}: ${e.message}`);
      continue;
    }
    if (!parsed) continue;
    const rel = path.relative(cwd, file);
    if (parsed.module) capabilities[rel] = { reorder: false, module: true };
    for (const leaf of walk(parsed.data, "", null)) {
      const out = { file: rel, ...leaf, ...(isContentLeaf(file, leaf) ? {} : { type: "meta" }) };
      if (parsed.module && out.type !== "meta" && !literalIn(parsed.raw, leaf.value)) {
        out.computed = true;
        out.type = "meta";
      }
      leaves.push(out);
    }
    if (parsed.body && parsed.body.trim()) bodies.push({ file: rel, path: "body", value: parsed.body, type: "markdown" });
  }
  return { files: files.map((f) => path.relative(cwd, f)), leaves, bodies, capabilities };
}

// Cheap fingerprint of the content roots, for callers that cache loadContent().
export function contentStamp(roots, { cwd = process.cwd() } = {}) {
  const parts = [];
  for (const root of roots) {
    const abs = path.resolve(cwd, root);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isFile()) {
      parts.push(`${abs}:${fs.statSync(abs).mtimeMs}`);
      continue;
    }
    for (const entry of fs.readdirSync(abs, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !CONTENT_EXT.test(entry.name)) continue;
      const full = path.join(entry.parentPath ?? entry.path, entry.name);
      parts.push(`${full}:${fs.statSync(full).mtimeMs}`);
    }
  }
  return parts.join("|");
}
