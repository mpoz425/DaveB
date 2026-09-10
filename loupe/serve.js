#!/usr/bin/env node
// Usage:
//   node loupe/serve.js --content data --output dist --build "python3 build.py --no-fetch" \
//        [--uploads assets/photos=/photos] [--remote origin] [--no-push] [--no-verify] [--port 4343]
//   node loupe/serve.js --content data --output http://localhost:3000        (framework dev server)
//
// Serves the site with every page matched, annotated and overlaid with the
// Loupe editor.
//   Save & rebuild  → edits are applied to the content files in the working
//                     tree, the build command is re-run, the page reloads.
//   Propose         → edits become a commit on a new loupe/* branch (working
//                     tree untouched). The commit is built in a temporary
//                     worktree and every edit is checked against the rendered
//                     pages before the branch is pushed to --remote; a pull
//                     request is created when LOUPE_GITHUB_TOKEN / GITHUB_TOKEN
//                     is set, otherwise the GitHub "open a PR" link is returned.
//   --uploads       → dropped images are written to <dir> and referenced as
//                     <url>/<name>.
//   --output http://… → proxy a running dev server (Next, Astro, Vite…) instead
//                     of a build directory. Pages are matched in the browser
//                     after the framework has rendered, so client-rendered
//                     content is covered too; the framework's own reload
//                     replaces --build.
//   .loupe.json     → pins and ignores made in the editor ("Change source…",
//                     "Not content") are stored here and travel with proposals.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { loadContent, contentStamp } from "./src/content.js";
import { match, annotate } from "./src/match.js";
import { applyPatch, safePath } from "./src/patch.js";
import { propose, repoInfo } from "./src/propose.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 25 * 1024 * 1024;
const OVERRIDES_FILE = ".loupe.json";

function args() {
  const a = { content: [], output: null, build: null, port: 4343, uploads: null, remote: "origin", push: true, verify: true };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--content") a.content.push(argv[++i]);
    else if (k === "--output") a.output = argv[++i];
    else if (k === "--build") a.build = argv[++i];
    else if (k === "--port") a.port = Number(argv[++i]);
    else if (k === "--remote") a.remote = argv[++i];
    else if (k === "--no-push") a.push = false;
    else if (k === "--no-verify") a.verify = false;
    else if (k === "--uploads") {
      const [dir, url = "/" + argv[i + 1]] = argv[++i].split("=");
      a.uploads = { dir, url: url.replace(/\/$/, "") };
    }
  }
  if (!a.content.length || !a.output) {
    console.error('need --content <dir|file> (repeatable) and --output <dir | http://host:port>; --build "<cmd>" to rebuild after edits');
    process.exit(2);
  }
  a.upstream = /^https?:\/\//i.test(a.output) ? new URL(a.output) : null;
  return a;
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".woff": "font/woff", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".mp4": "video/mp4", ".pdf": "application/pdf",
};

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), "application/json");

function readBody(req, binary = false) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error(`request body over ${MAX_BODY / 1024 / 1024} MB`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
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

// Builds run off the event loop and one at a time, so the server keeps
// answering while the site regenerates.
let buildChain = Promise.resolve();
function runBuild(cmd, cwd) {
  const job = () =>
    new Promise((resolve) => {
      const t0 = Date.now();
      exec(cmd, { cwd, timeout: 300000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const output = `${stdout || ""}${stderr || ""}`.trim();
        resolve({ ok: !err, output: err && !output ? err.message : output, ms: Date.now() - t0 });
      });
    });
  buildChain = buildChain.then(job, job);
  return buildChain;
}

// Content is re-read only when a content file changes (TS modules are
// evaluated in a child process, which is too slow to do per request).
const contentCache = { stamp: null, content: null };
function getContent(a, cwd) {
  const stamp = contentStamp(a.content, { cwd });
  if (contentCache.stamp !== stamp) {
    contentCache.content = loadContent(a.content, { cwd });
    contentCache.stamp = stamp;
  }
  return contentCache.content;
}

function readOverrides(cwd) {
  const f = path.join(cwd, OVERRIDES_FILE);
  if (!fs.existsSync(f)) return { pin: [], ignore: [] };
  try {
    const o = JSON.parse(fs.readFileSync(f, "utf8"));
    return { pin: o.pin || [], ignore: o.ignore || [] };
  } catch (e) {
    console.error(`${OVERRIDES_FILE}: ${e.message}`);
    return { pin: [], ignore: [] };
  }
}
function writeOverrides(cwd, o) {
  const f = path.join(cwd, OVERRIDES_FILE);
  const clean = { pin: o.pin || [], ignore: o.ignore || [] };
  if (!clean.pin.length && !clean.ignore.length) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return clean;
  }
  fs.writeFileSync(f, JSON.stringify(clean, null, 2) + "\n");
  return clean;
}

const FIELD_TYPES = new Set(["text", "markdown", "url", "link", "media", "date", "number", "email", "phone", "boolean"]);

function htmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort();
}
function pageUrl(outDir, file) {
  return ("/" + path.relative(outDir, file).split(path.sep).join("/")).replace(/\/index\.html$/, "/");
}

// Editable leaves that no page renders. They get no in-place binding, so the
// overlay offers them as plain fields instead. Recomputed only when content,
// overrides or output change, since it means matching every page.
const siteIndex = { stamp: null, unbound: [] };
function unboundFields(cwd, outDir, content, overrides) {
  const pages = htmlFiles(outDir);
  const stamp = [contentCache.stamp, JSON.stringify(overrides), ...pages.map((f) => `${f}:${fs.statSync(f).mtimeMs}`)].join("|");
  if (siteIndex.stamp === stamp) return siteIndex.unbound;
  const bound = new Set();
  const opts = { overrides, readonlyFiles: readonlyFiles(content) };
  for (const page of pages) {
    const dom = new JSDOM(fs.readFileSync(page, "utf8"));
    for (const b of match(dom.window.document, content.leaves, content.bodies, { ...opts, page: pageUrl(outDir, page) }).bindings) if (b.leaves.length === 1) bound.add(b.leaves[0]);
  }
  siteIndex.stamp = stamp;
  siteIndex.unbound = [...content.leaves, ...content.bodies]
    .filter((l) => !bound.has(l) && FIELD_TYPES.has(l.type))
    .map((l) => ({ ref: `${l.file}#${l.path}`, value: l.value, type: l.type }));
  console.log(`fields drawer: ${siteIndex.unbound.length} value(s) not rendered on any page`);
  return siteIndex.unbound;
}

function readonlyFiles(content) {
  return new Set(Object.entries(content.capabilities || {}).filter(([, c]) => c.reorder === false).map(([f]) => f));
}

function catalog(content) {
  return [...content.leaves, ...content.bodies].filter((l) => FIELD_TYPES.has(l.type)).map((l) => ({ ref: `${l.file}#${l.path}`, value: l.value, type: l.type }));
}

function bootScript(doc, payload) {
  const boot = doc.createElement("script");
  boot.textContent = `window.__loupe=${JSON.stringify(payload).replace(/</g, "\\u003c")};`;
  return boot;
}
function injectAssets(doc, client) {
  const css = doc.createElement("link");
  css.rel = "stylesheet";
  css.href = "/__loupe/overlay.css";
  const js = doc.createElement("script");
  js.src = client ? "/__loupe/client.js" : "/__loupe/overlay.js";
  if (client) js.type = "module";
  else js.defer = true;
  return [css, js];
}

function baseBoot(a, cwd, content) {
  const info = repoInfo(cwd, a.remote);
  return {
    canBuild: Boolean(a.build), canUpload: Boolean(a.uploads), canPropose: Boolean(info.remoteUrl), base: info.base,
    readonlyFiles: [...readonlyFiles(content)], overrides: readOverrides(cwd), mode: a.upstream ? "client" : "server",
  };
}

// Static output: match on the server, ship the page annotated.
function renderPage(file, a, cwd, outDir) {
  const content = getContent(a, cwd);
  const overrides = readOverrides(cwd);
  const dom = new JSDOM(fs.readFileSync(file, "utf8"));
  const doc = dom.window.document;
  const page = pageUrl(outDir, file);
  const result = match(doc, content.leaves, content.bodies, { overrides, page, readonlyFiles: readonlyFiles(content) });
  annotate(doc, result);
  const values = {};
  const filesOnPage = new Set();
  for (const b of result.bindings) {
    if (b.leaves.length !== 1) continue;
    const l = b.leaves[0];
    values[`${l.file}#${l.path}`] = l.value;
    filesOnPage.add(l.file);
  }
  const fields = unboundFields(cwd, outDir, content, overrides).map((f) => ({ ...f, onPage: filesOnPage.has(f.ref.split("#")[0]) }));
  doc.body.append(bootScript(doc, { ...baseBoot(a, cwd, content), page, values, fields }), ...injectAssets(doc, false));
  return dom.serialize();
}

// Upstream dev server: ship the content and let the browser match after the
// framework has rendered (and re-match when it re-renders).
function injectClient(html, a, cwd, page) {
  const content = getContent(a, cwd);
  const leaves = content.leaves.filter((l) => FIELD_TYPES.has(l.type));
  const payload = { ...baseBoot(a, cwd, content), page, values: {}, fields: [], leaves, bodies: content.bodies };
  const tag = `<script>window.__loupe=${JSON.stringify(payload).replace(/</g, "\\u003c")};</script><link rel="stylesheet" href="/__loupe/overlay.css"><script type="module" src="/__loupe/client.js"></script>`;
  const i = html.lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag;
}

async function proxy(req, res, a, cwd, url) {
  const target = new URL(url.pathname + url.search, a.upstream);
  const headers = { ...req.headers, host: a.upstream.host, "accept-encoding": "identity" };
  delete headers.connection;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req, true);
  let up;
  try {
    up = await fetch(target, { method: req.method, headers, body, redirect: "manual" });
  } catch (e) {
    return send(res, 502, `upstream ${a.upstream.origin} is not answering: ${e.message}`);
  }
  const type = up.headers.get("content-type") || "";
  const out = {};
  up.headers.forEach((v, k) => {
    if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v;
  });
  out["cache-control"] = "no-store";
  if (up.status >= 300 && up.status < 400 && out.location) out.location = out.location.replace(a.upstream.origin, `http://${req.headers.host}`);
  if (/text\/html/i.test(type) && up.status === 200 && (req.headers.accept || "").includes("text/html")) {
    const html = await up.text();
    res.writeHead(200, out);
    return res.end(injectClient(html, a, cwd, url.pathname));
  }
  const buf = Buffer.from(await up.arrayBuffer());
  out["content-length"] = buf.length;
  res.writeHead(up.status, out);
  res.end(buf);
}

// Dev servers keep a WebSocket open for hot reload; tunnel it through.
function tunnelUpgrade(server, upstream) {
  server.on("upgrade", (req, socket, head) => {
    const conn = net.connect(Number(upstream.port) || 80, upstream.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        lines.push(`${k}: ${k.toLowerCase() === "host" ? upstream.host : req.rawHeaders[i + 1]}`);
      }
      conn.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) conn.write(head);
      socket.pipe(conn).pipe(socket);
    });
    const drop = () => {
      socket.destroy();
      conn.destroy();
    };
    conn.on("error", drop);
    socket.on("error", drop);
  });
}

function main() {
  const a = args();
  const cwd = process.cwd();
  const outDir = a.upstream ? null : path.resolve(cwd, a.output);
  const uploads = new Map(); // public url -> repo-relative path, for this session
  if (a.build) {
    // Make sure the pages we annotate were built from the content we load.
    runBuild(a.build, cwd).then((first) => console.log(first.ok ? `built in ${first.ms} ms${first.output ? `: ${first.output.split("\n").pop()}` : ""}` : `initial build FAILED:\n${first.output}`));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname === "/__loupe/overlay.js" || url.pathname === "/__loupe/overlay.css" || url.pathname === "/__loupe/client.js") {
        const f = path.join(here, "overlay", path.basename(url.pathname));
        return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)]);
      }
      if (url.pathname === "/__loupe/src/match.js" || url.pathname === "/__loupe/src/normalize.js") {
        return send(res, 200, fs.readFileSync(path.join(here, "src", path.basename(url.pathname))), TYPES[".js"]);
      }
      if (url.pathname === "/__loupe/leaves") return json(res, 200, catalog(getContent(a, cwd)));
      if (url.pathname === "/__loupe/overrides") {
        if (req.method === "GET") return json(res, 200, readOverrides(cwd));
        const { add, remove } = JSON.parse(await readBody(req));
        const o = readOverrides(cwd);
        if (add && (add.kind === "pin" || add.kind === "ignore") && add.entry) {
          const list = o[add.kind];
          const same = JSON.stringify(add.entry);
          if (!list.some((e) => JSON.stringify(e) === same)) list.push(add.entry);
        }
        if (remove && remove.kind && remove.entry) {
          const same = JSON.stringify(remove.entry);
          o[remove.kind] = o[remove.kind].filter((e) => JSON.stringify(e) !== same);
        }
        const saved = writeOverrides(cwd, o);
        console.log(`overrides: ${saved.pin.length} pin(s), ${saved.ignore.length} ignore(s)`);
        return json(res, 200, saved);
      }
      if (url.pathname === "/__loupe/patch" && req.method === "POST") {
        const { ops } = JSON.parse(await readBody(req));
        const { changed } = applyPatch(ops, { cwd });
        const build = a.build ? await runBuild(a.build, cwd) : { ok: true, output: a.upstream ? "(the dev server reloads on its own)" : "(no build command)" };
        console.log(`patch: ${ops.length} op(s) → ${changed.join(", ") || "nothing changed"}; build ${build.ok ? `ok (${build.ms ?? 0} ms)` : "FAILED"}`);
        return json(res, build.ok ? 200 : 500, { changed, build });
      }
      if (url.pathname === "/__loupe/upload" && req.method === "POST") {
        if (!a.uploads) return json(res, 400, { error: "start the server with --uploads <dir>=<url> to enable uploads" });
        const dir = safePath(cwd, a.uploads.dir);
        fs.mkdirSync(dir, { recursive: true });
        const name = uniqueName(dir, path.basename(url.searchParams.get("name") || "upload"));
        const data = await readBody(req, true);
        if (!data.length) return json(res, 400, { error: "empty upload" });
        fs.writeFileSync(path.join(dir, name), data);
        const rel = path.relative(cwd, path.join(dir, name));
        uploads.set(`${a.uploads.url}/${name}`, rel);
        console.log(`upload: ${rel} (${data.length} bytes)`);
        return json(res, 200, { path: rel, url: `${a.uploads.url}/${name}` });
      }
      if (url.pathname === "/__loupe/propose" && req.method === "POST") {
        const { ops, title, note } = JSON.parse(await readBody(req));
        if (!title || !title.trim()) return json(res, 400, { error: "a title is required" });
        // Only ship uploads that the edits actually reference.
        const used = [...uploads].filter(([u]) => ops.some((o) => o.op === "set" && String(o.value).includes(u))).map(([, rel]) => rel);
        const verify = a.verify && a.build && !a.upstream ? { build: a.build, content: a.content, output: a.output, overrides: readOverrides(cwd) } : null;
        const result = await propose({ ops, uploads: used, title, note, cwd, remote: a.remote, push: a.push, verify });
        const v = result.verification;
        console.log(`propose: ${result.branch} (${result.files.length} file(s))${v ? ` verified: build ${v.build.ok ? "ok" : "FAILED"}${v.build.ok ? `, ${v.rendered}/${v.of} edits render` : ""}` : ""} ${result.pushed ? "pushed" : "not pushed"}${result.url ? ` → ${result.url}` : ""}`);
        return json(res, 200, result);
      }
      if (url.pathname === "/__loupe/diff") {
        const roots = [...a.content, OVERRIDES_FILE].map((c) => JSON.stringify(c)).join(" ");
        const diff = await runShell(`git diff --no-color -- ${roots}`, cwd);
        const status = await runShell(`git status --short -- ${roots}`, cwd);
        return json(res, 200, { diff: diff.output, status: status.output });
      }

      if (a.upstream) return proxy(req, res, a, cwd, url);

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
      if (e.status !== 413) console.error(e);
      return json(res, e.status || 500, { error: e.message });
    }
  });
  if (a.upstream) tunnelUpgrade(server, a.upstream);

  server.listen(a.port, () => {
    console.log(`loupe editor at http://localhost:${a.port}/  (content: ${a.content.join(", ")}; ${a.upstream ? `upstream: ${a.upstream.origin}` : `output: ${a.output}`}${a.build ? `; build: ${a.build}` : ""})`);
  });
}

function runShell(cmd, cwd) {
  return new Promise((resolve) => exec(cmd, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout || ""}${stderr || ""}` })));
}

main();
