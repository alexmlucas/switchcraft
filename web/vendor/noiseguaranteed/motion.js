/* motion.js: a pause button for drifting noise (WCAG 2.2.2: anything that moves for more
   than five seconds can be paused). Pausing sets each canvas's drift to 0 and redraws it.
   The choice is remembered in this browser. Under prefers-reduced-motion nothing moves,
   so the button is hidden. Load after js/noise.js. */
(function () {
  var KEY = 'ng-noise-paused';

  // Runs after noise.js has started its drift timers, which it does on DOMContentLoaded.
  function init() {
    var btn = document.querySelector('[data-motion]');
    var canvases = document.querySelectorAll('canvas.noise[data-drift]');
    if (!btn || !canvases.length || !window.NoiseGuaranteed) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { btn.hidden = true; return; }

    canvases.forEach(function (c) { c.dataset.driftOn = c.dataset.drift; });

    function set(paused, remember) {
      canvases.forEach(function (c) {
        c.dataset.drift = paused ? '0' : c.dataset.driftOn;
        NoiseGuaranteed.render(c);
      });
      btn.setAttribute('aria-pressed', String(paused));
      if (remember) { try { localStorage.setItem(KEY, paused ? '1' : '0'); } catch (e) {} }
    }

    var saved = false;
    try { saved = localStorage.getItem(KEY) === '1'; } catch (e) {}
    if (saved) set(true, false);
    btn.addEventListener('click', function () { set(btn.getAttribute('aria-pressed') !== 'true', true); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
