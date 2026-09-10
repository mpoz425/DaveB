#!/usr/bin/env node
// Usage:
//   node loupe/serve.js --content data --output dist --build "python3 build.py --no-fetch" [--port 4343]
//
// Serves the built site with every page matched, annotated and overlaid with
// the Loupe editor. Edits are applied to the content files, the build command
// is re-run, and the page reloads. GET /__loupe/diff shows what changed.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { loadContent } from "./src/content.js";
import { match, annotate } from "./src/match.js";
import { applyPatch } from "./src/patch.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function args() {
  const a = { content: [], output: null, build: null, port: 4343 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--content") a.content.push(argv[++i]);
    else if (k === "--output") a.output = argv[++i];
    else if (k === "--build") a.build = argv[++i];
    else if (k === "--port") a.port = Number(argv[++i]);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function run(cmd, cwd) {
  try {
    return { ok: true, output: execSync(cmd, { cwd, stdio: "pipe", timeout: 180000 }).toString() };
  } catch (e) {
    return { ok: false, output: `${e.stdout || ""}${e.stderr || ""}${e.message}` };
  }
}

function renderPage(file, a, cwd) {
  const { leaves, bodies } = loadContent(a.content, { cwd });
  const dom = new JSDOM(fs.readFileSync(file, "utf8"));
  const doc = dom.window.document;
  const result = match(doc, leaves, bodies);
  annotate(doc, result);
  const values = {};
  for (const b of result.bindings) {
    if (b.leaves.length !== 1) continue;
    const l = b.leaves[0];
    values[`${l.file}#${l.path}`] = l.value;
  }
  const boot = doc.createElement("script");
  boot.textContent = `window.__loupe=${JSON.stringify({ values, canBuild: Boolean(a.build) }).replace(/</g, "\\u003c")};`;
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
      if (!fs.existsSync(file)) return send(res, 404, `not found: ${rel}`);
      const ext = path.extname(file).toLowerCase();
      if (ext === ".html" || ext === ".htm") return send(res, 200, renderPage(file, a, cwd), TYPES[".html"]);
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
