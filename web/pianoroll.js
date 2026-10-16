// Piano roll for one sequence (plan item 8): time across, pitch up.
// The editing rules are plain functions on a form sequence (tested by
// test.html); mount() draws them as SVG and handles pointer and keyboard.
// A classic script (not a module), like switchcraft.js. Needs Switchcraft.

(function (global) {
  'use strict';

  const S = global.Switchcraft;
  const MAX_LENGTH = 127;

  // --- Model ---
  // A sequence's notes as events in time: {start, length, note}. In press
  // mode every step is one column (lengths only matter when it plays in time).

  function timeline(q) {
    const events = [];
    let t = 0;
    q.notes.forEach((n, i) => {
      const length = (q.mode === 'clock' && q.lengths && q.lengths[i]) || 1;
      if (n !== null) events.push({ start: t, length, note: n });
      t += length;
    });
    return { events, end: t };
  }

  // Events (non-overlapping) back to notes, rests and lengths. Returns
  // {notes, lengths} or null if it would need more than MAX_FORM_STEPS steps.
  function fromTimeline(events, mode) {
    const sorted = [...events].sort((a, b) => a.start - b.start);
    const notes = [];
    const lengths = [];
    let t = 0;
    const rest = (gap) => {
      // In press mode a gap is that many rest steps; in time, one rest step
      // as long as the gap (split if it's very long).
      while (gap > 0) {
        const len = mode === 'clock' ? Math.min(gap, MAX_LENGTH) : 1;
        notes.push(null);
        lengths.push(len);
        gap -= len;
      }
    };
    for (const e of sorted) {
      rest(e.start - t);
      notes.push(e.note);
      lengths.push(mode === 'clock' ? e.length : 1);
      t = e.start + (mode === 'clock' ? e.length : 1);
    }
    if (notes.length > S.MAX_FORM_STEPS) return null;
    return { notes, lengths: lengths.some((v) => v > 1) ? lengths : undefined };
  }

  function apply(q, events) {
    const r = fromTimeline(events, q.mode);
    if (!r) return false;
    q.notes = r.notes;
    if (r.lengths) q.lengths = r.lengths;
    else delete q.lengths;
    return true;
  }

  // The event covering column `col`, if any.
  function eventAt(events, col) {
    return events.findIndex((e) => col >= e.start && col < e.start + e.length);
  }

  // Click on a cell: a new note, a different pitch for the note there, or (the
  // same pitch again) removing it. Returns false if the sequence is full.
  function clickCell(q, col, pitch) {
    const { events } = timeline(q);
    const i = eventAt(events, col);
    if (i < 0) events.push({ start: col, length: 1, note: pitch });
    else if (events[i].note === pitch) events.splice(i, 1);
    else events[i].note = pitch;
    return apply(q, events);
  }

  function setPitch(q, index, pitch) {
    const { events } = timeline(q);
    events[index].note = pitch;
    return apply(q, events);
  }

  // Length in steps, up to the next note.
  function setLength(q, index, length) {
    const { events } = timeline(q);
    const e = events[index];
    const next = events[index + 1];
    const limit = next ? next.start - e.start : MAX_LENGTH;
    e.length = Math.max(1, Math.min(limit, MAX_LENGTH, Math.round(length)));
    return apply(q, events);
  }

  function removeNote(q, index) {
    const { events } = timeline(q);
    events.splice(index, 1);
    return apply(q, events);
  }

  // --- Rows (pitches) ---

  // Scale steps for a scale-step sequence, MIDI notes for fixed notes, a
  // little wider than the notes in use.
  function rows(q, settings) {
    const used = q.notes.filter((n) => n !== null);
    if (q.noteType === 'scale') {
      const lo = Math.max(-21, Math.min(0, ...used) - 3);
      const hi = Math.min(28, Math.max(lo + 14, Math.max(7, ...used) + 3));
      return Array.from({ length: hi - lo + 1 }, (_, i) => hi - i);  // top row first
    }
    const lo = Math.max(24, Math.min(60, ...used) - 5);
    const hi = Math.min(96, Math.max(lo + 24, Math.max(72, ...used) + 5));
    return Array.from({ length: hi - lo + 1 }, (_, i) => hi - i);
  }

  function rowMidi(q, value, s) {
    return q.noteType === 'scale' ? S.degreeToNote(value, s.root, s.octave, s.mask) : value;
  }

  // --- Drawing and input ---

  const COL = 28, ROW = 18, LABEL = 52, TOP = 18;
  const NS = 'http://www.w3.org/2000/svg';
  const BLACK = new Set([1, 3, 6, 8, 10]);

  function svg(tag, attrs = {}, text) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // opts: {get: () => sequence, changed: () => void, settings: () => {root, octave, mask},
  //        editable: () => bool, message: (text) => void}
  function mount(container, opts) {
    let focusIndex = null;  // event to focus after redrawing

    function render() {
      const q = opts.get();
      const s = opts.settings();
      const { events, end } = timeline(q);
      const rowValues = rows(q, s);
      const cols = Math.max(16, end + 8);
      const width = LABEL + cols * COL + 1;
      const height = TOP + rowValues.length * ROW + 1;
      const root = svg('svg', { width, height, class: 'roll', role: 'group',
        'aria-label': `Piano roll: ${events.length} notes. Click a cell to add a note, click a note to remove it, drag it up or down to change it${q.mode === 'clock' ? ', drag its right edge to change its length' : ''}.` });

      // Rows: shading for black keys, highlight for notes in the key, labels.
      rowValues.forEach((v, r) => {
        const midi = rowMidi(q, v, s);
        const pc = ((midi % 12) + 12) % 12;
        const inKey = q.noteType === 'scale' || (s.mask & (1 << ((pc - s.root + 12) % 12)));
        const cls = BLACK.has(pc) ? 'row black' : 'row';
        root.append(svg('rect', { class: `${cls}${inKey ? ' inkey' : ''}`, x: LABEL, y: TOP + r * ROW, width: cols * COL, height: ROW }));
        if (pc === s.root) root.append(svg('line', { class: 'rootline', x1: LABEL, x2: LABEL + cols * COL, y1: TOP + (r + 1) * ROW, y2: TOP + (r + 1) * ROW }));
        root.append(svg('text', { class: 'label', x: LABEL - 6, y: TOP + r * ROW + 13, 'text-anchor': 'end' }, S.noteName(midi)));
      });
      // Columns: a line per step, stronger every 4, numbers on top.
      for (let c = 0; c <= cols; c++) {
        root.append(svg('line', { class: c % 4 === 0 ? 'col beat' : 'col', x1: LABEL + c * COL, x2: LABEL + c * COL, y1: TOP, y2: height }));
        if (c < cols && c % 4 === 0) root.append(svg('text', { class: 'label', x: LABEL + c * COL + 3, y: 13 }, String(c + 1)));
      }
      // The end of the sequence.
      root.append(svg('line', { class: 'endline', x1: LABEL + end * COL, x2: LABEL + end * COL, y1: TOP, y2: height }));

      const notes = events.map((e, i) => {
        const r = rowValues.indexOf(e.note);
        const y = r < 0 ? (e.note > rowValues[0] ? TOP : height - ROW) : TOP + r * ROW;
        const g = svg('g', { class: 'note', tabindex: opts.editable() ? 0 : -1, role: 'button',
          'aria-label': `${S.noteName(rowMidi(q, e.note, s))}, step ${e.start + 1}${q.mode === 'clock' ? `, ${e.length} step${e.length === 1 ? '' : 's'} long` : ''}` });
        g.append(svg('rect', { class: 'body', x: LABEL + e.start * COL + 1, y: y + 1, width: e.length * COL - 2, height: ROW - 2, rx: 4 }));
        if (q.mode === 'clock') g.append(svg('rect', { class: 'edge', x: LABEL + (e.start + e.length) * COL - 8, y: y + 1, width: 7, height: ROW - 2 }));
        root.append(g);
        return g;
      });

      container.replaceChildren(root);
      if (focusIndex !== null && notes[Math.min(focusIndex, notes.length - 1)]) notes[Math.min(focusIndex, notes.length - 1)].focus();
      focusIndex = null;

      // --- Pointer ---
      // Measured against the current drawing: it's redrawn during a drag.
      const cellAt = (ev) => {
        const box = (container.firstChild || root).getBoundingClientRect();
        const x = ev.clientX - box.left - LABEL, y = ev.clientY - box.top - TOP;
        return { col: Math.floor(x / COL), row: Math.floor(y / ROW), x, y };
      };
      const commit = (ok, i) => {
        if (!ok) opts.message(`A sequence can hold up to ${S.MAX_FORM_STEPS} steps (notes and rests).`);
        focusIndex = i;
        render();
        opts.changed();
      };

      root.addEventListener('pointerdown', (ev) => {
        if (!opts.editable() || ev.button > 0) return;
        const start = cellAt(ev);
        if (start.col < 0 || start.row < 0 || start.row >= rowValues.length || start.col >= cols) return;
        const hitNote = ev.target.closest('.note');
        if (!hitNote) {
          commit(clickCell(q, start.col, rowValues[start.row]), null);
          return;
        }
        ev.preventDefault();
        const i = notes.indexOf(hitNote);
        const e = events[i];
        const onEdge = ev.target.classList.contains('edge');
        let moved = false;
        // On the window, so the drag carries on while the drawing is replaced.
        const move = (mv) => {
          const p = cellAt(mv);
          if (onEdge) {
            const length = Math.max(1, Math.round(p.x / COL) - e.start);
            if (length !== timeline(q).events[i].length) {
              moved = true;
              setLength(q, i, length);
              render();
              opts.changed();
            }
          } else if (p.row >= 0 && p.row < rowValues.length && rowValues[p.row] !== timeline(q).events[i].note) {
            moved = true;
            setPitch(q, i, rowValues[p.row]);
            render();
            opts.changed();
          }
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', stop);
        };
        const up = () => {
          stop();
          if (!moved && !onEdge) commit(removeNote(q, i), i);  // a click on a note removes it
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', stop);
      });

      // --- Keyboard, on a focused note ---
      notes.forEach((g, i) => g.addEventListener('keydown', (ev) => {
        if (!opts.editable()) return;
        const e = timeline(q).events[i];
        const r = rowValues.indexOf(e.note);
        let ok = true;
        if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
          const next = rowValues[r + (ev.key === 'ArrowUp' ? -1 : 1)];
          if (next === undefined) return;
          ok = setPitch(q, i, next);
        } else if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && ev.shiftKey) {
          if (q.mode !== 'clock') return;
          ok = setLength(q, i, e.length + (ev.key === 'ArrowRight' ? 1 : -1));
        } else if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
          const to = notes[i + (ev.key === 'ArrowRight' ? 1 : -1)];
          if (to) to.focus();
          ev.preventDefault();
          return;
        } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
          ok = removeNote(q, i);
        } else {
          return;
        }
        ev.preventDefault();
        commit(ok, i);
      }));
    }

    return { render };
  }

  global.SwitchcraftPianoRoll = { timeline, fromTimeline, clickCell, setPitch, setLength, removeNote, rows, mount };
})(typeof window !== 'undefined' ? window : globalThis);
