// Turn a set of edits into a commit on a fresh branch, without touching the
// working tree or HEAD, then push it and open (or link to) a pull request.
//
// Files are patched from their HEAD version, written as blobs, assembled into
// a tree via a temporary index, and committed with HEAD as parent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { groupOps, patchText, safePath } from "./patch.js";
import { loadContent } from "./content.js";
import { match } from "./match.js";

const execFileP = promisify(execFile);

function git(cwd, args, opts = {}) {
  return execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], encoding: opts.binary ? "buffer" : "utf8", ...opts });
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "edit";
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function repoInfo(cwd, remote = "origin") {
  let url = "";
  try {
    url = git(cwd, ["remote", "get-url", remote]).trim();
  } catch {
    /* no remote */
  }
  // https://user:token@github.com/o/r.git  |  git@github.com:o/r.git
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  let branch = "main";
  try {
    const b = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (b !== "HEAD") branch = b;
  } catch {
    /* detached or no commits */
  }
  return { remote, remoteUrl: url, owner: m?.[1], repo: m?.[2], base: branch };
}

async function createPullRequest({ owner, repo, token, head, base, title, body }) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "loupe" },
    body: JSON.stringify({ title, body, head, base }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`GitHub: ${json.message || res.status}`);
  return json.html_url;
}

// Build the proposed commit in a throwaway worktree and check that every edit
// actually shows up in the rendered site. `verify` is { build, content, output }.
async function verifyCommit({ cwd, commit, prefix, ops, verify }) {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "loupe-verify-"));
  const result = { build: null, edits: [], rendered: 0, of: 0 };
  try {
    git(cwd, ["worktree", "add", "--detach", "--quiet", wt, commit]);
    const site = path.join(wt, prefix);
    const t0 = Date.now();
    try {
      const { stdout, stderr } = await execFileP(verify.build, { cwd: site, shell: true, timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
      result.build = { ok: true, output: `${stdout}${stderr}`.trim(), ms: Date.now() - t0 };
    } catch (e) {
      result.build = { ok: false, output: `${e.stdout || ""}${e.stderr || ""}${e.stdout || e.stderr ? "" : e.message}`.trim(), ms: Date.now() - t0 };
      return result;
    }
    const content = loadContent(verify.content, { cwd: site });
    const byRef = new Map(content.leaves.concat(content.bodies).map((l) => [`${l.file}#${l.path}`, l]));
    const pagesOf = new Map();
    const outDir = path.resolve(site, verify.output);
    const pages = fs.existsSync(outDir)
      ? fs.readdirSync(outDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && /\.html?$/i.test(e.name)).map((e) => path.join(e.parentPath ?? e.path, e.name))
      : [];
    for (const page of pages) {
      const dom = new JSDOM(fs.readFileSync(page, "utf8"));
      const url = "/" + path.relative(outDir, page).split(path.sep).join("/");
      for (const b of match(dom.window.document, content.leaves, content.bodies, { overrides: verify.overrides, page: url }).bindings) {
        if (b.leaves.length !== 1) continue;
        const ref = `${b.leaves[0].file}#${b.leaves[0].path}`;
        if (!pagesOf.has(ref)) pagesOf.set(ref, new Set());
        pagesOf.get(ref).add(url.replace(/\/index\.html$/, "/"));
      }
    }
    for (const op of ops) {
      if (op.op !== "set") continue;
      const leaf = byRef.get(op.ref);
      const applied = leaf !== undefined && String(leaf.value).trim() === String(op.value).trim();
      const where = [...(pagesOf.get(op.ref) || [])].sort();
      result.of++;
      if (applied && where.length) result.rendered++;
      result.edits.push({ ref: op.ref, applied, pages: where });
    }
    result.pages = pages.length;
    return result;
  } finally {
    try {
      git(cwd, ["worktree", "remove", "--force", wt]);
    } catch {
      fs.rmSync(wt, { recursive: true, force: true });
      try {
        git(cwd, ["worktree", "prune"]);
      } catch {
        /* nothing to prune */
      }
    }
  }
}

function verificationSummary(v) {
  if (!v) return "";
  if (!v.build.ok) return `Verification: the build FAILED on the proposed commit.\n\n\`\`\`\n${v.build.output.slice(-1500)}\n\`\`\``;
  const lines = [`Verification: build passed (${(v.build.ms / 1000).toFixed(1)}s, ${v.pages} page${v.pages === 1 ? "" : "s"}); ${v.rendered}/${v.of} edit${v.of === 1 ? "" : "s"} render on the site.`];
  for (const e of v.edits) {
    const where = e.pages.length ? e.pages.slice(0, 4).join(", ") + (e.pages.length > 4 ? ` and ${e.pages.length - 4} more` : "") : "not rendered on any page (field)";
    lines.push(`- \`${e.ref}\` — ${e.applied ? where : "value not applied?"}`);
  }
  return lines.join("\n");
}

export async function propose({ ops, uploads = [], title, note = "", cwd = process.cwd(), remote = "origin", push = true, token = process.env.LOUPE_GITHUB_TOKEN || process.env.GITHUB_TOKEN, verify = null, overridesFile = ".loupe.json" }) {
  if (!ops.length && !uploads.length) throw new Error("nothing to propose");
  const info = repoInfo(cwd, remote);
  const head = git(cwd, ["rev-parse", "HEAD"]).trim();
  // The site may live in a subdirectory of its repository (Hugo's exampleSite/).
  const prefix = git(cwd, ["rev-parse", "--show-prefix"]).trim();
  const inRepo = (file) => prefix + file;
  const indexFile = path.join(os.tmpdir(), `loupe-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  const files = [];
  try {
    git(cwd, ["read-tree", head], { env });
    for (const [file, fileOps] of groupOps(ops)) {
      safePath(cwd, file);
      let base;
      try {
        base = git(cwd, ["show", `${head}:${inRepo(file)}`]);
      } catch {
        base = fs.readFileSync(path.resolve(cwd, file), "utf8"); // untracked: start from the working copy
      }
      const out = patchText(file, base, fileOps);
      if (out === base) continue;
      const blob = git(cwd, ["hash-object", "-w", "--stdin"], { input: out }).trim();
      git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${inRepo(file)}`], { env });
      files.push(inRepo(file));
    }
    for (const file of uploads) {
      const abs = safePath(cwd, file);
      if (!fs.existsSync(abs)) continue;
      const blob = git(cwd, ["hash-object", "-w", abs]).trim();
      git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${inRepo(file)}`], { env });
      files.push(inRepo(file));
    }
    if (!files.length) throw new Error("the edits produce no change against the current commit");
    // Matcher overrides made in the editor travel with the proposal.
    const ovAbs = path.resolve(cwd, overridesFile);
    if (fs.existsSync(ovAbs)) {
      let committed = null;
      try {
        committed = git(cwd, ["show", `${head}:${inRepo(overridesFile)}`]);
      } catch {
        /* not tracked yet */
      }
      const now = fs.readFileSync(ovAbs, "utf8");
      if (now !== committed) {
        const blob = git(cwd, ["hash-object", "-w", ovAbs]).trim();
        git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${inRepo(overridesFile)}`], { env });
        files.push(inRepo(overridesFile));
      }
    }
    const tree = git(cwd, ["write-tree"], { env }).trim();
    const message = `${title.trim()}\n\n${note.trim() ? note.trim() + "\n\n" : ""}Proposed with Loupe.\n`;
    const commit = git(cwd, ["commit-tree", tree, "-p", head, "-m", message]).trim();
    const branch = `loupe/${stamp()}-${slug(title)}`;
    git(cwd, ["update-ref", `refs/heads/${branch}`, commit]);
    let verification = null;
    if (verify && verify.build) {
      verification = await verifyCommit({ cwd, commit, prefix, ops, verify });
      if (!verification.build.ok) push = false; // keep the branch for inspection, never push a broken build
    }
    const summary = verificationSummary(verification);
    const prBody = `${note.trim() ? note.trim() + "\n\n" : ""}${summary ? summary + "\n\n" : ""}Proposed with Loupe.`;
    const diffstat = git(cwd, ["diff", "--stat", head, commit]).trim();
    const uploaded = new Set(uploads.map(inRepo));
    // ":/" makes the pathspec top-level relative, matching the paths we wrote into the tree.
    const diff = git(cwd, ["diff", head, commit, "--", ...files.filter((f) => !uploaded.has(f)).map((f) => `:/${f}`)]);

    let pushed = false, url = null, pushError = null;
    if (push && info.remoteUrl) {
      try {
        git(cwd, ["push", remote, `${branch}:${branch}`]);
        pushed = true;
      } catch (e) {
        pushError = String(e.stderr || e.message).trim();
      }
    }
    if (pushed && info.owner) {
      if (token) {
        url = await createPullRequest({ owner: info.owner, repo: info.repo, token, head: branch, base: info.base, title, body: prBody });
      } else {
        const q = new URLSearchParams({ expand: "1", title, body: prBody });
        url = `https://github.com/${info.owner}/${info.repo}/compare/${info.base}...${branch}?${q}`;
      }
    }
    return { branch, commit, base: info.base, files, diffstat, diff, pushed, pushError, url, prCreated: Boolean(url && token), verification };
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}
