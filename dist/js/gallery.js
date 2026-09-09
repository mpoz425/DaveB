(function () {
  "use strict";

  var grid = document.getElementById("grid");
  var lb = document.getElementById("lightbox");
  if (!grid || !lb) return;

  var shots = Array.prototype.slice.call(grid.querySelectorAll(".shot"));
  var img = document.getElementById("lb-img");
  var nEl = document.getElementById("lb-n");
  var placeEl = document.getElementById("lb-place");
  var stockEl = document.getElementById("lb-stock");
  var cur = -1;
  var lastFocus = null;

  function frameLabel(i) {
    // Film frame numbering: 1, 1A, 2, 2A ... purely decorative, but it feels right.
    var n = Math.floor(i / 2) + 1;
    return i % 2 ? n + "A" : String(n);
  }

  function show(i) {
    if (i < 0) i = shots.length - 1;
    if (i >= shots.length) i = 0;
    cur = i;
    var s = shots[i];
    img.src = s.getAttribute("data-full");
    img.alt = s.getAttribute("data-alt") || "";
    nEl.textContent = String(i + 1);
    placeEl.textContent = (s.getAttribute("data-place") || "") ;
    var stock = s.getAttribute("data-stock") || "";
    stockEl.innerHTML = stock ? "<b>" + stock + "</b>" : "35mm";
    var loc = placeEl.textContent;
    placeEl.textContent = loc ? loc + "  ·  frame " + frameLabel(i) : "frame " + frameLabel(i);

    // Preload neighbours for snappy arrows.
    [i + 1, i - 1].forEach(function (j) {
      var t = shots[(j + shots.length) % shots.length];
      var pre = new Image();
      pre.src = t.getAttribute("data-full");
    });
    if (history.replaceState) history.replaceState(null, "", "#f" + (i + 1));
  }

  function open(i) {
    lastFocus = document.activeElement;
    lb.hidden = false;
    // Force a frame so the opacity transition runs.
    requestAnimationFrame(function () { lb.classList.add("is-open"); });
    document.body.style.overflow = "hidden";
    show(i);
    document.getElementById("lb-close").focus();
  }

  function close() {
    lb.classList.remove("is-open");
    document.body.style.overflow = "";
    setTimeout(function () { lb.hidden = true; img.removeAttribute("src"); }, 260);
    if (history.replaceState) history.replaceState(null, "", location.pathname);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  shots.forEach(function (s, i) {
    s.setAttribute("tabindex", "0");
    s.setAttribute("role", "button");
    s.addEventListener("click", function () { open(i); });
    s.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(i); }
    });
  });

  document.getElementById("lb-close").addEventListener("click", close);
  document.getElementById("lb-prev").addEventListener("click", function () { show(cur - 1); });
  document.getElementById("lb-next").addEventListener("click", function () { show(cur + 1); });
  lb.querySelector(".lb__stage").addEventListener("click", function (e) {
    if (e.target === e.currentTarget) close();
  });

  document.addEventListener("keydown", function (e) {
    if (lb.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") show(cur + 1);
    else if (e.key === "ArrowLeft") show(cur - 1);
  });

  /* Swipe */
  var x0 = null;
  lb.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener("touchend", function (e) {
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 50) show(dx < 0 ? cur + 1 : cur - 1);
    x0 = null;
  });

  /* Deep link: gallery.html#f12 */
  var m = /^#f(\d+)$/.exec(location.hash);
  if (m) {
    var idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < shots.length) open(idx);
  }
})();
