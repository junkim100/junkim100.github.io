"use strict";

/* ============================================================
   Theme toggle (light / dark, persisted; default follows system)
   ============================================================ */
(function () {
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.querySelector(".theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const root = document.documentElement;
      const systemDark = window.matchMedia(
        "(prefers-color-scheme: dark)"
      ).matches;
      const current =
        root.getAttribute("data-theme") || (systemDark ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem("theme", next);
      } catch (_) {}
    });
  });
})();

/* ============================================================
   Mobile overlay menu
   ============================================================ */
(function () {
  document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.querySelector(".menu-toggle");
    const overlay = document.querySelector(".menu-overlay");
    if (!toggle || !overlay) return;

    function close() {
      document.body.classList.remove("menu-open");
      toggle.setAttribute("aria-expanded", "false");
    }

    toggle.addEventListener("click", () => {
      const open = document.body.classList.toggle("menu-open");
      toggle.setAttribute("aria-expanded", String(open));
    });

    overlay.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", close);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  });
})();

/* ============================================================
   Publications accordion
   ============================================================ */
(function () {
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".pub").forEach((pub) => {
      const head = pub.querySelector(".pub-head");
      const trigger = pub.querySelector(".pub-trigger");
      if (!head || !trigger) return;

      function toggle() {
        const open = pub.classList.toggle("open");
        trigger.setAttribute("aria-expanded", String(open));
      }

      head.addEventListener("click", (e) => {
        // Let inner links (arXiv, code, …) behave normally
        if (e.target.closest("a")) return;
        e.preventDefault();
        toggle();
      });

      trigger.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    });

    // Deep link: #pub-xxx opens that entry
    if (location.hash) {
      const target = document.querySelector(location.hash);
      if (target && target.classList.contains("pub")) {
        target.classList.add("open");
        const trigger = target.querySelector(".pub-trigger");
        if (trigger) trigger.setAttribute("aria-expanded", "true");
      }
    }
  });
})();

/* ============================================================
   Scroll-triggered reveals
   ============================================================ */
(function () {
  document.addEventListener("DOMContentLoaded", () => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches;
    const items = document.querySelectorAll(
      ".section-head, .highlight-item, .pub, .project-card, .xp-item, .edu-card, .contact-inner, .hero-stats .stat"
    );
    if (reduced || !("IntersectionObserver" in window)) {
      items.forEach((el) => el.classList.add("visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -40px 0px" }
    );

    items.forEach((el, i) => {
      el.classList.add("reveal");
      el.style.setProperty("--d", `${(i % 4) * 0.07}s`);
      observer.observe(el);
    });
  });
})();

/* ============================================================
   Marquee: drifts at a base speed and can be handled directly.
   Sideways wheel / trackpad swipe scrubs it, click (or touch)
   and drag grabs it with momentum on release, and it always
   eases back to the default drift once you let go.
   ============================================================ */
(function () {
  document.addEventListener("DOMContentLoaded", () => {
    const marquee = document.querySelector(".marquee");
    const track = document.querySelector(".marquee-track");
    if (!marquee || !track) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    track.classList.add("js-driven");
    marquee.classList.add("js-interactive");

    const BASE = 55; // px/s default drift
    const MAX = 3200; // cap for added velocity
    const clamp = (v) => Math.max(-MAX, Math.min(MAX, v));

    let offset = 0;
    let extra = 0; // velocity on top of the base drift
    let dragging = false;
    let lastX = 0;
    let lastMoveT = 0;
    let dragVel = 0;
    let lastT = performance.now();

    // Sideways wheel / trackpad swipe scrubs the strip;
    // vertical wheel passes through to the page.
    marquee.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
        e.preventDefault();
        offset += e.deltaX;
        extra = clamp(extra * 0.8 + e.deltaX * 6);
      },
      { passive: false }
    );

    // Click / touch and drag
    marquee.addEventListener("pointerdown", (e) => {
      dragging = true;
      lastX = e.clientX;
      lastMoveT = performance.now();
      dragVel = 0;
      extra = 0;
      marquee.classList.add("dragging");
      try {
        marquee.setPointerCapture(e.pointerId);
      } catch (_) {}
    });

    marquee.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      const now = performance.now();
      const dt = Math.max(now - lastMoveT, 1) / 1000;
      lastMoveT = now;
      offset -= dx; // strip follows the pointer
      dragVel = -dx / dt;
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      marquee.classList.remove("dragging");
      // If the last movement was a while ago, drop the momentum
      if (performance.now() - lastMoveT > 120) dragVel = 0;
      extra = clamp(dragVel - BASE); // hand off fling momentum
    }
    marquee.addEventListener("pointerup", endDrag);
    marquee.addEventListener("pointercancel", endDrag);

    function frame(t) {
      const dt = Math.min((t - lastT) / 1000, 0.05);
      lastT = t;
      if (!dragging) {
        offset += (BASE + extra) * dt;
        extra *= Math.pow(0.001, dt); // eases back to base in ~0.5s
        if (Math.abs(extra) < 1) extra = 0;
      }
      const half = track.scrollWidth / 2;
      if (half > 0) {
        offset = ((offset % half) + half) % half;
        track.style.transform = `translateX(${-offset}px)`;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
})();

/* ============================================================
   Scroll progress + active nav link
   ============================================================ */
(function () {
  document.addEventListener("DOMContentLoaded", () => {
    const bar = document.querySelector(".scroll-progress");
    let ticking = false;

    function update() {
      ticking = false;
      if (bar) {
        const doc = document.documentElement;
        const max = doc.scrollHeight - doc.clientHeight;
        bar.style.transform = `scaleX(${max > 0 ? doc.scrollTop / max : 0})`;
      }
    }

    window.addEventListener(
      "scroll",
      () => {
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(update);
        }
      },
      { passive: true }
    );
    update();

    // Active section highlighting
    const navLinks = document.querySelectorAll(".site-nav .nav-link");
    if (navLinks.length && "IntersectionObserver" in window) {
      const map = new Map();
      navLinks.forEach((link) => {
        const id = link.getAttribute("href");
        if (id && id.startsWith("#")) {
          const section = document.querySelector(id);
          if (section) map.set(section, link);
        }
      });

      const sectionObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              navLinks.forEach((l) => l.classList.remove("active"));
              const link = map.get(entry.target);
              if (link) link.classList.add("active");
            }
          });
        },
        { rootMargin: "-30% 0px -60% 0px" }
      );

      map.forEach((_, section) => sectionObserver.observe(section));
    }
  });
})();

/* ============================================================
   Contact email: click to copy, with a toast
   ============================================================ */
(function () {
  let toast, timer;

  function showToast(message) {
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast";
      toast.setAttribute("role", "status");
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => toast.classList.remove("show"), 1800);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const email = document.querySelector(".contact-email");
    if (!email || !navigator.clipboard) return;
    email.addEventListener("click", (e) => {
      e.preventDefault();
      navigator.clipboard
        .writeText(email.textContent.trim())
        .then(() => showToast("Email copied to clipboard"))
        .catch(() => {
          window.location.href = email.href;
        });
    });
  });
})();

/* ============================================================
   CV: open in a new tab and download
   ============================================================ */
function openCV(e) {
  if (e) e.preventDefault();
  const url = "CV.pdf";
  window.open(url, "_blank");
  const a = document.createElement("a");
  a.href = url;
  a.download = "CV.pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
