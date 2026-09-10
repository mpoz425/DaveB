// Loupe overlay: edit a page in place using the data-edit* annotations the
// matcher produced, then send the edits to the dev server as a patch.
(() => {
  const boot = window.__loupe || { values: {} };
  const values = boot.values;
  const pending = new Map(); // ref -> op
  const listState = new Map(); // container -> { key, initial: string, entries: WeakMap(item -> index|{copyOf}) }
  let editing = true;

  // ---------- UI scaffolding ----------
  const bar = el("div", { id: "loupe-bar" });
  const toggle = el("button", { class: "loupe-btn", title: "Toggle edit mode (E)" }, "Editing");
  const count = el("span", { id: "loupe-count" }, "0 changes");
  const saveBtn = el("button", { class: "loupe-btn loupe-primary", disabled: "" }, boot.canBuild ? "Save & rebuild" : "Save");
  const discardBtn = el("button", { class: "loupe-btn", disabled: "" }, "Discard");
  const diffBtn = el("button", { class: "loupe-btn" }, "Changes");
  bar.append(el("span", { id: "loupe-logo" }, "Loupe"), toggle, count, saveBtn, discardBtn, diffBtn);
  const panel = el("aside", { id: "loupe-panel", hidden: "" });
  const tools = el("div", { id: "loupe-item-tools", hidden: "" });
  const upBtn = el("button", { title: "Move up / left" }, "↑");
  const downBtn = el("button", { title: "Move down / right" }, "↓");
  const dupBtn = el("button", { title: "Duplicate" }, "⧉");
  const delBtn = el("button", { title: "Delete", class: "loupe-danger" }, "✕");
  tools.append(upBtn, downBtn, dupBtn, delBtn);
  document.body.append(bar, panel, tools);

  toggle.onclick = () => setEditing(!editing);
  discardBtn.onclick = () => location.reload();
  saveBtn.onclick = save;
  diffBtn.onclick = showDiff;
  document.addEventListener("keydown", (e) => {
    if (e.key === "e" && !e.metaKey && !e.ctrlKey && !isTyping(e.target)) setEditing(!editing);
    if (e.key === "Escape") closePanel();
  });

  function el(tag, attrs = {}, text) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function isTyping(t) {
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName));
  }
  function setEditing(on) {
    editing = on;
    document.documentElement.classList.toggle("loupe-on", on);
    toggle.textContent = on ? "Editing" : "Edit";
    toggle.classList.toggle("loupe-active", on);
    for (const item of document.querySelectorAll("[data-edit-item]")) item.draggable = on && !!listFor(item);
    if (!on) {
      tools.hidden = true;
      closePanel();
    }
  }
  function refresh() {
    const n = pending.size;
    count.textContent = `${n} change${n === 1 ? "" : "s"}`;
    saveBtn.disabled = discardBtn.disabled = n === 0;
  }
  function setPending(ref, op, node) {
    pending.set(ref, op);
    if (node) node.classList.add("loupe-pending");
    refresh();
  }
  function openPanel(title, ...children) {
    panel.replaceChildren(el("header", {}, title), ...children);
    const close = el("button", { class: "loupe-btn loupe-close", title: "Close (Esc)" }, "×");
    close.onclick = closePanel;
    panel.firstChild.append(close);
    panel.hidden = false;
  }
  function closePanel() {
    panel.hidden = true;
  }

  // ---------- click routing ----------
  document.addEventListener(
    "click",
    (e) => {
      if (!editing || bar.contains(e.target) || panel.contains(e.target) || tools.contains(e.target)) return;
      if (e.target.isContentEditable) return;
      const rich = e.target.closest("[data-edit-rich]");
      const plain = e.target.closest("[data-edit]");
      const img = e.target.closest("img[data-edit-attr-src]");
      const blocked = e.target.closest("[data-edit-partial], [data-edit-ambiguous]");
      const hit = pick(e.target, [rich, plain, img]);
      if (hit || blocked || e.target.closest("a, button")) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (img && hit === img) return editImage(img);
      if (hit && hit === rich) return editText(rich, rich.getAttribute("data-edit-rich"), true);
      if (hit && hit === plain) return editText(plain, plain.getAttribute("data-edit"), false);
      if (blocked) return flash(blocked, blocked.hasAttribute("data-edit-ambiguous") ? "This text has several possible sources; not editable yet." : "Several values share this text node; not editable yet.");
    },
    true,
  );
  // Deepest annotated ancestor wins.
  function pick(target, candidates) {
    let best = null;
    for (const c of candidates) if (c && (!best || best.contains(c))) best = c;
    return best;
  }
  function flash(node, msg) {
    const tip = el("div", { class: "loupe-tip" }, msg);
    document.body.append(tip);
    const r = node.getBoundingClientRect();
    tip.style.top = `${window.scrollY + r.bottom + 6}px`;
    tip.style.left = `${window.scrollX + r.left}px`;
    setTimeout(() => tip.remove(), 2200);
  }

  // ---------- text editing ----------
  function needsPanel(value) {
    return /\n|<[a-z!/]|[*_`#]|\]\(/.test(value);
  }
  function editText(node, ref, rich) {
    const value = values[ref];
    if (value === undefined) return flash(node, "No source value for this element.");
    if (rich || needsPanel(String(value))) return editInPanel(node, ref, rich);
    // Bound to a text node inside an element with other children (icons, badges):
    // wrap just that text node so the rest survives.
    let target = node;
    if (node.children.length) {
      const tn = findTextNode(node, String(value));
      if (!tn) return editInPanel(node, ref, false);
      const wrap = el("span", { class: "loupe-wrap" });
      tn.parentNode.insertBefore(wrap, tn);
      wrap.append(tn);
      target = wrap;
    }
    const before = target.textContent;
    target.setAttribute("contenteditable", "plaintext-only");
    if (!target.isContentEditable) target.setAttribute("contenteditable", "true");
    target.focus();
    selectAll(target);
    const finish = (cancel) => {
      target.removeAttribute("contenteditable");
      target.removeEventListener("blur", onBlur);
      target.removeEventListener("keydown", onKey);
      let after = target.textContent;
      if (cancel) target.textContent = after = before;
      if (target !== node) {
        const parent = target.parentNode;
        while (target.firstChild) parent.insertBefore(target.firstChild, target);
        target.remove();
      }
      if (!cancel && after !== before) setPending(ref, { op: "set", ref, value: after }, node);
    };
    const onBlur = () => finish(false);
    const onKey = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        target.blur();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        target.removeEventListener("blur", onBlur);
        finish(true);
      }
    };
    target.addEventListener("blur", onBlur);
    target.addEventListener("keydown", onKey);
  }
  function findTextNode(root, value) {
    const want = fold(value);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) if (fold(n.textContent) === want || (want.length > 3 && fold(n.textContent).includes(want))) return n;
    return null;
  }
  function fold(s) {
    return String(s).replace(/\s+/g, " ").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u2014/g, "--").replace(/\u2013/g, "-").replace(/\u2026/g, "...").trim().toLowerCase();
  }
  function selectAll(node) {
    const r = document.createRange();
    r.selectNodeContents(node);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  function editInPanel(node, ref, rich) {
    const current = pending.get(ref)?.value ?? values[ref];
    const ta = el("textarea", { class: "loupe-ta", spellcheck: "true" });
    ta.value = String(current);
    const hint = el("p", { class: "loupe-hint" }, rich ? "Markdown source. The rendered page updates after Save & rebuild." : "This value contains line breaks or markup, so it is edited as source.");
    const apply = el("button", { class: "loupe-btn loupe-primary" }, "Apply");
    apply.onclick = () => {
      if (ta.value !== String(values[ref])) {
        setPending(ref, { op: "set", ref, value: ta.value }, node);
        if (!rich) previewText(node, ta.value);
        for (const part of document.querySelectorAll(`[data-edit-rich="${cssEscape(ref)}"]`)) part.classList.add("loupe-pending");
      } else {
        pending.delete(ref);
        node.classList.remove("loupe-pending");
        refresh();
      }
      closePanel();
    };
    openPanel(ref, hint, ta, el("div", { class: "loupe-actions" }, ""));
    panel.lastChild.append(apply);
    ta.focus();
  }
  function previewText(node, value) {
    if (/<[a-z!/]/.test(value)) return;
    node.replaceChildren(...value.split("\n").flatMap((line, i) => (i ? [el("br"), document.createTextNode(line)] : [document.createTextNode(line)])));
  }
  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
  }

  // ---------- images ----------
  function editImage(img) {
    const ref = img.getAttribute("data-edit-attr-src");
    const altRef = img.getAttribute("data-edit-attr-alt");
    const src = el("input", { class: "loupe-input", type: "text" });
    src.value = pending.get(ref)?.value ?? values[ref] ?? img.getAttribute("src");
    const preview = el("img", { class: "loupe-preview", src: img.currentSrc || img.src });
    src.oninput = () => (preview.src = src.value);
    const fields = [el("label", {}, "Image URL"), src, preview];
    let alt;
    if (altRef) {
      alt = el("input", { class: "loupe-input", type: "text" });
      alt.value = pending.get(altRef)?.value ?? values[altRef] ?? img.alt;
      fields.push(el("label", {}, "Alt text"), alt);
    }
    const apply = el("button", { class: "loupe-btn loupe-primary" }, "Apply");
    apply.onclick = () => {
      if (src.value !== String(values[ref])) {
        setPending(ref, { op: "set", ref, value: src.value }, img);
        img.removeAttribute("srcset");
        img.src = src.value;
      }
      if (alt && alt.value !== String(values[altRef])) {
        setPending(altRef, { op: "set", ref: altRef, value: alt.value }, img);
        img.alt = alt.value;
      }
      closePanel();
    };
    openPanel(ref, ...fields, el("p", { class: "loupe-hint" }, "Paste a URL or a path under the site's assets. Uploading files is the next step."), el("div", { class: "loupe-actions" }));
    panel.lastChild.append(apply);
    src.focus();
  }

  // ---------- lists ----------
  function listFor(item) {
    const c = item.parentElement?.closest("[data-edit-list]");
    if (!c || c.hasAttribute("data-edit-list-partial")) return null;
    if (!listState.has(c)) {
      const key = c.getAttribute("data-edit-list");
      const entries = new WeakMap();
      for (const it of items(c)) {
        const m = it.getAttribute("data-edit-item").match(/\[(\d+)\]$/);
        if (m) entries.set(it, Number(m[1]));
      }
      listState.set(c, { key, entries, initial: JSON.stringify(orderOf(c, entries)) });
    }
    return listState.get(c);
  }
  function items(c) {
    return Array.from(c.children).filter((x) => x.hasAttribute("data-edit-item"));
  }
  function orderOf(c, entries) {
    return items(c).map((it) => entries.get(it)).filter((x) => x !== undefined);
  }
  function commitList(c) {
    const st = listState.get(c);
    const order = orderOf(c, st.entries);
    const ref = `${st.key}`;
    if (JSON.stringify(order) === st.initial) {
      pending.delete(ref);
      c.classList.remove("loupe-pending");
      refresh();
    } else setPending(ref, { op: "reorder", ref, order }, c);
  }

  let hovered = null;
  document.addEventListener("mouseover", (e) => {
    if (!editing) return;
    const item = e.target.closest?.("[data-edit-item]");
    if (!item || !listFor(item)) return;
    hovered = item;
    const r = item.getBoundingClientRect();
    tools.hidden = false;
    tools.style.top = `${window.scrollY + r.top + 4}px`;
    tools.style.left = `${window.scrollX + r.right - tools.offsetWidth - 4}px`;
  });
  document.addEventListener("mouseout", (e) => {
    if (hovered && !hovered.contains(e.relatedTarget) && !tools.contains(e.relatedTarget)) {
      tools.hidden = true;
    }
  });
  tools.addEventListener("mouseleave", (e) => {
    if (!hovered?.contains(e.relatedTarget)) tools.hidden = true;
  });
  upBtn.onclick = () => move(hovered, -1);
  downBtn.onclick = () => move(hovered, +1);
  dupBtn.onclick = () => {
    if (!hovered) return;
    const c = hovered.parentElement.closest("[data-edit-list]");
    const st = listFor(hovered);
    const copy = hovered.cloneNode(true);
    copy.classList.remove("loupe-pending");
    st.entries.set(copy, { copyOf: st.entries.get(hovered) });
    hovered.after(copy);
    copy.draggable = true;
    commitList(c);
    tools.hidden = true;
  };
  delBtn.onclick = () => {
    if (!hovered) return;
    const c = hovered.parentElement.closest("[data-edit-list]");
    hovered.remove();
    hovered = null;
    commitList(c);
    tools.hidden = true;
  };
  function move(item, dir) {
    if (!item) return;
    const c = item.parentElement.closest("[data-edit-list]");
    const list = items(c);
    const i = list.indexOf(item);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    if (dir < 0) list[j].before(item);
    else list[j].after(item);
    commitList(c);
    const r = item.getBoundingClientRect();
    tools.style.top = `${window.scrollY + r.top + 4}px`;
    tools.style.left = `${window.scrollX + r.right - tools.offsetWidth - 4}px`;
  }

  let dragging = null;
  document.addEventListener("dragstart", (e) => {
    const item = e.target.closest?.("[data-edit-item]");
    if (!editing || !item || !listFor(item)) return;
    dragging = item;
    item.classList.add("loupe-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", item.getAttribute("data-edit-item"));
  });
  document.addEventListener("dragover", (e) => {
    if (!dragging) return;
    const over = e.target.closest?.("[data-edit-item]");
    if (!over || over === dragging || over.parentElement !== dragging.parentElement) return;
    e.preventDefault();
    const r = over.getBoundingClientRect();
    const horizontal = r.width < r.height * 3 && Math.abs(r.top - dragging.getBoundingClientRect().top) < r.height;
    const before = horizontal ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
    if (before) over.before(dragging);
    else over.after(dragging);
  });
  document.addEventListener("dragend", () => {
    if (!dragging) return;
    dragging.classList.remove("loupe-dragging");
    commitList(dragging.parentElement.closest("[data-edit-list]"));
    dragging = null;
  });
  document.addEventListener("drop", (e) => dragging && e.preventDefault());

  // ---------- save / diff ----------
  async function save() {
    saveBtn.disabled = true;
    saveBtn.textContent = boot.canBuild ? "Saving & rebuilding…" : "Saving…";
    const ops = Array.from(pending.values());
    try {
      const res = await fetch("/__loupe/patch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || out.build?.output || "save failed");
      location.reload();
    } catch (e) {
      saveBtn.textContent = boot.canBuild ? "Save & rebuild" : "Save";
      saveBtn.disabled = false;
      openPanel("Save failed", el("pre", { class: "loupe-pre" }, String(e.message)));
    }
  }
  async function showDiff() {
    const res = await fetch("/__loupe/diff");
    const { diff, status } = await res.json();
    const pre = el("pre", { class: "loupe-pre loupe-diff" });
    if (!diff.trim()) pre.textContent = "No saved changes yet. Edits you make here appear after Save; the list at the bottom right counts unsaved ones.";
    for (const line of diff.split("\n")) {
      const cls = line.startsWith("+++") || line.startsWith("---") ? "loupe-d-file" : line.startsWith("+") ? "loupe-d-add" : line.startsWith("-") ? "loupe-d-del" : line.startsWith("@@") ? "loupe-d-hunk" : "";
      pre.append(el("span", { class: cls }, line + "\n"));
    }
    openPanel("Saved changes (git diff)", el("p", { class: "loupe-hint" }, status.trim() ? `Modified: ${status.trim().split("\n").map((s) => s.slice(3)).join(", ")}` : "Working tree clean."), pre);
  }

  setEditing(true);
  refresh();
})();
