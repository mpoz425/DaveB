#!/usr/bin/env node
// Usage:
//   node loupe/serve.js --content data --output dist --build "python3 build.py --no-fetch" \
//        [--uploads assets/photos=/photos] [--remote origin] [--no-push] [--port 4343]
//
// Serves the built site with every page matched, annotated and overlaid with
// the Loupe editor.
//   Save & rebuild  → edits are applied to the content files in the working
//                     tree, the build command is re-run, the page reloads.
//   Propose         → edits become a commit on a new loupe/* branch (working
//                     tree untouched), pushed to --remote; a pull request is
//                     created when LOUPE_GITHUB_TOKEN / GITHUB_TOKEN is set,
//                     otherwise the GitHub "open a PR" link is returned.
//   --uploads       → dropped images are written to <dir> and referenced as
//                     <url>/<name>.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { loadContent } from "./src/content.js";
import { match, annotate } from "./src/match.js";
import { applyPatch, safePath } from "./src/patch.js";
import { propose, repoInfo } from "./src/propose.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function args() {
  const a = { content: [], output: null, build: null, port: 4343, uploads: null, remote: "origin", push: true };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--content") a.content.push(argv[++i]);
    else if (k === "--output") a.output = argv[++i];
    else if (k === "--build") a.build = argv[++i];
    else if (k === "--port") a.port = Number(argv[++i]);
    else if (k === "--remote") a.remote = argv[++i];
    else if (k === "--no-push") a.push = false;
    else if (k === "--uploads") {
      const [dir, url = "/" + argv[i + 1]] = argv[++i].split("=");
      a.uploads = { dir, url: url.replace(/\/$/, "") };
    }
  }
  if (!a.content.length || !a.output) {
    console.error("need --content <dir|file> (repeatable) and --output <dir>; --build \"<cmd>\" to rebuild after edits");
    process.exit(2);
  }
  return a;
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".woff": "font/woff", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".mp4": "video/mp4",
};

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req, binary = false) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function uniqueName(dir, name) {
  const base = name.replace(/[^\w.-]+/g, "-").replace(/^-+/, "") || "upload";
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let candidate = base;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem}-${i}${ext}`;
  return candidate;
}

function run(cmd, cwd) {
  try {
    return { ok: true, output: execSync(cmd, { cwd, stdio: "pipe", timeout: 180000 }).toString() };
  } catch (e) {
    return { ok: false, output: `${e.stdout || ""}${e.stderr || ""}${e.message}` };
  }
}

const FIELD_TYPES = new Set(["text", "markdown", "url", "link", "media", "date", "number", "email", "phone", "boolean"]);

function htmlFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort();
}

// Editable leaves that no page renders. They get no in-place binding, so the
// overlay offers them as plain fields instead. Recomputed only when content or
// output changes, since it means matching every page.
const siteIndex = { stamp: null, unbound: [] };
function unboundFields(a, cwd, outDir, content) {
  const pages = htmlFiles(outDir);
  const stamp = [...content.files.map((f) => path.resolve(cwd, f)), ...pages].map((f) => `${f}:${fs.statSync(f).mtimeMs}`).join("|");
  if (siteIndex.stamp === stamp) return siteIndex.unbound;
  const bound = new Set();
  for (const page of pages) {
    const dom = new JSDOM(fs.readFileSync(page, "utf8"));
    for (const b of match(dom.window.document, content.leaves, content.bodies).bindings) if (b.leaves.length === 1) bound.add(b.leaves[0]);
  }
  siteIndex.stamp = stamp;
  siteIndex.unbound = [...content.leaves, ...content.bodies]
    .filter((l) => !bound.has(l) && FIELD_TYPES.has(l.type))
    .map((l) => ({ ref: `${l.file}#${l.path}`, value: l.value, type: l.type }));
  console.log(`fields drawer: ${siteIndex.unbound.length} value(s) not rendered on any page`);
  return siteIndex.unbound;
}

function renderPage(file, a, cwd, outDir) {
  const content = loadContent(a.content, { cwd });
  const dom = new JSDOM(fs.readFileSync(file, "utf8"));
  const doc = dom.window.document;
  const result = match(doc, content.leaves, content.bodies);
  annotate(doc, result);
  const values = {};
  const filesOnPage = new Set();
  for (const b of result.bindings) {
    if (b.leaves.length !== 1) continue;
    const l = b.leaves[0];
    values[`${l.file}#${l.path}`] = l.value;
    filesOnPage.add(l.file);
  }
  const fields = unboundFields(a, cwd, outDir, content).map((f) => ({ ...f, onPage: filesOnPage.has(f.ref.split("#")[0]) }));
  const boot = doc.createElement("script");
  const info = repoInfo(cwd, a.remote);
  boot.textContent = `window.__loupe=${JSON.stringify({ values, fields, canBuild: Boolean(a.build), canUpload: Boolean(a.uploads), canPropose: Boolean(info.remoteUrl), base: info.base }).replace(/</g, "\\u003c")};`;
  const css = doc.createElement("link");
  css.rel = "stylesheet";
  css.href = "/__loupe/overlay.css";
  const js = doc.createElement("script");
  js.src = "/__loupe/overlay.js";
  js.defer = true;
  doc.body.append(boot, css, js);
  return dom.serialize();
}

function main() {
  const a = args();
  const cwd = process.cwd();
  const outDir = path.resolve(cwd, a.output);
  const uploads = new Map(); // public url -> repo-relative path, for this session
  if (a.build) {
    // Make sure the pages we annotate were built from the content we load.
    const first = run(a.build, cwd);
    console.log(first.ok ? `built: ${first.output.trim()}` : `initial build FAILED:\n${first.output}`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname === "/__loupe/overlay.js" || url.pathname === "/__loupe/overlay.css") {
        const f = path.join(here, "overlay", path.basename(url.pathname));
        return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)]);
      }
      if (url.pathname === "/__loupe/patch" && req.method === "POST") {
        const { ops } = JSON.parse(await readBody(req));
        const { changed } = applyPatch(ops, { cwd });
        const build = a.build ? run(a.build, cwd) : { ok: true, output: "(no build command)" };
        console.log(`patch: ${ops.length} op(s) → ${changed.join(", ") || "nothing changed"}; build ${build.ok ? "ok" : "FAILED"}`);
        return send(res, build.ok ? 200 : 500, JSON.stringify({ changed, build }), "application/json");
      }
      if (url.pathname === "/__loupe/upload" && req.method === "POST") {
        if (!a.uploads) return send(res, 400, JSON.stringify({ error: "start the server with --uploads <dir>=<url> to enable uploads" }), "application/json");
        const dir = safePath(cwd, a.uploads.dir);
        fs.mkdirSync(dir, { recursive: true });
        const name = uniqueName(dir, path.basename(url.searchParams.get("name") || "upload"));
        const data = await readBody(req, true);
        if (!data.length) return send(res, 400, JSON.stringify({ error: "empty upload" }), "application/json");
        fs.writeFileSync(path.join(dir, name), data);
        const rel = path.relative(cwd, path.join(dir, name));
        uploads.set(`${a.uploads.url}/${name}`, rel);
        console.log(`upload: ${rel} (${data.length} bytes)`);
        return send(res, 200, JSON.stringify({ path: rel, url: `${a.uploads.url}/${name}` }), "application/json");
      }
      if (url.pathname === "/__loupe/propose" && req.method === "POST") {
        const { ops, title, note } = JSON.parse(await readBody(req));
        if (!title || !title.trim()) return send(res, 400, JSON.stringify({ error: "a title is required" }), "application/json");
        // Only ship uploads that the edits actually reference.
        const used = [...uploads].filter(([u]) => ops.some((o) => o.op === "set" && String(o.value).includes(u))).map(([, rel]) => rel);
        const result = await propose({ ops, uploads: used, title, note, cwd, remote: a.remote, push: a.push });
        console.log(`propose: ${result.branch} (${result.files.length} file(s)) ${result.pushed ? "pushed" : "not pushed"}${result.url ? ` → ${result.url}` : ""}`);
        return send(res, 200, JSON.stringify(result), "application/json");
      }
      if (url.pathname === "/__loupe/diff") {
        const roots = a.content.map((c) => JSON.stringify(c)).join(" ");
        const diff = run(`git diff --no-color -- ${roots}`, cwd);
        const status = run(`git status --short -- ${roots}`, cwd);
        return send(res, 200, JSON.stringify({ diff: diff.output, status: status.output }), "application/json");
      }

      let rel = decodeURIComponent(url.pathname);
      let file = path.join(outDir, rel);
      if (!file.startsWith(outDir)) return send(res, 403, "forbidden");
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      if (!fs.existsSync(file) && fs.existsSync(file + ".html")) file += ".html";
      // Fresh uploads live in the source tree until the next build.
      if (!fs.existsSync(file) && a.uploads && rel.startsWith(a.uploads.url + "/")) file = path.join(safePath(cwd, a.uploads.dir), rel.slice(a.uploads.url.length + 1));
      if (!fs.existsSync(file)) return send(res, 404, `not found: ${rel}`);
      const ext = path.extname(file).toLowerCase();
      if (ext === ".html" || ext === ".htm") return send(res, 200, renderPage(file, a, cwd, outDir), TYPES[".html"]);
      return send(res, 200, fs.readFileSync(file), TYPES[ext] || "application/octet-stream");
    } catch (e) {
      console.error(e);
      return send(res, 500, JSON.stringify({ error: e.message }), "application/json");
    }
  });

  server.listen(a.port, () => {
    console.log(`loupe editor at http://localhost:${a.port}/  (content: ${a.content.join(", ")}; output: ${a.output}${a.build ? `; build: ${a.build}` : ""})`);
  });
}

main();
