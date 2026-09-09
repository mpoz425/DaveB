(function () {
  "use strict";

  /* Keep the copyright year current without a rebuild */
  var yearEl = document.getElementById("year");
  if (yearEl) {
    var now = new Date().getFullYear();
    if (now > parseInt(yearEl.textContent, 10)) yearEl.textContent = String(now);
  }

  /* Mobile nav */
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("nav");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Close" : "Menu";
    });
    nav.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.textContent = "Menu";
      }
    });
  }

  /* Rotating hero word */
  var rot = document.querySelector(".rotator");
  if (rot) {
    var words = [];
    try { words = JSON.parse(rot.getAttribute("data-words") || "[]"); } catch (e) {}
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (words.length > 1 && !reduce) {
      var i = 0;
      setInterval(function () {
        var cur = rot.querySelector(".rotator__word");
        cur.classList.add("is-out");
        setTimeout(function () {
          i = (i + 1) % words.length;
          var next = document.createElement("span");
          next.className = "rotator__word";
          next.textContent = words[i];
          cur.replaceWith(next);
        }, 280);
      }, 2600);
    }
  }

  /* Reveal on scroll */
  var items = document.querySelectorAll(".reveal, .shot");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    items.forEach(function (el) { io.observe(el); });
  } else {
    items.forEach(function (el) { el.classList.add("is-in"); });
  }

  /* Highlight the nav item for the section in view (home only) */
  var links = Array.prototype.slice.call(document.querySelectorAll(".nav a[href^='#'], .nav a[href^='index.html#']"));
  var sections = links.map(function (a) {
    var id = a.getAttribute("href").split("#")[1];
    return id ? document.getElementById(id) : null;
  });
  if (links.length && sections.some(Boolean) && "IntersectionObserver" in window) {
    var so = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a, idx) {
          if (sections[idx] === en.target) a.setAttribute("aria-current", "page");
          else a.removeAttribute("aria-current");
        });
      });
    }, { rootMargin: "-40% 0px -55% 0px" });
    sections.forEach(function (s) { if (s) so.observe(s); });
  }
})();
