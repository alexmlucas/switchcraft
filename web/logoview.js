// logoview.js: draws the Switchcraft logo (logo.js) inline, so it takes the
// page's ink colour, and can animate it: the steam sways, the bubbles bob,
// and small coloured pixels rise out of the cauldron and fade. All of it is
// slow and small. Nothing moves under prefers-reduced-motion, and the page's
// motion button (the pause button on the noise band) pauses it too.
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const COLOURS = ['#81ff73', '#f273ff', '#73f2ff', '#fff273', '#a9b1ff'];
  const PIXEL = 0.75;        // mm, in the logo's own units
  const GRID = 0.75;         // pixels sit on a grid, so they look like pixels
  const EVERY_MS = 900;      // a new pixel about this often
  const MAX_PIXELS = 8;

  function make(tag, attrs = {}) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  const reduced = () => global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The noise band's pause button (vendor/noiseguaranteed/motion.js).
  const motionButton = () => document.querySelector('[data-motion]');
  const pausedByButton = () => motionButton()?.getAttribute('aria-pressed') === 'true';

  // Draws the logo into container. text: include the SWITCHCRAFT lettering.
  // animate: steam, bubbles and rising pixels. active(): whether the pixels
  // should rise now (they also stop while the tab is hidden).
  function build(container, { text = true, animate = false, label = 'Switchcraft', active = () => true } = {}) {
    const D = global.SwitchcraftLogoData;
    if (!D) return;
    const box = text ? D.box : D.iconBox;
    const svg = make('svg', { viewBox: box.join(' '), class: 'sc-logo', focusable: 'false' });
    if (label) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', label);
    } else {
      svg.setAttribute('aria-hidden', 'true');
    }
    // Pixels are drawn first, behind the cauldron, so they come up out of it.
    const pixels = make('g', { class: 'sc-pixels' });
    const ink = make('g', { fill: 'currentColor', 'fill-rule': 'evenodd' });
    for (const d of [...D.body, ...(text ? D.text : [])]) ink.append(make('path', { d }));
    const group = (cls, list) => {
      const g = make('g', { class: cls });
      list.forEach((d, i) => {
        const p = make('path', { d });
        p.style.setProperty('--i', i);
        g.append(p);
      });
      return g;
    };
    ink.append(group('sc-steam', D.steam), group('sc-bubble', D.bubbles));
    svg.append(pixels, ink);
    container.replaceChildren(svg);
    if (!animate || reduced()) return;
    svg.classList.add('sc-animate');

    // Pause and play with the page's motion button.
    const sync = () => svg.classList.toggle('sc-paused', pausedByButton());
    sync();
    if (motionButton()) new MutationObserver(sync).observe(motionButton(), { attributes: true, attributeFilter: ['aria-pressed'] });

    // Rising pixels: from the brew inside the rim, up past the steam, fading.
    const rimY = -2.6;   // just inside the cauldron's mouth
    const left = -7, right = 7;
    const snap = (v) => Math.round(v / GRID) * GRID;
    setInterval(() => {
      if (!active() || document.hidden || svg.classList.contains('sc-paused') || !svg.isConnected) return;
      if (pixels.childElementCount >= MAX_PIXELS) return;
      const x = snap(left + Math.random() * (right - left));
      const rise = 8 + Math.random() * 4;
      const drift = snap((Math.random() - 0.5) * 2);
      const r = make('rect', { x: x - PIXEL / 2, y: rimY, width: PIXEL, height: PIXEL,
        fill: COLOURS[Math.floor(Math.random() * COLOURS.length)] });
      pixels.append(r);
      // Steps rather than a smooth glide, like a pixel moving on a grid.
      const anim = r.animate([
        { transform: 'translate(0, 0)', opacity: 0 },
        { opacity: 1, offset: 0.15 },
        { opacity: 0.9, offset: 0.65 },
        { transform: `translate(${drift}px, ${-rise}px)`, opacity: 0 },
      ], { duration: 5500 + Math.random() * 3000, easing: `steps(${Math.round(rise / GRID)}, end)` });
      anim.onfinish = () => r.remove();
      // Keep the pixels in step with the pause button.
      const follow = () => (svg.classList.contains('sc-paused') ? anim.pause() : anim.play());
      r._follow = follow;
    }, EVERY_MS);
    if (motionButton()) {
      new MutationObserver(() => pixels.querySelectorAll('rect').forEach((r) => r._follow && r._follow()))
        .observe(motionButton(), { attributes: true, attributeFilter: ['aria-pressed'] });
    }
  }

  global.SwitchcraftLogo = { build };
})(window);
