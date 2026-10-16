/* noise.js: seeded pixel noise and analogue effects for noise guaranteed.

   Drop a canvas on the page and include this script:
     <canvas class="noise" aria-hidden="true" data-seed="7"></canvas>
     <script src="js/noise.js"></script>

   Options (data-* attributes, or an object passed to render/image/favicon):
     seed     any number or word; "random" gives a new pattern every load (default "noise")
     cell     block size in CSS px (default 6)
     density  0 to 1, share of blocks that get colour (default 0.5)
     palette  "logo", "soft", "mono", "wash" (the page's wash colours, see css/noise-fx.css)
              or comma-separated colours (default "logo")
     style    "blocks" (default) or "stripes": vertical tape stripes that slip from line to line
     bg       background colour (default transparent)
     fade     "none", "left", "right", "ends" or "edges": thin the noise out towards those sides
     mask     "circle" to keep noise inside a circle
     drift    blocks (or stripe rows) changed per tick, 0 = static (default 0)

   Tape tearing on images, keeping the real <img> and its alt text:
     <img src="logo.png" alt="..." data-tear="hover">   tears on hover, or keyboard focus of its link
     <img src="logo.png" alt="..." data-tear="load">    tears once when the page loads

   The same seed always draws the same pattern, and each block is worked out from
   its own position, so a wider screen shows more of the same pattern, not a new one.
   Nothing moves under prefers-reduced-motion. */
(function () {
  var PALETTES = {
    logo: ['#00ff00', '#0000ff', '#00ffff', '#ff40ff', '#ffff00', '#ff0000'],
    soft: ['#81ff73', '#f273ff', '#73f2ff', '#fff273', '#7381ff'],
    mono: ['#000000']
  };
  // Drift redraws twice a second, below WCAG 2.3.1's limit of three flashes a second.
  var DRIFT_MS = 500;
  // WCAG 2.3.1 exempts flashes smaller than a quarter of a 341x256 px area, so tears on
  // small things like the logo can run quickly; anything bigger is held to 3 frames a second.
  var SMALL_FLASH_AREA = 341 * 256 / 4;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Repeatable number in [0, 1) for block (x, y) under seed s.
  function hash(s, x, y) {
    var h = s ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seedFrom(value) {
    var str = String(value);
    if (str === 'random') return (Math.random() * 4294967296) | 0;
    if (/^-?\d+$/.test(str)) return parseInt(str, 10) | 0;
    var h = 0x811c9dc5; // FNV-1a, so words work as seeds too
    for (var i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    return h | 0;
  }

  // The page's wash palette lives in CSS (--wash-noise) so colours are set in one place.
  function washPalette() {
    var v = getComputedStyle(document.documentElement).getPropertyValue('--wash-noise').trim();
    return v ? v.split(',').map(function (c) { return c.trim(); }) : PALETTES.logo;
  }

  function readOpts(canvas, extra) {
    var d = (canvas && canvas.dataset) || {};
    var o = Object.assign({}, d, extra || {});
    var palette = o.palette || 'logo';
    return {
      seed: seedFrom(o.seed == null ? 'noise' : o.seed),
      cell: parseFloat(o.cell) || 6,
      density: o.density == null ? 0.5 : parseFloat(o.density),
      palette: Array.isArray(palette) ? palette
        : palette === 'wash' ? washPalette()
        : PALETTES[palette] || palette.split(','),
      style: o.style || 'blocks',
      bg: o.bg || null,
      fade: o.fade || 'none',
      mask: o.mask || 'none',
      drift: parseInt(o.drift, 10) || 0
    };
  }

  // How much of the density applies at block (x, y), from 0 to 1.
  function weight(o, x, y, cols, rows) {
    var u = (x + 0.5) / cols, v = (y + 0.5) / rows;
    if (o.mask === 'circle') {
      var dx = u - 0.5, dy = v - 0.5;
      if (dx * dx + dy * dy > 0.25) return 0;
    }
    switch (o.fade) {
      case 'left': return u;
      case 'right': return 1 - u;
      case 'ends': return 1 - Math.abs(2 * u - 1);
      case 'edges': return Math.min(1 - Math.abs(2 * u - 1), 1 - Math.abs(2 * v - 1)) * 2;
      default: return 1;
    }
  }

  // Colour of block (x, y), or null for empty. `slip` shifts a stripe row sideways.
  function cellColour(o, x, y, cols, rows, slip) {
    var n = o.palette.length;
    if (hash(o.seed, x, y) >= o.density * weight(o, x, y, cols, rows)) return null;
    if (o.style === 'stripes') {
      // Vertical stripes that jog one block every eight lines, and now and then a line
      // slips sideways like a tape tear.
      var period = n * 2;
      var tear = hash(o.seed ^ 0x1b873593, 0, y) < 0.12 ? Math.floor(hash(o.seed, -1, y) * period) : 0;
      var k = (((x + ((y >> 3) & 1) + tear + slip) % period) + period) % period;
      return k % 2 ? null : o.palette[k >> 1];
    }
    return o.palette[Math.floor(hash(o.seed ^ 0x5bd1e995, x, y) * n)];
  }

  function paintCell(st, x, y, colour) {
    var c = st.cell, ctx = st.ctx;
    if (st.o.bg) { ctx.fillStyle = st.o.bg; ctx.fillRect(x * c, y * c, c, c); }
    else ctx.clearRect(x * c, y * c, c, c);
    if (colour) { ctx.fillStyle = colour; ctx.fillRect(x * c, y * c, c, c); }
  }

  function draw(canvas, o, scale) {
    var cell = Math.max(1, Math.round(o.cell * scale));
    var st = {
      o: o, ctx: canvas.getContext('2d'), cell: cell,
      cols: Math.ceil(canvas.width / cell), rows: Math.ceil(canvas.height / cell)
    };
    st.ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (o.bg) { st.ctx.fillStyle = o.bg; st.ctx.fillRect(0, 0, canvas.width, canvas.height); }
    for (var y = 0; y < st.rows; y++) {
      for (var x = 0; x < st.cols; x++) {
        var colour = cellColour(o, x, y, st.cols, st.rows, 0);
        if (colour) { st.ctx.fillStyle = colour; st.ctx.fillRect(x * cell, y * cell, cell, cell); }
      }
    }
    return st;
  }

  // Draw into an on-page canvas at its displayed size, sharp on high-density screens.
  function render(canvas, extra) {
    var o = readOpts(canvas, extra);
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    var st = draw(canvas, o, dpr);
    st.rand = mulberry32(o.seed);
    canvas._noise = st;
    return canvas;
  }

  // Draw into a new off-page canvas of an exact pixel size, e.g. for PNG export.
  function image(width, height, extra) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    draw(canvas, readOpts(null, extra), 1);
    return canvas;
  }

  // Noise in a black ring, echoing the logo, set as the page's icon.
  function favicon(extra) {
    var c = image(32, 32, Object.assign({ cell: 4, density: 0.85, mask: 'circle' }, extra));
    var ctx = c.getContext('2d');
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(16, 16, 14.5, 0, Math.PI * 2);
    ctx.stroke();
    var link = document.querySelector('link[rel~="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = c.toDataURL('image/png');
    return c;
  }

  function driftTick(canvas) {
    var st = canvas._noise;
    if (!st || reducedMotion.matches || document.hidden) return;
    for (var i = 0; i < st.o.drift; i++) {
      var y = Math.floor(st.rand() * st.rows);
      if (st.o.style === 'stripes') {
        // Re-slip a whole line rather than single blocks, so the stripes stay stripes.
        var slip = Math.floor(st.rand() * st.o.palette.length * 2);
        for (var x = 0; x < st.cols; x++) paintCell(st, x, y, cellColour(st.o, x, y, st.cols, st.rows, slip));
      } else {
        var bx = Math.floor(st.rand() * st.cols);
        var on = st.rand() < st.o.density * weight(st.o, bx, y, st.cols, st.rows);
        paintCell(st, bx, y, on ? st.o.palette[Math.floor(st.rand() * st.o.palette.length)] : null);
      }
    }
  }

  // A copy of `source` filled with one flat colour, for colour fringes.
  function silhouette(source, w, h, colour) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var ctx = c.getContext('2d');
    ctx.drawImage(source, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, w, h);
    return c;
  }

  /* Draw `source` (an image or canvas) into `canvas` torn like a damaged tape: bands of
     lines pushed sideways, with red and cyan ghosts offset either side.
       amount  0 to 1, how hard it tears (default 0.5)
       seed    as for noise; the same seed tears the same way
       fringe  ghost colours, two comma-separated colours (default "#ff0000,#00ffff"),
               or "none" for no ghosts */
  function tear(source, canvas, extra) {
    var o = Object.assign({ amount: 0.5, seed: 'tear', fringe: '#ff0000,#00ffff' }, extra);
    var seed = seedFrom(o.seed), amount = parseFloat(o.amount);
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d');
    var shift = Math.max(1, Math.round(w * 0.012 * (0.5 + amount)));
    var layers = [];
    if (o.fringe !== 'none') {
      var cols = o.fringe.split(',');
      layers.push([silhouette(source, w, h, cols[0].trim()), -shift]);
      layers.push([silhouette(source, w, h, (cols[1] || cols[0]).trim()), shift]);
    }
    layers.push([source, 0]);
    ctx.clearRect(0, 0, w, h);
    // Walk down the image in bands of a few lines; some bands get pushed sideways.
    var y = 0, band = 0;
    while (y < h) {
      var bandH = Math.max(1, Math.round(h * (0.01 + hash(seed, band, 1) * 0.06)));
      var dx = hash(seed, band, 2) < amount * 0.6 ? (hash(seed, band, 3) - 0.5) * w * 0.25 * amount : 0;
      layers.forEach(function (l) {
        var img = l[0];
        var sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
        var sy = y * sh / h, sH = bandH * sh / h;
        ctx.drawImage(img, 0, sy, sw, sH, dx + l[1], y, w, bandH);
      });
      y += bandH;
      band++;
    }
  }

  // Wrap an <img> so it can tear. The image stays in the page (just made transparent
  // while tearing) so its alt text is always there; the canvas on top is hidden from
  // assistive technology.
  function attachTear(img) {
    var wrap = document.createElement('span');
    wrap.style.cssText = 'position:relative;display:inline-block;line-height:0';
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);
    var canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    wrap.appendChild(canvas);
    var running = false;
    var fringe = img.dataset.fringe || getComputedStyle(document.documentElement).getPropertyValue('--fringe').trim() || undefined;

    function play() {
      if (running || reducedMotion.matches || !img.complete) return;
      running = true;
      var rect = img.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      var small = rect.width * rect.height <= SMALL_FLASH_AREA;
      var frameMs = small ? 70 : 340;
      // Builds up and settles back down, like a tape catching then running clean.
      var curve = [0.25, 0.6, 1, 0.7, 0.35, 0.15];
      var seed = (Math.random() * 1e9) | 0;
      img.style.opacity = '0';
      curve.forEach(function (amount, i) {
        setTimeout(function () { tear(img, canvas, { amount: amount, seed: seed + i, fringe: fringe }); }, i * frameMs);
      });
      setTimeout(function () {
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        img.style.opacity = '';
        running = false;
      }, curve.length * frameMs);
    }

    if (img.dataset.tear === 'load') {
      if (img.complete) play(); else img.addEventListener('load', play, { once: true });
    } else {
      img.addEventListener('mouseenter', play);
      var link = img.closest('a, button');
      if (link) link.addEventListener('focus', play);
    }
  }

  // Redraw every noise canvas, e.g. after the page's wash changes.
  function refresh() {
    document.querySelectorAll('canvas.noise').forEach(function (c) { render(c); });
  }

  function init() {
    var ro = window.ResizeObserver && new ResizeObserver(function (entries) {
      entries.forEach(function (e) { render(e.target); });
    });
    document.querySelectorAll('canvas.noise').forEach(function (canvas) {
      if (canvas.dataset.seed === 'random') canvas.dataset.seed = seedFrom('random');
      render(canvas);
      if (ro) ro.observe(canvas);
      if (parseInt(canvas.dataset.drift, 10) > 0) {
        setInterval(function () { driftTick(canvas); }, DRIFT_MS);
      }
    });
    document.querySelectorAll('img[data-tear]').forEach(attachTear);
  }

  window.NoiseGuaranteed = {
    render: render, image: image, favicon: favicon, tear: tear, refresh: refresh, palettes: PALETTES
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
