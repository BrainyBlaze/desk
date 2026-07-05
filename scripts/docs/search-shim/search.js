/*
 * Self-hosted docs search shim.
 *
 * Mintlify's built-in search is a hosted (cloud) feature; the static `mint
 * export` we self-host ships no search backend, so its search bar falls back to
 * "Login into CLI to enable search". This shim replaces that login-gated flow
 * with a Pagefind modal backed by a static index built from the exported HTML
 * at deploy time (see .github/workflows/docs.yml).
 *
 * It is injected into every page's <head> at build time and lives OUTSIDE the
 * docs source tree so `mint` never inlines or rewrites it.
 */
(function () {
  "use strict";

  var MODAL_ID = "pf-search-modal";
  var inited = false;

  function isDark() {
    var el = document.documentElement;
    if (el.classList.contains("dark")) return true;
    if (el.classList.contains("light")) return false;
    var dt = el.getAttribute("data-theme");
    if (dt) return dt === "dark";
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function applyTheme() {
    var m = document.getElementById(MODAL_ID);
    if (m) m.setAttribute("data-pf-theme", isDark() ? "dark" : "light");
  }

  function loadCss(href) {
    if (document.querySelector('link[data-pf="1"][href="' + href + '"]')) return;
    var l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    l.setAttribute("data-pf", "1");
    document.head.appendChild(l);
  }

  function ensureModal() {
    if (document.getElementById(MODAL_ID)) return;
    var overlay = document.createElement("div");
    overlay.id = MODAL_ID;
    overlay.className = "pf-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Search documentation");
    overlay.innerHTML =
      '<div class="pf-panel" role="document">' +
      '<div class="pf-panel-head">' +
      '<span class="pf-hint">Search the docs</span>' +
      '<button type="button" class="pf-close" aria-label="Close search">Esc</button>' +
      "</div>" +
      '<div id="pf-search"></div>' +
      "</div>";
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) closeModal();
    });
    overlay.querySelector(".pf-close").addEventListener("click", closeModal);
  }

  // pagefind-ui.js is a classic (UMD) script that defines a global
  // `PagefindUI`; it is NOT an ES module, so it must be loaded via a <script>
  // tag rather than import().
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.PagefindUI) return resolve();
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function initUI() {
    if (inited) return Promise.resolve();
    inited = true;
    loadCss("/pagefind/pagefind-ui.css");
    return loadScript("/pagefind/pagefind-ui.js")
      .then(function () {
        if (!window.PagefindUI) throw new Error("PagefindUI global missing");
        new window.PagefindUI({
          element: "#pf-search",
          showSubResults: true,
          showImages: false,
          resetStyles: false,
          autofocus: true
        });
      })
      .catch(function () {
        var box = document.getElementById("pf-search");
        if (box) box.innerHTML = '<p class="pf-error">Search is unavailable right now.</p>';
        inited = false;
      });
  }

  function isOpen() {
    var m = document.getElementById(MODAL_ID);
    return !!(m && m.classList.contains("pf-open"));
  }

  function openModal() {
    ensureModal();
    applyTheme();
    var m = document.getElementById(MODAL_ID);
    m.classList.add("pf-open");
    document.documentElement.classList.add("pf-lock");
    initUI().then(function () {
      var input = m.querySelector("input");
      if (input) input.focus();
    });
  }

  function closeModal() {
    var m = document.getElementById(MODAL_ID);
    if (m) m.classList.remove("pf-open");
    document.documentElement.classList.remove("pf-lock");
  }

  function isTrigger(target) {
    if (!target || !target.closest) return false;
    return target.closest(
      "#search-bar-entry, [aria-label='Open search'], [aria-label='Search']"
    );
  }

  // Intercept Mintlify's search triggers in the capture phase so the
  // login-gated modal never opens.
  document.addEventListener(
    "click",
    function (e) {
      if (isTrigger(e.target)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openModal();
      }
    },
    true
  );

  document.addEventListener(
    "keydown",
    function (e) {
      var k = (e.key || "").toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "k") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (isOpen()) closeModal();
        else openModal();
      } else if (k === "escape" && isOpen()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeModal();
      }
    },
    true
  );

  // Track theme toggles while the modal is open.
  try {
    new MutationObserver(applyTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"]
    });
  } catch (e) {
    /* no-op */
  }
})();
