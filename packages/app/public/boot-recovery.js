/**
 * Boot recovery — self-heal from the white-screen failure class.
 *
 * A PWA client can be left holding a cached index.html whose hashed assets no
 * longer exist (deleted by a deploy) or a corrupted precache. The result is a
 * blank page with no app code running, so nothing inside the bundle can ever
 * fix it. This script is a tiny classic (non-module) external file — CSP is
 * `script-src 'self'`, no inline scripts — loaded BEFORE the entry module so
 * it observes the entry script failing to load.
 *
 * On a definitive load failure it unregisters every service worker, deletes
 * every Cache Storage cache, and reloads once (bounded by a sessionStorage
 * counter so a hard-down server can't cause a reload loop). A 12s watchdog
 * additionally paints a minimal "Repair & reload" fallback if the app never
 * mounts — it does NOT auto-nuke on the timer alone (slow networks).
 *
 * main.tsx sets `window.__APP_BOOTED = true` after render; the repair
 * sequence is exposed as `window.__pwRepair` for the app's error boundary.
 */
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  // Inert under capacitor:// (iOS) and other non-http schemes: no SW is ever
  // registered there and local files don't 404 the way a network deploy does.
  if (location.protocol !== "http:" && location.protocol !== "https:") return;

  var KEY = "pw:boot-recovery";
  var MAX_AUTO_ATTEMPTS = 2;
  var WINDOW_MS = 10 * 60 * 1000;
  var CHUNK_ERROR_RE =
    /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;
  var recovering = false;

  function readState() {
    try {
      var raw = sessionStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeState(s) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(s));
    } catch (e) {
      /* private mode etc — recovery still works, just unbounded-guarded off */
    }
  }

  function repair() {
    if (recovering) return;
    recovering = true;
    var tasks = [];
    if ("serviceWorker" in navigator) {
      tasks.push(
        navigator.serviceWorker
          .getRegistrations()
          .then(function (rs) {
            return Promise.all(
              rs.map(function (r) {
                return r.unregister().catch(function () {});
              })
            );
          })
          .catch(function () {})
      );
    }
    if (typeof caches !== "undefined") {
      tasks.push(
        caches
          .keys()
          .then(function (ks) {
            return Promise.all(
              ks.map(function (k) {
                return caches.delete(k).catch(function () {});
              })
            );
          })
          .catch(function () {})
      );
    }
    function done() {
      location.reload();
    }
    Promise.all(tasks).then(done, done);
  }
  window.__pwRepair = repair;

  function showFallback() {
    var root = document.getElementById("root");
    if (!root || root.childElementCount > 0) return;
    root.setAttribute(
      "style",
      "min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1a1a24;color:#e2e8f0;font-family:monospace;text-align:center;padding:24px"
    );
    var box = document.createElement("div");
    var h = document.createElement("h1");
    h.textContent = "Photonic Wallet failed to load";
    h.setAttribute("style", "font-size:18px;margin-bottom:12px");
    var p = document.createElement("p");
    p.textContent =
      "A cached version may be out of date. Repair clears the app cache and reloads — your wallet data is not affected.";
    p.setAttribute(
      "style",
      "font-size:13px;opacity:0.7;max-width:420px;margin:0 auto 20px"
    );
    var btn = document.createElement("button");
    btn.textContent = "Repair & reload";
    btn.setAttribute(
      "style",
      "background:#2b6cb0;color:#fff;border:0;border-radius:6px;padding:10px 20px;font-size:14px;font-family:inherit;cursor:pointer"
    );
    btn.onclick = repair;
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(btn);
    root.appendChild(box);
  }

  function autoRecover() {
    if (recovering) return;
    var now = Date.now();
    var s = readState();
    if (!s || now - s.ts > WINDOW_MS) s = { count: 0, ts: now };
    if (s.count >= MAX_AUTO_ATTEMPTS) {
      showFallback();
      return;
    }
    if (s.count === 0) s.ts = now;
    s.count += 1;
    writeState(s);
    repair();
  }

  // Static resource load failures (the entry <script> 404ing after a deploy).
  // Resource errors fire on the element and don't bubble — only a
  // capture-phase window listener sees them.
  window.addEventListener(
    "error",
    function (e) {
      var t = e.target;
      if (t && t !== window && t.tagName) {
        if (window.__APP_BOOTED) return;
        var tag = t.tagName.toUpperCase();
        if (
          (tag === "SCRIPT" && t.src) ||
          (tag === "LINK" && t.rel === "stylesheet")
        ) {
          autoRecover();
        }
        return;
      }
      // Runtime error path — Safari surfaces dynamic-import failures here.
      if (e.message && CHUNK_ERROR_RE.test(e.message)) autoRecover();
    },
    true
  );

  // Vite dynamic-import failures (lazy route chunks 404ing post-deploy).
  // Deliberately NOT gated on __APP_BOOTED: a long-lived tab on an old build
  // hits this when it lazy-loads a deleted chunk — recover it onto the new
  // build instead of leaving a broken route.
  window.addEventListener("vite:preloadError", function (e) {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    autoRecover();
  });

  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    var msg = (r && (r.message || String(r))) || "";
    if (CHUNK_ERROR_RE.test(msg)) autoRecover();
  });

  // Watchdog: if the app hasn't mounted after 12s, offer manual repair
  // (never auto-destroy on the timer alone — could be a slow network).
  setTimeout(function () {
    if (window.__APP_BOOTED) {
      try {
        sessionStorage.removeItem(KEY);
      } catch (e) {
        /* ignore */
      }
      return;
    }
    showFallback();
  }, 12000);
})();
