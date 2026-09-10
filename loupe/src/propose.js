// Turn a set of edits into a commit on a fresh branch, without touching the
// working tree or HEAD, then push it and open (or link to) a pull request.
//
// Files are patched from their HEAD version, written as blobs, assembled into
// a tree via a temporary index, and committed with HEAD as parent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { groupOps, patchText, safePath } from "./patch.js";

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

export async function propose({ ops, uploads = [], title, note = "", cwd = process.cwd(), remote = "origin", push = true, token = process.env.LOUPE_GITHUB_TOKEN || process.env.GITHUB_TOKEN }) {
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
    const tree = git(cwd, ["write-tree"], { env }).trim();
    const message = `${title.trim()}\n\n${note.trim() ? note.trim() + "\n\n" : ""}Proposed with Loupe.\n`;
    const commit = git(cwd, ["commit-tree", tree, "-p", head, "-m", message]).trim();
    const branch = `loupe/${stamp()}-${slug(title)}`;
    git(cwd, ["update-ref", `refs/heads/${branch}`, commit]);
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
        url = await createPullRequest({ owner: info.owner, repo: info.repo, token, head: branch, base: info.base, title, body: `${note.trim() ? note.trim() + "\n\n" : ""}Proposed with Loupe.` });
      } else {
        const q = new URLSearchParams({ expand: "1", title, body: `${note.trim() ? note.trim() + "\n\n" : ""}Proposed with Loupe.` });
        url = `https://github.com/${info.owner}/${info.repo}/compare/${info.base}...${branch}?${q}`;
      }
    }
    return { branch, commit, base: info.base, files, diffstat, diff, pushed, pushError, url, prCreated: Boolean(url && token) };
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}
