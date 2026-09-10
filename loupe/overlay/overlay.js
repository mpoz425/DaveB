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
  const saveBtn = el("button", { class: "loupe-btn", disabled: "", title: "Write edits to the working copy and rebuild" }, boot.canBuild ? "Save & rebuild" : "Save");
  const proposeBtn = el("button", { class: "loupe-btn loupe-primary", disabled: "", title: "Turn edits into a pull request" }, "Propose…");
  const discardBtn = el("button", { class: "loupe-btn", disabled: "" }, "Discard");
  const diffBtn = el("button", { class: "loupe-btn" }, "Changes");
  const fields = boot.fields || [];
  const fieldsBtn = el("button", { class: "loupe-btn", title: "Content that is not shown on any page" }, `Fields (${fields.length})`);
  bar.append(el("span", { id: "loupe-logo" }, "Loupe"), toggle, count, ...(fields.length ? [fieldsBtn] : []), saveBtn, ...(boot.canPropose ? [proposeBtn] : []), discardBtn, diffBtn);
  const panel = el("aside", { id: "loupe-panel", hidden: "" });
  const tools = el("div", { id: "loupe-item-tools", hidden: "" });
  const upBtn = el("button", { title: "Move up / left" }, "↑");
  const downBtn = el("button", { title: "Move down / right" }, "↓");
  const addBtn = el("button", { title: "Add a new item after this one" }, "+");
  const dupBtn = el("button", { title: "Duplicate" }, "⧉");
  const delBtn = el("button", { title: "Delete", class: "loupe-danger" }, "✕");
  tools.append(upBtn, downBtn, addBtn, dupBtn, delBtn);
  document.body.append(bar, panel, tools);

  toggle.onclick = () => setEditing(!editing);
  discardBtn.onclick = () => location.reload();
  saveBtn.onclick = save;
  proposeBtn.onclick = proposeDialog;
  diffBtn.onclick = showDiff;
  fieldsBtn.onclick = showFields;
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
    saveBtn.disabled = discardBtn.disabled = proposeBtn.disabled = n === 0;
  }
  // A duplicated item carries the same refs as its source, so edits inside
  // list items are keyed per item element.
  const itemIds = new WeakMap();
  let nextItemId = 1;
  function keyFor(ref, node) {
    const item = node?.closest?.("[data-edit-item]");
    if (!item || !listFor(item)) return ref;
    if (!itemIds.has(item)) itemIds.set(item, nextItemId++);
    return `${ref}@${itemIds.get(item)}`;
  }
  function getPending(ref, node) {
    return pending.get(keyFor(ref, node));
  }
  function setPending(ref, op, node) {
    pending.set(keyFor(ref, node), { ...op, node });
    if (node) node.classList.add("loupe-pending");
    refresh();
  }
  function clearPending(ref, node) {
    pending.delete(keyFor(ref, node));
    if (node) node.classList.remove("loupe-pending");
    refresh();
  }
  // Ops as the server should apply them: list reorders first, then value
  // edits with their array indices translated to where the item now sits
  // (items may have been moved, added or duplicated since the page loaded).
  function finalOps() {
    const reorders = [], sets = [];
    for (const p of pending.values()) {
      const { node, ...op } = p;
      if (op.op === "reorder") reorders.push(op);
      else sets.push({ op, node });
    }
    const out = [...reorders];
    for (const { op, node } of sets) {
      let ref = op.ref;
      const item = node?.closest?.("[data-edit-item]");
      const st = item && listFor(item);
      if (st) {
        const c = item.parentElement.closest("[data-edit-list]");
        const orig = st.entries.get(item);
        const origIndex = typeof orig === "object" ? (orig.copyOf ?? orig.blankFrom) : orig;
        const now = items(c).indexOf(item);
        const prefix = `${st.key}[${origIndex}]`;
        if (now >= 0 && ref.startsWith(prefix)) ref = `${st.key}[${now}]${ref.slice(prefix.length)}`;
      }
      out.push({ ...op, ref });
    }
    return out;
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
    let value = values[ref];
    if (value === undefined) return flash(node, "No source value for this element.");
    if (node.closest(".loupe-blank")) value = node.textContent; // fresh item: no source value yet
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
    const current = getPending(ref, node)?.value ?? values[ref];
    const ta = el("textarea", { class: "loupe-ta", spellcheck: "true" });
    ta.value = String(current);
    const hint = el("p", { class: "loupe-hint" }, rich ? "Markdown source. The rendered page updates after Save & rebuild." : "This value contains line breaks or markup, so it is edited as source.");
    const apply = el("button", { class: "loupe-btn loupe-primary" }, "Apply");
    apply.onclick = () => {
      if (ta.value !== String(values[ref])) {
        setPending(ref, { op: "set", ref, value: ta.value }, node);
        if (!rich) previewText(node, ta.value);
        for (const part of document.querySelectorAll(`[data-edit-rich="${cssEscape(ref)}"]`)) part.classList.add("loupe-pending");
      } else clearPending(ref, node);
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
    src.value = getPending(ref, img)?.value ?? values[ref] ?? img.getAttribute("src");
    const preview = el("img", { class: "loupe-preview", src: img.currentSrc || img.src });
    src.oninput = () => (preview.src = src.value);
    const fields = [el("label", {}, "Image URL"), src, preview];
    if (boot.canUpload) {
      const drop = el("div", { class: "loupe-drop" }, "Drop an image here or click to choose a file");
      const file = el("input", { type: "file", accept: "image/*", hidden: "" });
      drop.onclick = () => file.click();
      drop.ondragover = (e) => {
        e.preventDefault();
        drop.classList.add("loupe-drop-over");
      };
      drop.ondragleave = () => drop.classList.remove("loupe-drop-over");
      const take = async (f) => {
        drop.classList.remove("loupe-drop-over");
        if (!f) return;
        drop.textContent = `Uploading ${f.name}…`;
        try {
          const { url } = await upload(f);
          src.value = url;
          preview.src = url;
          drop.textContent = `Uploaded ${f.name}`;
        } catch (err) {
          drop.textContent = `Upload failed: ${err.message}`;
        }
      };
      drop.ondrop = (e) => {
        e.preventDefault();
        take(e.dataTransfer.files[0]);
      };
      file.onchange = () => take(file.files[0]);
      fields.push(drop, file);
    }
    let alt;
    if (altRef) {
      alt = el("input", { class: "loupe-input", type: "text" });
      alt.value = getPending(altRef, img)?.value ?? values[altRef] ?? img.alt;
      fields.push(el("label", {}, "Alt text"), alt);
    }
    const apply = el("button", { class: "loupe-btn loupe-primary" }, "Apply");
    apply.onclick = () => {
      setImage(img, ref, src.value);
      if (alt && alt.value !== String(values[altRef])) {
        setPending(altRef, { op: "set", ref: altRef, value: alt.value }, img);
        img.alt = alt.value;
      }
      closePanel();
    };
    openPanel(ref, ...fields, el("p", { class: "loupe-hint" }, boot.canUpload ? "Or paste a URL / a path under the site's assets." : "Paste a URL or a path under the site's assets. Start the server with --uploads to drop files."), el("div", { class: "loupe-actions" }));
    panel.lastChild.append(apply);
    src.focus();
  }
  function setImage(img, ref, value) {
    if (value === String(values[ref])) return clearPending(ref, img);
    setPending(ref, { op: "set", ref, value }, img);
    img.removeAttribute("srcset");
    img.src = value;
    // Sibling <source> elements would override the new src.
    if (img.parentElement?.tagName === "PICTURE") for (const s of img.parentElement.querySelectorAll("source")) s.remove();
  }
  async function upload(file) {
    const res = await fetch(`/__loupe/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "upload failed");
    return out;
  }
  // Drop a file straight onto an editable image.
  document.addEventListener("dragover", (e) => {
    if (!editing || !boot.canUpload || dragging || !e.dataTransfer?.types?.includes("Files")) return;
    if (e.target.closest?.("img[data-edit-attr-src]")) e.preventDefault();
  });
  document.addEventListener("drop", async (e) => {
    if (!editing || !boot.canUpload || dragging) return;
    const img = e.target.closest?.("img[data-edit-attr-src]");
    const f = e.dataTransfer?.files?.[0];
    if (!img || !f) return;
    e.preventDefault();
    img.classList.add("loupe-uploading");
    try {
      const { url } = await upload(f);
      setImage(img, img.getAttribute("data-edit-attr-src"), url);
    } catch (err) {
      flash(img, `Upload failed: ${err.message}`);
    } finally {
      img.classList.remove("loupe-uploading");
    }
  });

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
    } else {
      pending.set(ref, { op: "reorder", ref, order, node: c });
      c.classList.add("loupe-pending");
    }
    refresh();
  }
  function insertAfter(source, entry, blankIt) {
    const c = source.parentElement.closest("[data-edit-list]");
    const st = listFor(source);
    const copy = source.cloneNode(true);
    copy.classList.remove("loupe-pending");
    for (const n of copy.querySelectorAll(".loupe-pending")) n.classList.remove("loupe-pending");
    if (blankIt) {
      copy.classList.add("loupe-blank");
      for (const t of copy.querySelectorAll("[data-edit]")) {
        if (t.children.length) continue; // keep icons etc.; the text node inside is edited later
        t.textContent = "New text";
      }
    }
    st.entries.set(copy, entry);
    source.after(copy);
    copy.draggable = true;
    commitList(c);
    tools.hidden = true;
    return copy;
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
  const sourceIndex = (item) => {
    const e = listFor(item).entries.get(item);
    return typeof e === "object" ? (e.copyOf ?? e.blankFrom) : e;
  };
  dupBtn.onclick = () => hovered && insertAfter(hovered, { copyOf: sourceIndex(hovered) });
  addBtn.onclick = () => {
    if (!hovered) return;
    const copy = insertAfter(hovered, { blankFrom: sourceIndex(hovered) }, true);
    copy.scrollIntoView({ block: "nearest" });
    flash(copy, "New item added. Click each field to fill it in.");
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

  // ---------- save / propose / diff ----------
  async function save() {
    saveBtn.disabled = true;
    saveBtn.textContent = boot.canBuild ? "Saving & rebuilding…" : "Saving…";
    const ops = finalOps();
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
  // Human-readable label for a ref: "bucket_list › 2 › venue".
  function labelFor(ref) {
    const [file, p = ""] = ref.split("#");
    const name = file.split("/").pop().replace(/\.(json|ya?ml|toml|md|markdown)$/i, "");
    const parts = p.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
    return [name, ...parts].join(" › ");
  }
  function summarizeOrder(order, initial) {
    const removed = initial.filter((i) => !order.includes(i)).length;
    const added = order.filter((o) => typeof o === "object").length;
    const kept = order.filter((o) => typeof o !== "object");
    const moved = JSON.stringify(kept) !== JSON.stringify(initial.filter((i) => kept.includes(i)));
    const bits = [];
    if (moved) bits.push("reordered");
    if (added) bits.push(`${added} added`);
    if (removed) bits.push(`${removed} removed`);
    return bits.join(", ") || "unchanged";
  }
  function redline(ops) {
    const list = el("ul", { class: "loupe-redline" });
    for (const op of ops) {
      const li = el("li");
      li.append(el("span", { class: "loupe-ref" }, labelFor(op.ref)));
      if (op.op === "reorder") {
        const st = [...listState.values()].find((s) => s.key === op.ref);
        li.append(el("span", { class: "loupe-ins" }, `list ${summarizeOrder(op.order, st ? JSON.parse(st.initial) : [])}`));
      } else {
        const old = values[op.ref];
        const trunc = (s) => (s.length > 160 ? s.slice(0, 157) + "…" : s);
        if (old !== undefined && String(old) !== "") li.append(el("del", { class: "loupe-del" }, trunc(String(old))));
        li.append(el("ins", { class: "loupe-ins" }, trunc(String(op.value)) || "(empty)"));
      }
      list.append(li);
    }
    return list;
  }
  function autoTitle(ops) {
    const names = [...new Set(ops.map((o) => labelFor(o.ref).split(" › ")[0]))];
    const verb = ops.every((o) => o.op === "reorder") ? "Reorder" : "Update";
    return `${verb} ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
  }
  function proposeDialog() {
    const ops = finalOps();
    const title = el("input", { class: "loupe-input", type: "text", placeholder: "What changed?" });
    title.value = autoTitle(ops);
    const note = el("textarea", { class: "loupe-ta loupe-ta-short", placeholder: "Optional note for whoever reviews this" });
    const go = el("button", { class: "loupe-btn loupe-primary" }, "Create proposal");
    const status = el("p", { class: "loupe-hint" }, `A pull request against ${boot.base || "the main branch"}. Your working copy is not touched.`);
    go.onclick = async () => {
      if (!title.value.trim()) return title.focus();
      go.disabled = true;
      go.textContent = "Creating…";
      try {
        const res = await fetch("/__loupe/propose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops, title: title.value, note: note.value }) });
        const out = await res.json();
        if (!res.ok) throw new Error(out.error || "proposal failed");
        showProposal(out);
      } catch (e) {
        go.disabled = false;
        go.textContent = "Create proposal";
        status.textContent = `Failed: ${e.message}`;
        status.classList.add("loupe-error");
      }
    };
    openPanel("Propose these changes", el("label", {}, "Title"), title, el("label", {}, "Note"), note, el("label", {}, `${ops.length} change${ops.length === 1 ? "" : "s"}`), redline(ops), status, el("div", { class: "loupe-actions" }));
    panel.lastChild.append(go);
    title.focus();
    title.select();
  }
  function showProposal(out) {
    const children = [];
    if (out.url) {
      const a = el("a", { class: "loupe-btn loupe-primary loupe-link", href: out.url, target: "_blank", rel: "noopener" }, out.prCreated ? "Open the pull request" : "Open GitHub to finish the pull request");
      children.push(a);
      if (!out.prCreated) children.push(el("p", { class: "loupe-hint" }, "The branch is pushed; GitHub will show a pre-filled form. Set LOUPE_GITHUB_TOKEN on the server to create pull requests directly."));
    } else if (out.pushed === false) {
      children.push(el("p", { class: "loupe-hint loupe-error" }, out.pushError ? `Branch created locally but not pushed: ${out.pushError}` : "Branch created locally (push disabled)."));
    }
    children.push(el("label", {}, "Branch"), el("code", { class: "loupe-code" }, out.branch), el("label", {}, "Files"), el("pre", { class: "loupe-pre" }, out.diffstat || out.files.join("\n")));
    const pre = el("pre", { class: "loupe-pre loupe-diff" });
    for (const line of (out.diff || "").split("\n")) {
      const cls = line.startsWith("+++") || line.startsWith("---") ? "loupe-d-file" : line.startsWith("+") ? "loupe-d-add" : line.startsWith("-") ? "loupe-d-del" : line.startsWith("@@") ? "loupe-d-hunk" : "";
      pre.append(el("span", { class: cls }, line + "\n"));
    }
    const done = el("button", { class: "loupe-btn" }, "Done (reload page)");
    done.onclick = () => location.reload();
    openPanel("Proposal created", ...children, el("label", {}, "Diff"), pre, el("div", { class: "loupe-actions" }));
    panel.lastChild.append(done);
    pending.clear();
    refresh();
  }
  // ---------- fields drawer: content no page renders ----------
  function fieldWidget(f) {
    const current = getPending(f.ref)?.value ?? f.value;
    let input;
    if (f.type === "boolean") {
      input = el("input", { type: "checkbox", class: "loupe-check" });
      input.checked = current === true || current === "true";
    } else if (f.type === "markdown" || /\n/.test(String(current)) || String(current).length > 90) {
      input = el("textarea", { class: "loupe-ta loupe-ta-short" });
      input.value = String(current);
    } else {
      input = el("input", { class: "loupe-input", type: "text", inputmode: f.type === "number" ? "decimal" : "text" });
      input.value = String(current);
    }
    if (getPending(f.ref)) input.classList.add("loupe-pending");
    const commit = () => {
      const v = f.type === "boolean" ? String(input.checked) : input.value;
      if (v === String(f.value)) {
        clearPending(f.ref, null);
        input.classList.remove("loupe-pending");
      } else {
        setPending(f.ref, { op: "set", ref: f.ref, value: f.type === "boolean" ? input.checked : v }, null);
        input.classList.add("loupe-pending");
      }
    };
    input.addEventListener("change", commit);
    if (input.tagName !== "INPUT" || input.type !== "checkbox") input.addEventListener("blur", commit);
    return input;
  }
  function fieldRow(f, label) {
    const row = el("div", { class: "loupe-field" });
    row.append(el("label", { title: f.ref }, label), fieldWidget(f));
    return row;
  }
  function showFields() {
    const search = el("input", { class: "loupe-input", type: "search", placeholder: "Filter fields…" });
    const body = el("div", { class: "loupe-fields" });
    const render = (q = "") => {
      body.replaceChildren();
      const needle = q.trim().toLowerCase();
      const byFile = new Map();
      for (const f of fields) {
        if (needle && !(f.ref.toLowerCase().includes(needle) || String(f.value).toLowerCase().includes(needle))) continue;
        const file = f.ref.split("#")[0];
        if (!byFile.has(file)) byFile.set(file, { onPage: f.onPage, list: [] });
        byFile.get(file).list.push(f);
      }
      const files = [...byFile.entries()].sort((a, b) => Number(b[1].onPage) - Number(a[1].onPage) || a[0].localeCompare(b[0]));
      if (!files.length) body.append(el("p", { class: "loupe-hint" }, "Nothing matches."));
      for (const [file, { onPage, list }] of files) {
        const section = el("section", { class: "loupe-file" });
        section.append(el("h3", {}, file), onPage ? el("span", { class: "loupe-badge" }, "used on this page") : "");
        // Repeated array keys ("[3].med", "[7].med") fold into one expandable row.
        const groups = new Map();
        for (const f of list) {
          const pattern = f.ref.split("#")[1].replace(/\[\d+\]/g, "[]");
          if (!groups.has(pattern)) groups.set(pattern, []);
          groups.get(pattern).push(f);
        }
        for (const [pattern, fs] of groups) {
          if (fs.length === 1) {
            section.append(fieldRow(fs[0], labelFor(fs[0].ref).split(" › ").slice(1).join(" › ") || labelFor(fs[0].ref)));
            continue;
          }
          const det = el("details", { class: "loupe-group" });
          det.append(el("summary", {}, `${pattern.replace(/\[\]/g, " › item").replace(/^\./, "").replace(/\./g, " › ") || "items"} × ${fs.length}`));
          for (const f of fs) {
            const idx = (f.ref.match(/\[(\d+)\]/g) || []).map((m) => m.slice(1, -1)).join(".");
            det.append(fieldRow(f, `#${idx}`));
          }
          section.append(det);
        }
        body.append(section);
      }
    };
    search.oninput = () => render(search.value);
    render();
    openPanel("Fields not shown on any page", el("p", { class: "loupe-hint" }, "These values exist in the content but the matcher found no place on the site where they appear, so they are edited here as fields. Edits count toward Save and Propose like any other."), search, body);
    search.focus();
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
