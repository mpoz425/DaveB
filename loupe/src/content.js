// Load structured content files (JSON, YAML, TOML, Markdown front matter) and
// flatten them into leaf values with a stable path, e.g.
//   { file: "data/reviews.json", path: "[2].note", value: "Thirty-six chances…", type: "text" }
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import TOML from "@iarna/toml";

const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|svg|mp4|webm|mp3|pdf|ico)$/i;
const ID_KEYS = /(^|[_-])(id|uuid|slug|key|ref|type|kind|medium|series|layout|template|status|variant|icon|logo|weight|lang|locale|code|font|section|field|tracker|trackerID|analytics)s?$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{7,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function classify(value, key) {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value !== "string") return "other";
  if (!value.trim()) return "empty";
  if (/^https?:\/\//i.test(value) || value.startsWith("mailto:") || value.startsWith("tel:")) return "url";
  if (EMAIL.test(value)) return "email";
  if (PHONE.test(value) && /\d{3}/.test(value)) return "phone";
  if (MEDIA_EXT.test(value) || /^\/?[\w\-/.]+\.(svg|png|jpe?g)$/i.test(value)) return "media";
  if (/^[#/][\w\-/.#?=&]*$/.test(value)) return "link";
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "date";
  if (/^\d+$/.test(value)) return "number";
  if (UUID.test(value) || /^[0-9a-f]{16,}$/i.test(value)) return "identifier";
  if (!/\s/.test(value) && /^[\w.-]+$/.test(value) && (ID_KEYS.test(key || "") || /(fields?|sections?|keys?|ids?|types?|kinds?)$/i.test(key || ""))) return "identifier";
  if (/\n\n/.test(value) && value.length > 200) return "markdown";
  if (/^[\w.-]*(color|colour|hex)$/i.test(key || "") || /^#[0-9a-f]{3,8}$/i.test(value)) return "token";
  return "text";
}

function* walk(value, p, key) {
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
    const m = raw.match(/^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n\1\r?\n?([\s\S]*)$/);
    if (m) {
      const fm = m[1] === "---" ? YAML.parse(m[2]) : TOML.parse(m[2]);
      return { data: fm || {}, body: stripComments(m[3]) };
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
  return null;
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
      if (/\.(json|ya?ml|toml|md|markdown)$/i.test(entry.name) && !entry.name.startsWith(".")) files.push(full);
    }
  }
  const leaves = [];
  const bodies = [];
  for (const file of files.sort()) {
    const parsed = parseFile(file);
    if (!parsed) continue;
    const rel = path.relative(cwd, file);
    for (const leaf of walk(parsed.data, "", null)) {
      leaves.push({ file: rel, ...leaf, ...(isContentLeaf(file, leaf) ? {} : { type: "meta" }) });
    }
    if (parsed.body && parsed.body.trim()) bodies.push({ file: rel, path: "body", value: parsed.body, type: "markdown" });
  }
  return { files: files.map((f) => path.relative(cwd, f)), leaves, bodies };
}
