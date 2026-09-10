// Browser-side matching, used when Loupe fronts a framework dev server. The
// page arrives unannotated; once the framework has rendered we run the same
// matcher the server uses, annotate the live DOM, then start the overlay.
// Re-renders (hot reload, client-side routing) are picked up by observing the
// DOM and matching again.
import { match, annotate } from "/__loupe/src/match.js";

const boot = window.__loupe;
const readonlyFiles = new Set(boot.readonlyFiles || []);
let started = false;
let timer = null;

function run() {
  const result = match(document, boot.leaves, boot.bodies, { overrides: boot.overrides, page: location.pathname, readonlyFiles });
  annotate(document, result);
  for (const b of result.bindings) {
    if (b.leaves.length !== 1) continue;
    const l = b.leaves[0];
    boot.values[`${l.file}#${l.path}`] = l.value;
  }
  boot.page = location.pathname;
  boot.coverage = result.page;
  if (!started) {
    started = true;
    const s = document.createElement("script");
    s.src = "/__loupe/overlay.js";
    document.body.append(s);
  } else {
    window.dispatchEvent(new CustomEvent("loupe:rematch", { detail: result }));
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    // Leave the DOM alone while the user is typing or has unsaved previews in it.
    if (document.activeElement?.isContentEditable || document.querySelector(".loupe-pending, .loupe-dragging")) return schedule();
    run();
  }, 300);
}

const ours = (n) => n.nodeType === 1 && (n.id?.startsWith("loupe-") || n.className?.toString().startsWith("loupe-"));
const observer = new MutationObserver((records) => {
  for (const r of records) {
    const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    if (!t || t.closest("#loupe-bar, #loupe-panel, #loupe-item-tools, .loupe-tip, .loupe-menu")) continue;
    if ([...r.addedNodes].every(ours) && [...r.removedNodes].every(ours) && r.type === "childList") continue;
    schedule();
    return;
  }
});

const start = () => {
  run();
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
};
if (document.readyState === "complete") setTimeout(start, 50);
else window.addEventListener("load", () => setTimeout(start, 50));
