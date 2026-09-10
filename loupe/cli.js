#!/usr/bin/env node
// Usage:
//   node loupe/cli.js --content data --output dist [--content hugo.yaml] [--write out-dir] [--verbose]
//
// Matches every leaf value in the content files against every HTML page in the
// output directory, prints a coverage report, and optionally writes annotated
// copies of the pages (data-edit attributes) to --write.
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { loadContent } from "./src/content.js";
import { match, annotate } from "./src/match.js";

function args() {
  const a = { content: [], output: null, write: null, verbose: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--content") a.content.push(argv[++i]);
    else if (k === "--output") a.output = argv[++i];
    else if (k === "--write") a.write = argv[++i];
    else if (k === "--verbose" || k === "-v") a.verbose = true;
    else if (k === "--help" || k === "-h") {
      console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 6).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exit(0);
    }
  }
  if (!a.content.length || !a.output) {
    console.error("need --content <dir|file> (repeatable) and --output <dir>");
    process.exit(2);
  }
  return a;
}

function htmlFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort();
}

function pct(a, b) {
  return b ? `${((100 * a) / b).toFixed(1)}%` : "n/a";
}

function main() {
  const a = args();
  const { files, leaves, bodies } = loadContent(a.content);
  const pages = htmlFiles(a.output);
  if (!pages.length) {
    console.error(`no .html files under ${a.output}`);
    process.exit(1);
  }

  const everBound = new Set();
  const ambiguousLeaves = new Set();
  const tiers = {};
  const kinds = {};
  let pageTotal = 0, pageBound = 0, pageDecorative = 0, listsRegular = 0, listsIrregular = 0;
  const perPage = [];

  for (const page of pages) {
    const dom = new JSDOM(fs.readFileSync(page, "utf8"));
    const result = match(dom.window.document, leaves, bodies);
    for (const b of result.bindings) {
      if (b.ambiguous) { b.leaves.forEach((l) => ambiguousLeaves.add(l)); continue; }
      everBound.add(b.leaves[0]);
      tiers[b.tier] = (tiers[b.tier] || 0) + 1;
      kinds[b.kind] = (kinds[b.kind] || 0) + 1;
    }
    for (const l of result.lists) (l.coverage === l.of ? listsRegular++ : listsIrregular++);
    pageTotal += result.page.totalChars;
    pageBound += result.page.boundChars;
    pageDecorative += result.page.decorativeChars;
    perPage.push({ page: path.relative(a.output, page), ...result.page, bindings: result.bindings.length, lists: result.lists });
    if (a.write) {
      annotate(dom.window.document, result);
      const out = path.join(a.write, path.relative(a.output, page));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, dom.serialize());
    }
  }

  const byType = {};
  for (const l of leaves) byType[l.type] = (byType[l.type] || 0) + 1;
  const text = leaves.filter((l) => l.type === "text" || l.type === "markdown");
  const bodiesBound = bodies.filter((b) => everBound.has(b));
  const textBound = text.filter((l) => everBound.has(l));
  const textAmbiguous = text.filter((l) => !everBound.has(l) && ambiguousLeaves.has(l));
  const textUnbound = text.filter((l) => !everBound.has(l) && !ambiguousLeaves.has(l));
  const matchable = leaves.filter((l) => ["text", "url", "link", "media", "date", "number", "email", "phone", "markdown"].includes(l.type));
  const matchableBound = matchable.filter((l) => everBound.has(l));

  console.log(`\nloupe match report`);
  console.log(`  content: ${files.length} file(s), ${leaves.length} leaf values${bodies.length ? `, ${bodies.length} markdown bodies` : ""}`);
  console.log(`  output:  ${pages.length} page(s) under ${a.output}`);
  console.log(`\n  leaf values by type: ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`\n  TEXT leaves (what a person would want to edit)`);
  console.log(`    bound uniquely   ${textBound.length.toString().padStart(4)} / ${text.length}  (${pct(textBound.length, text.length)})`);
  console.log(`    ambiguous        ${textAmbiguous.length.toString().padStart(4)}`);
  console.log(`    unmatched        ${textUnbound.length.toString().padStart(4)}`);
  if (bodies.length) console.log(`  MARKDOWN bodies bound to their rendered element: ${bodiesBound.length} / ${bodies.length}`);
  console.log(`  all matchable leaves (text+url+link+media+date+number): ${matchableBound.length} / ${matchable.length} (${pct(matchableBound.length, matchable.length)})`);
  console.log(`  match tiers: ${Object.entries(tiers).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log(`  binding kinds: ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log(`  lists detected: ${listsRegular} complete, ${listsIrregular} partial (a subset of the array; summed over pages)`);
  console.log(`\n  PAGE text coverage: ${pct(pageBound, pageTotal)} of visible characters are bound to a source`);
  console.log(`    (${pct(pageBound, pageTotal - pageDecorative)} excluding aria-hidden decoration)`);
  for (const p of perPage) {
    console.log(`    ${p.page.padEnd(28)} ${pct(p.boundChars, p.totalChars).padStart(6)}  ${String(p.bindings).padStart(4)} bindings  ${p.lists.length} lists`);
    if (a.verbose) for (const l of p.lists) {
      const c = l.container;
      console.log(`        ${l.key}  ${l.coverage}/${l.of} items in <${c.tagName.toLowerCase()}${c.className ? " ." + String(c.className).split(" ")[0] : ""}>${l.duplicated ? " (rendered twice)" : ""}`);
    }
  }

  if (textUnbound.length) {
    console.log(`\n  unmatched TEXT leaves${a.verbose ? "" : " (first 25; use --verbose for all)"}:`);
    for (const l of a.verbose ? textUnbound : textUnbound.slice(0, 25)) {
      const v = String(l.value).replace(/\s+/g, " ");
      console.log(`    ${l.file}#${l.path}: "${v.length > 70 ? v.slice(0, 67) + "..." : v}"`);
    }
  }
  if (textAmbiguous.length) {
    console.log(`\n  ambiguous TEXT leaves:`);
    for (const l of textAmbiguous) console.log(`    ${l.file}#${l.path}: "${String(l.value).slice(0, 60)}"`);
  }
  if (a.write) console.log(`\n  annotated pages written to ${a.write}`);
  console.log();
}

main();
