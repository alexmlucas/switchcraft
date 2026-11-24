// boardview.js: a drawing of the Switchcraft board, Fritzing-style, for the
// switches card. Positions are the PCB's own, in millimetres, taken from
// electronics/switchcraft/switchcraft.kicad_pcb (see docs/pin-map.md for which
// part is which input). Each input's button cap takes its device's colour,
// and its light glows while the switch is pressed. The drawing is a picture
// for the eye: the tiles under it carry the same information as text.
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const BOARD = { x: 95.26, y: 56.92, w: 89.97, h: 89.73 };
  const VIEW = '92.4 54.6 96 93.6';

  const LEFT = { jack: 102.5, button: 113.23, led: 120.79, label: 125.6, side: 'left' };
  const RIGHT = { jack: 177.93, button: 167.2, led: 159.64, label: 154.8, side: 'right' };
  // Input -> column and row centre (y). Inputs 10 and 11 are the buttons beside
  // the analog jacks; their lights are driven by the firmware, not the button.
  const INPUTS = [
    [LEFT, 63.37], [LEFT, 77.51], [LEFT, 91.66], [LEFT, 105.99], [LEFT, 120.5],
    [RIGHT, 63.37], [RIGHT, 77.51], [RIGHT, 91.66], [RIGHT, 105.99], [RIGHT, 120.5],
    [LEFT, 135], [RIGHT, 135],
  ];
  // Axial resistors: [pin 1 x, y, rotation, value]. 62 Ω for the lights, 10 kΩ
  // pull-downs on the analog inputs.
  const RESISTORS = [
    [109.42, 69.7, 0, 62], [109.3125, 83.8336, 0, 62], [109.3125, 97.9772, 0, 62],
    [109.3125, 112.3008, 0, 62], [109.43, 126.02, 0, 62], [117.05, 129.4, 180, 10000], [117.05, 140.8, 180, 62],
    [170.9, 69.7, 180, 62], [170.9, 83.8336, 180, 62], [170.9, 97.9772, 180, 62],
    [170.9, 112.3008, 180, 62], [170.97, 125.9, 180, 62], [163.35, 129.4, 0, 10000], [163.39, 140.8, 0, 62],
  ];
  // BC548 light drivers (TO-92): [pin 1 x, y, rotation].
  const TRANSISTORS = [
    ...[71.23, 85.552, 99.874, 114.196, 128.518].map((y) => [97.9575, y, 0]),
    ...[70.07, 84.3725, 98.675, 112.9775, 127.28].map((y) => [182.4725, y, 180]),
  ];
  const PICO = { x: 140.2, y: 82.74 };

  const C = {
    pcb: '#3b7f4a', pcbEdge: '#2b5f37', silk: '#eef5eb',
    pico: '#1f7a3a', picoEdge: '#16592a', gold: '#d4a843', hole: '#143a20',
    metal: '#c9cdd2', metalEdge: '#8a9097', black: '#232323', blackEdge: '#0d0d0d',
    resistor: '#d9c08f', resistorEdge: '#a88f5f', lead: '#9aa0a6',
    capFree: '#aeb2b5', ledOff: '#8a2222', ledOn: '#ff4d4d',
    // The analog lights (beside L and R) are a different part: blue.
    ledAnalog: '#2456b8',
  };
  // Resistor colour bands: digit colours, then the multiplier, then gold.
  const BAND = ['#1a1a1a', '#7b4a21', '#d22b2b', '#f08a24', '#f2d22e', '#3a9a3a', '#2f5fd0', '#8a3fbf', '#8c8c8c', '#f5f5f5'];
  function bands(ohms) {
    const s = String(ohms);
    return [BAND[+s[0]], BAND[+s[1]], BAND[s.length - 2], C.gold];
  }

  function svg(tag, attrs = {}, ...children) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    e.append(...children);
    return e;
  }

  function resistor(x, y, rot, ohms) {
    const x2 = rot === 0 ? x + 7.62 : x - 7.62;
    const left = Math.min(x, x2) + (7.62 - 6.3) / 2;
    const g = svg('g', {},
      svg('line', { x1: x, y1: y, x2, y2: y, stroke: C.lead, 'stroke-width': 0.5, 'stroke-linecap': 'round' }),
      svg('rect', { x: left, y: y - 1.15, width: 6.3, height: 2.3, rx: 1, fill: C.resistor, stroke: C.resistorEdge, 'stroke-width': 0.15 }));
    // Read from pin 1, so rotated parts read the other way round.
    const cols = bands(ohms);
    [0.9, 1.9, 2.9, 5.1].forEach((dx, k) => {
      const bx = rot === 0 ? left + dx : left + 6.3 - dx - 0.55;
      g.append(svg('rect', { x: bx, y: y - 1.15, width: 0.55, height: 2.3, fill: cols[k] }));
    });
    return g;
  }

  function transistor(x, y, rot) {
    const cx = rot === 0 ? x + 2.54 : x - 2.54;
    const d = rot === 0 ? 1 : -1;  // which way the flat face points
    const g = svg('g', {});
    for (const px of [-2.54, 0, 2.54]) g.append(svg('circle', { cx: cx + px, cy: y, r: 0.45, fill: C.lead }));
    g.append(svg('path', {
      d: `M ${cx - 2.4} ${y + d * 0.9} A 2.4 2.4 0 0 ${d > 0 ? 1 : 0} ${cx + 2.4} ${y + d * 0.9} Z`,
      fill: C.black, stroke: C.blackEdge, 'stroke-width': 0.15,
    }));
    return g;
  }

  function pico() {
    const { x, y } = PICO;
    const g = svg('g', {},
      svg('rect', { x: x - 10.5, y: y - 25.5, width: 21, height: 51, rx: 1, fill: C.pico, stroke: C.picoEdge, 'stroke-width': 0.2 }));
    for (let k = 0; k < 20; k++) {
      const py = y - 24.13 + k * 2.54;
      for (const px of [x - 8.89, x + 8.89]) {
        g.append(svg('circle', { cx: px, cy: py, r: 0.8, fill: C.gold }), svg('circle', { cx: px, cy: py, r: 0.45, fill: C.hole }));
      }
      for (const ex of [x - 10.5, x + 10.5]) g.append(svg('circle', { cx: ex, cy: py, r: 0.55, fill: C.gold }));
    }
    g.append(
      // USB socket over the top edge.
      svg('rect', { x: x - 4, y: y - 26.8, width: 8, height: 5.6, rx: 0.4, fill: C.metal, stroke: C.metalEdge, 'stroke-width': 0.2 }),
      svg('rect', { x: x - 2.6, y: y - 26.5, width: 5.2, height: 1.4, rx: 0.3, fill: C.metalEdge }),
      // BOOTSEL button, flash chip and the RP2040.
      svg('rect', { x: x - 5.1, y: y - 15.6, width: 3.2, height: 4.2, rx: 0.3, fill: '#e8e8e8', stroke: C.metalEdge, 'stroke-width': 0.15 }),
      svg('circle', { cx: x - 3.5, cy: y - 13.5, r: 1, fill: '#f8f8f8', stroke: C.metalEdge, 'stroke-width': 0.15 }),
      svg('rect', { x: x + 0.6, y: y - 14.6, width: 3.6, height: 2.6, rx: 0.2, fill: C.black }),
      svg('rect', { x: x - 3.5, y: y - 2, width: 7, height: 7, rx: 0.3, fill: C.black }),
      svg('text', { x, y: y + 1.9, 'font-size': 1.2, fill: '#9a9a9a', 'text-anchor': 'middle', 'font-family': 'sans-serif' }, 'RP2040'),
      svg('text', { x, y: y + 20, 'font-size': 2, fill: C.silk, 'text-anchor': 'middle', 'font-family': 'sans-serif', 'font-weight': 700 }, 'Pico'));
    return g;
  }

  // A 3.5 mm jack: the body on the board, its nose over the outer edge.
  function jack(col, y, analog) {
    const s = col.side === 'left' ? 1 : -1;
    const x0 = col.jack;
    const bx = s > 0 ? x0 - 7.1 : x0 - 5.195;
    const nx = s > 0 ? x0 - 9.2 : x0 + 7.1;
    const g = svg('g', {},
      svg('rect', { x: bx, y: y - 3.05, width: 12.295, height: 6.1, rx: 0.4, fill: C.black, stroke: C.blackEdge, 'stroke-width': 0.2 }),
      svg('rect', { x: nx, y: y - 2.5, width: 2.1, height: 5, rx: 0.3, fill: '#3b3b3b', stroke: C.blackEdge, 'stroke-width': 0.2 }),
      svg('line', { x1: nx + (s > 0 ? 0.7 : 1.4), y1: y - 2.5, x2: nx + (s > 0 ? 0.7 : 1.4), y2: y + 2.5, stroke: '#555', 'stroke-width': 0.2 }));
    // Three legs along the board side of the body.
    for (const dx of [-4, -1, 3]) g.append(svg('rect', { x: x0 + s * dx - 0.5, y: y - 3.35, width: 1, height: 0.5, fill: C.metal }));
    if (analog) g.append(svg('text', { x: x0 + s * 0.4, y: y + 4.9, 'font-size': 1.7, fill: C.silk, 'text-anchor': 'middle', 'font-family': 'sans-serif', 'font-weight': 700 }, 'ANALOG'));
    return g;
  }

  function button(cx, cy) {
    const g = svg('g', { class: 'bv-button' });
    for (const [dx, dy] of [[-2.2, -3.3], [2.2, -3.3], [-2.2, 2.8], [2.2, 2.8]])
      g.append(svg('rect', { x: cx + dx - 0.5, y: cy + dy, width: 1, height: 0.5, fill: C.metal }));
    g.append(
      svg('rect', { x: cx - 3, y: cy - 3, width: 6, height: 6, rx: 0.5, fill: C.black, stroke: C.blackEdge, 'stroke-width': 0.2 }),
      svg('circle', { cx, cy, r: 2.6, fill: '#2f2f2f' }));
    const cap = svg('circle', { class: 'bv-cap', cx, cy, r: 2.05, fill: C.capFree, stroke: C.blackEdge, 'stroke-width': 0.25 });
    const shine = svg('ellipse', { cx: cx - 0.6, cy: cy - 0.8, rx: 0.9, ry: 0.5, fill: '#ffffff', opacity: 0.35 });
    const sym = svg('text', { class: 'bv-sym', x: cx, y: cy + 0.75, 'font-size': 2.1, 'text-anchor': 'middle', fill: '#000', 'font-family': 'sans-serif' }, '');
    g.append(cap, shine, sym);
    return g;
  }

  function led(cx, cy, analog) {
    return svg('g', { class: 'bv-led' },
      svg('circle', { class: 'bv-glow', cx, cy, r: 3.6, fill: 'url(#bv-glow)', opacity: 0 }),
      svg('circle', { cx, cy, r: 1.75, fill: analog ? '#142f66' : '#5e1717' }),
      svg('circle', { class: 'bv-dome', cx, cy, r: 1.5, fill: analog ? C.ledAnalog : C.ledOff }),
      svg('ellipse', { cx: cx - 0.5, cy: cy - 0.55, rx: 0.5, ry: 0.32, fill: '#ffffff', opacity: 0.5 }));
  }

  let root = null;
  const groups = [];

  // The box, seen from above, drawn like the page's other pictures: flat,
  // with ink outlines (colours come from the page's CSS, so it follows the
  // light and dark themes). Only the button caps, the lights and the jacks in
  // the side walls show. Positions are the PCB's, as above.
  const BOX = { x: 92.9, y: 53.9, w: 95.0, h: 95.9, r: 5 };

  function buildEnclosure(container, onPick) {
    root = svg('svg', { viewBox: '90.4 51.6 100 100.6', role: 'group', 'aria-label': 'Switchcraft interface', focusable: 'false', class: 'bv-flat' });
    const { x, y, w, h, r } = BOX;
    root.append(svg('rect', { class: 'bv-box', x, y, width: w, height: h, rx: r }));
    // The Pico's USB socket in the top wall.
    root.append(svg('rect', { class: 'bv-ink', x: PICO.x - 4, y: y - 1.2, width: 8, height: 2.4, rx: 0.5 }));

    INPUTS.forEach(([col, iy], i) => {
      const analog = i >= 10;
      const left = col.side === 'left';
      const g = svg('g', { class: 'bv-input', 'data-input': i });
      g.append(svg('rect', { class: 'bv-hit', x: left ? 94.5 : 151.5, y: iy - 6.4, width: 34.5, height: 12.8, rx: 1.5 }));
      // The jack in the side wall.
      g.append(svg('rect', { class: 'bv-ink', x: left ? x - 1.2 : x + w - 1.2, y: iy - 2.6, width: 2.4, height: 5.2, rx: 0.4 }));
      // The button: a ring when it's chosen, the cap in its device's colour.
      const bx = col.button;
      g.append(
        svg('circle', { class: 'bv-ring', cx: bx, cy: iy, r: 4.1 }),
        svg('circle', { class: 'bv-cap', cx: bx, cy: iy, r: 2.8 }),
        svg('text', { class: 'bv-sym', x: bx, y: iy + 0.95, 'font-size': 2.6, 'text-anchor': 'middle' }, ''));
      // The light.
      g.append(svg('circle', { class: `bv-led${analog ? ' analog' : ''}`, cx: col.led, cy: iy, r: 1.3 }));
      g.append(svg('text', { class: 'bv-label', x: col.label, y: iy + 1.2, 'font-size': 3.4, 'text-anchor': 'middle' },
        analog ? (left ? 'V1' : 'V2') : String(i + 1)));
      g.append(svg('title', {}, ''));
      g.addEventListener('click', () => { if (g.classList.contains('pickable')) onPick(i); });
      g.addEventListener('keydown', (e) => {
        if (g.classList.contains('pickable') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onPick(i); }
      });
      groups[i] = g;
      root.append(g);
    });
    container.replaceChildren(root);
  }

  function build(container, onPick, style = 'board') {
    if (style === 'enclosure') return buildEnclosure(container, onPick);
    root = svg('svg', { viewBox: VIEW, 'aria-hidden': 'true', focusable: 'false' });
    root.append(svg('defs', {},
      svg('radialGradient', { id: 'bv-glow' },
        svg('stop', { offset: '0%', 'stop-color': '#ff5a5a', 'stop-opacity': 0.95 }),
        svg('stop', { offset: '45%', 'stop-color': '#ff7a7a', 'stop-opacity': 0.55 }),
        svg('stop', { offset: '100%', 'stop-color': '#ff9a9a', 'stop-opacity': 0 }))));
    root.append(svg('rect', {
      x: BOARD.x, y: BOARD.y, width: BOARD.w, height: BOARD.h, rx: 1.5,
      fill: C.pcb, stroke: C.pcbEdge, 'stroke-width': 0.5,
    }));
    // The board's name in the silkscreen.
    root.append(
      svg('text', { x: PICO.x, y: 128.6, 'font-size': 3.6, fill: C.silk, 'text-anchor': 'middle', 'font-family': 'sans-serif', 'font-weight': 700 }, 'switchcraft'),
      svg('text', { x: PICO.x, y: 132.4, 'font-size': 1.9, fill: C.silk, 'text-anchor': 'middle', 'font-family': 'sans-serif' }, 'noise guaranteed'));
    for (const r of RESISTORS) root.append(resistor(...r));
    for (const t of TRANSISTORS) root.append(transistor(...t));
    root.append(pico());

    INPUTS.forEach(([col, y], i) => {
      const analog = i >= 10;
      const g = svg('g', { class: 'bv-input', 'data-input': i });
      const left = col.side === 'left';
      g.append(svg('rect', {
        class: 'bv-hit', x: left ? 92.6 : 152.5, y: y - 6.6, width: left ? 35.5 : 35.4, height: 13.2, rx: 1, fill: 'transparent',
      }));
      g.append(jack(col, y, analog), button(col.button, y), led(col.led, y, analog));
      g.append(svg('text', {
        x: col.label, y: y + 1.2, 'font-size': 3.4, fill: C.silk, 'text-anchor': 'middle', 'font-family': 'sans-serif', 'font-weight': 700,
      }, analog ? (left ? 'V1' : 'V2') : String(i + 1)));
      g.append(svg('title', {}, ''));
      g.addEventListener('click', () => { if (g.classList.contains('pickable')) onPick(i); });
      groups[i] = g;
      root.append(g);
    });
    container.replaceChildren(root);
  }

  // owners[i]: {title} for a free switch, or {hex, symbol, title} for one a
  // device has. selected: the chosen switches. pickable(i): whether clicking
  // the switch chooses it (a toggle button), or it's only a picture.
  function update(owners, selected = new Set(), pickable = () => false) {
    owners.forEach((o, i) => {
      const g = groups[i];
      if (!g) return;
      const used = !!(o && o.hex);
      const chosen = selected.has(i);
      g.classList.toggle('used', used);
      g.classList.toggle('selected', chosen);
      const cap = g.querySelector('.bv-cap');
      if (root && root.classList.contains('bv-flat')) cap.style.fill = used ? o.hex : '';
      else cap.setAttribute('fill', used ? o.hex : C.capFree);
      g.querySelector('.bv-sym').textContent = used ? o.symbol : '';
      const label = (o && o.title) || `${i < 10 ? `Switch ${i + 1}` : i === 10 ? 'V1 button' : 'V2 button'}: free`;
      g.querySelector('title').textContent = chosen ? `${label} (chosen)` : label;
      if (pickable(i)) {
        g.classList.add('pickable');
        g.setAttribute('role', 'button');
        g.setAttribute('tabindex', '0');
        g.setAttribute('aria-pressed', String(chosen));
        g.setAttribute('aria-label', label);
      } else {
        g.classList.remove('pickable');
        g.setAttribute('role', 'img');
        g.removeAttribute('tabindex');
        g.removeAttribute('aria-pressed');
        g.setAttribute('aria-label', label);
      }
    });
  }

  // The switch lights are wired to the switch, so they light while it's down.
  // The analog lights (inputs 10 and 11) belong to the firmware and stay off.
  function setDown(i, down) {
    const g = groups[i];
    if (!g) return;
    g.classList.toggle('down', down);
    // The flat box: the page's CSS lights the cap and the light.
    if (root && root.classList.contains('bv-flat')) return;
    const cap = g.querySelector('.bv-cap');
    if (!cap.dataset.r) cap.dataset.r = cap.getAttribute('r');
    const r = Number(cap.dataset.r);
    cap.setAttribute('r', down ? r - 0.2 : r);
    cap.setAttribute('stroke-width', down ? 0.45 : 0.25);
    if (i < 10) {
      g.querySelector('.bv-dome').setAttribute('fill', down ? C.ledOn : C.ledOff);
      g.querySelector('.bv-glow').setAttribute('opacity', down ? 1 : 0);
    }
  }

  global.BoardView = { build, update, setDown };
})(window);
