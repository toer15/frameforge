// FrameForge page — small interactions only: mobile nav, screenshot tabs, scroll reveal.
(function () {
  'use strict';

  // ---- Mobile nav
  var toggle = document.getElementById('navToggle');
  var nav = document.getElementById('nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // ---- Screenshot tabs
  var shots = {
    home: {
      src: 'images/home.png',
      alt: 'FrameForge home screen with the goal slideshow and live FPS, CPU and GPU readings.',
      caption: 'Home — pick a goal, then flip Auto Mode on.'
    },
    running: {
      src: 'images/running.png',
      alt: 'FrameForge applying an Auto Mode boost, with live progress and FPS, CPU and GPU readings.',
      caption: 'Auto Mode — 15 steps, live progress, stop any time.'
    },
    fix: {
      src: 'images/fixmode.png',
      alt: 'Fix mode showing a display refresh rate and a hot graphics card fixed by itself.',
      caption: 'Fix mode — it fixed the refresh rate and cooled the graphics card on its own.'
    },
    scan: {
      src: 'images/virusscan.png',
      alt: 'Virus scan results with real threats, false positives and quarantine choices.',
      caption: 'Virus scan — detections sorted into real threats, false positives and unwanted programs.'
    }
  };

  var image = document.getElementById('galleryImage');
  var caption = document.getElementById('galleryCaption');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.g-tab'));

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var shot = shots[tab.dataset.shot];
      if (!shot || !image) return;
      image.src = shot.src;
      image.alt = shot.alt;
      if (caption) caption.textContent = shot.caption;
      tabs.forEach(function (t) {
        var on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    });
  });

  // ---- Reveal on scroll
  var items = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    items.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el) { io.observe(el); });
  }

  // ---- Footer year
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
