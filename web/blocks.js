// Switchcraft blocks for Blockly: definitions, toolbox, and conversion
// between a workspace and a rule table (docs/sysex-rule-table-spec.md).
//
// Each "when ..." block holds actions; every action becomes one rule with
// that block's trigger. "Preset settings" and "sequence" blocks hold the
// globals and sequences. compile() turns a workspace into a table and
// decompile() turns any table back into blocks. Values a block doesn't show
// (per-rule channel, velocity...) ride along in the block's `data`, so
// nothing is lost on the way through.
//
// Needs Blockly and switchcraft.js. No page code (tested by test.html).

(function (global) {
  'use strict';

  const S = global.Switchcraft;
  const { TRIG, ACT, GATE, FLAG, DEFAULT } = S;

  const COLOURS = {
    events: '#a35f00', sound: '#2a63c4', sequences: '#7240bd',
    changes: '#1f7a50', setup: '#56616b', modulation: '#0f6f7d',
  };

  const MAX_NOTES = 64;
  const SCALE_STEP_RANGE = [-21, 28];  // scale-note menu: 3 octaves down, 4 up

  // --- Menu options ---

  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const SWITCH_OPTIONS = [
    ...range(0, 9).map((i) => [String(i + 1), String(i)]),
    ['left button', '10'], ['right button', '11'],
  ];
  const EVENT_OPTIONS = [['pressed', 'PRESS'], ['released', 'RELEASE'], ['held', 'HOLD'], ['tapped', 'TAP']];
  const DIVISION_OPTIONS = [
    ['bar (4 beats)', '96'], ['half note', '48'], ['beat', '24'], ['eighth note', '12'],
    ['eighth-note triplet', '8'], ['sixteenth note', '6'], ['sixteenth-note triplet', '4'],
    ['thirty-second note', '3'], ['other', 'custom'],
  ];
  const ANALOG_OPTIONS = [['left', '0'], ['right', '1']];
  const GATE_OPTIONS = [['while held', 'hold'], ['on / off', 'latch'], ['short', 'oneshot']];
  const SEQ_OPTIONS = [['A', '0'], ['B', '1'], ['C', '2'], ['D', '3']];
  const SEQ_TARGET_OPTIONS = [...SEQ_OPTIONS, ['selected', '255']];
  const SEQ_ACTION_OPTIONS = [
    ['play while held', 'run-hold'], ['start / stop', 'run-latch'], ['play once', 'run-oneshot'],
    ['step to next note', 'step'], ['stop', 'stop'], ['restart', 'reset'],
  ];
  const CC_NAMES = {
    1: 'modulation', 2: 'breath', 7: 'volume', 10: 'pan', 11: 'expression',
    64: 'sustain', 71: 'resonance', 74: 'brightness',
  };
  const CC_OPTIONS = range(0, 119).map((n) => [CC_NAMES[n] ? `${n} ${CC_NAMES[n]}` : String(n), String(n)]);
  const CC_SOURCE_OPTIONS = [
    ['to the analog value', 'analog'], ['to the analog value, reversed', 'analog-rev'], ['to', 'number'],
  ];
  const NOTE_OPTIONS = range(0, 127).map((n) => [S.noteName(n), String(n)]);
  const KEY_OPTIONS = S.NOTE_NAMES.map((n, i) => [n, String(i)]);
  const SCALE_OPTIONS = [...S.SCALES.map((s) => [s.name.toLowerCase(), String(s.mask)]), ['custom', 'custom']];
  const ORDER_OPTIONS = [['as written', 'written'], ['up', 'up'], ['down', 'down'], ['up and down', 'updown'], ['random', 'random']];
  const MODE_OPTIONS = [['in time (arpeggio)', 'clock'], ['one note per press', 'press']];
  const NOTE_TYPE_OPTIONS = [['scale steps', 'scale'], ['fixed notes', 'fixed']];
  const SPEED_OPTIONS = DIVISION_OPTIONS.filter(([, v]) => v !== '96');
  const MOD_OPTIONS = [['1', '0'], ['2', '1'], ['3', '2'], ['4', '3']];
  const MOD_ACTION_OPTIONS = [
    ['run while held', 'run-hold'], ['start / stop', 'run-latch'], ['run once', 'run-oneshot'], ['stop', 'stop'],
  ];
  const MOD_OUTPUT_OPTIONS = [['controller', 'cc'], ['pitch bend', 'bend'], ['channel pressure', 'pressure']];
  const WAVE_OPTIONS = [['sine', 'sine'], ['triangle', 'triangle'], ['saw', 'saw'], ['square', 'square'], ['random', 'random']];
  const LFO_SPEED_OPTIONS = [
    ['4 bars', '384'], ['2 bars', '192'], ['bar', '96'], ['half note', '48'], ['beat', '24'],
    ['eighth note', '12'], ['sixteenth note', '6'], ['free (Hz below)', 'free'], ['other', 'custom'],
  ];
  const CURVE_OPTIONS = [['straight', 'linear'], ['curved', 'exp']];
  const FOLLOW_OPTIONS = [['no sequence', 'none'], ...SEQ_OPTIONS.map(([n, v]) => [`sequence ${n}`, v])];
  const PRESET_OPTIONS = [['next', 'next'], ['previous', 'previous'], ...range(0, 7).map((i) => [String(i + 1), String(i)])];

  // --- Block data (values not shown on the block) ---

  function readData(block) {
    try {
      return block.data ? JSON.parse(block.data) : {};
    } catch (e) {
      return {};
    }
  }

  // --- Preset settings, as seen from any block in the workspace ---

  const DEFAULT_SETTINGS = { root: 0, octave: 4, mask: 0x0ab5 };

  function settingsBlock(ws) {
    return ws ? ws.getBlocksByType('sc_settings', true)[0] : null;
  }

  function settingsOf(ws) {
    const b = settingsBlock(ws);
    if (!b) return DEFAULT_SETTINGS;
    const scale = b.getFieldValue('SCALE');
    return {
      root: Number(b.getFieldValue('KEY')),
      octave: Number(b.getFieldValue('OCTAVE')),
      mask: scale === 'custom' ? (readData(b).mask ?? 0x0ab5) : Number(scale),
    };
  }

  // Scale-note menu, labelled with the notes of the current key and scale.
  function scaleNoteOptions() {
    const block = this && this.getSourceBlock ? this.getSourceBlock() : null;
    const s = settingsOf(block ? block.workspace : null);
    return range(...SCALE_STEP_RANGE).map((d) => {
      const n = S.degreeToNote(d, s.root, s.octave, s.mask);
      return [n >= 0 && n <= 127 ? S.noteName(n) : `step ${d}`, String(d)];
    });
  }

  // --- Sequence notes as text ---
  // Scale steps: 1 = the key note, 2 = the next note up... and -1 = the note
  // below the key note. Fixed notes: names like C4, F♯3, Bb2. Rests: "-".

  const NAME_RE = /^([A-Ga-g])([#♯b♭]?)(-?\d)?$/;
  const PITCH = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

  function nameToMidi(tok, octave) {
    const m = NAME_RE.exec(tok);
    if (!m) return null;
    const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
    const oct = m[3] === undefined ? octave : Number(m[3]);
    const n = 12 * (oct + 1) + PITCH[m[1].toLowerCase()] + acc;
    return n >= 0 && n <= 127 ? n : null;
  }

  function nearestDegree(midi, s) {
    let best = 0;
    for (let d = SCALE_STEP_RANGE[0]; d <= SCALE_STEP_RANGE[1]; d++)
      if (Math.abs(S.degreeToNote(d, s.root, s.octave, s.mask) - midi) <
          Math.abs(S.degreeToNote(best, s.root, s.octave, s.mask) - midi)) best = d;
    return best;
  }

  // Returns {notes} or {error}. notes: degrees or MIDI notes, null = rest.
  function parseNotes(text, type, settings = DEFAULT_SETTINGS) {
    const tokens = String(text).trim().split(/[\s,]+/).filter(Boolean);
    if (!tokens.length) return { error: 'Add some notes.' };
    if (tokens.length > MAX_NOTES) return { error: `At most ${MAX_NOTES} notes.` };
    const notes = [];
    for (const tok of tokens) {
      if (/^(-|\.|r|rest)$/i.test(tok)) {
        notes.push(null);
      } else if (type === 'scale' && /^-?\d+$/.test(tok)) {
        const n = Number(tok);
        if (n === 0 || n > 64 || n < -64) return { error: `“${tok}”: use 1 for the key note, -1 for the note below.` };
        notes.push(n > 0 ? n - 1 : n);
      } else if (type === 'fixed' && /^\d+$/.test(tok) && Number(tok) <= 127) {
        notes.push(Number(tok));
      } else {
        const midi = nameToMidi(tok, settings.octave);
        if (midi === null) return { error: `“${tok}” isn’t a note. Try 1 3 5, C4 E4 G4, or - for a rest.` };
        notes.push(type === 'scale' ? nearestDegree(midi, settings) : midi);
      }
    }
    return { notes };
  }

  function formatNotes(notes, type) {
    return notes.map((n) => {
      if (n === null) return '-';
      if (type === 'scale') return String(n >= 0 ? n + 1 : n);
      return S.noteName(n);
    }).join(' ');
  }

  // --- Block definitions ---

  function eventBlock(type, message, args, tooltip) {
    return {
      type, message0: message, args0: args,
      message1: '%1', args1: [{ type: 'input_statement', name: 'DO' }],
      colour: COLOURS.events, tooltip,
    };
  }

  function actionBlock(type, colour, message, args, tooltip) {
    return {
      type, message0: message, args0: args, previousStatement: null, nextStatement: null,
      colour, tooltip,
    };
  }

  const dropdown = (name, options) => ({ type: 'field_dropdown', name, options });

  const DEFINITIONS = [
    eventBlock('sc_when_switch', 'when switch %1 is %2',
      [dropdown('SWITCH', SWITCH_OPTIONS), dropdown('EVENT', EVENT_OPTIONS)],
      'Runs the blocks inside when this switch is pressed, released, held (kept down for the hold time) or tapped (let go before the hold time).'),
    eventBlock('sc_every', 'every %1',
      [dropdown('DIVISION', DIVISION_OPTIONS)],
      'Runs the blocks inside in time with the tempo.'),
    eventBlock('sc_when_loaded', 'when this preset starts', [],
      'Runs the blocks inside once when the preset starts: when the board switches to it or powers up, or when it comes from a template or file. Editing the blocks doesn’t restart it.'),
    eventBlock('sc_when_analog', 'when the %1 analog input moves',
      [dropdown('ANALOG', ANALOG_OPTIONS)],
      'Runs the blocks inside each time the pedal or trigger on this analog jack moves.'),

    actionBlock('sc_play_scale_note', COLOURS.sound, 'play scale note %1 %2',
      [dropdown('NOTE', scaleNoteOptions), dropdown('GATE', GATE_OPTIONS)],
      'Plays a note from the preset’s key and scale. It moves with the key and with transpose.'),
    actionBlock('sc_play_note', COLOURS.sound, 'play note %1 %2',
      [dropdown('NOTE', NOTE_OPTIONS), dropdown('GATE', GATE_OPTIONS)],
      'Plays this exact note (only transpose moves it). Good for drums.'),
    actionBlock('sc_send_cc', COLOURS.sound, 'set controller %1 %2 %3',
      [dropdown('CC', CC_OPTIONS), dropdown('SOURCE', CC_SOURCE_OPTIONS),
        { type: 'field_number', name: 'VALUE', value: 64, min: 0, max: 127, precision: 1 }],
      'Sends a MIDI controller (CC). “To the analog value” only works inside “when the analog input moves”; “reversed” makes pressing further send lower values, in this preset only.'),

    actionBlock('sc_sequence', COLOURS.sequences, 'sequence %1 %2 %3 on the beat',
      [dropdown('SEQ', SEQ_TARGET_OPTIONS), dropdown('ACTION', SEQ_ACTION_OPTIONS),
        { type: 'field_checkbox', name: 'BEAT', checked: false }],
      'Plays, steps through, stops or restarts a sequence. Tick “on the beat” to wait for the next beat.'),
    actionBlock('sc_select_sequence', COLOURS.sequences, 'select sequence %1',
      [dropdown('SEQ', SEQ_OPTIONS)],
      'Chooses which sequence “selected” means in the other sequence blocks.'),

    actionBlock('sc_transpose', COLOURS.changes, 'transpose %1 %2 semitones',
      [dropdown('MODE', [['by', '1'], ['to', '0']]),
        { type: 'field_number', name: 'AMOUNT', value: 12, min: -48, max: 48, precision: 1 }],
      'Moves every note up or down. 12 semitones is an octave.'),
    actionBlock('sc_set_key', COLOURS.changes, 'change key to %1 %2',
      [dropdown('KEY', [['same key', 'same'], ...KEY_OPTIONS]),
        dropdown('SCALE', [['same scale', 'same'], ...SCALE_OPTIONS])],
      'Changes the key and scale until the preset is loaded again.'),
    actionBlock('sc_preset', COLOURS.changes, 'switch to preset %1',
      [dropdown('PRESET', PRESET_OPTIONS)],
      'Loads another preset slot from the board. Empty slots are skipped.'),

    actionBlock('sc_modulator', COLOURS.modulation, 'modulator %1 %2 %3 on the beat',
      [dropdown('MOD', MOD_OPTIONS), dropdown('ACTION', MOD_ACTION_OPTIONS),
        { type: 'field_checkbox', name: 'BEAT', checked: false }],
      'Starts or stops an LFO, or opens and closes an envelope. “Run once” plays one LFO cycle, or an envelope’s attack and decay then its release.'),
    {
      type: 'sc_lfo_def', colour: COLOURS.modulation,
      message0: 'modulator %1 is an LFO',
      args0: [dropdown('MOD', MOD_OPTIONS)],
      message1: 'sends %1 %2 from %3 to %4',
      args1: [dropdown('OUTPUT', MOD_OUTPUT_OPTIONS), dropdown('CC', CC_OPTIONS),
        { type: 'field_number', name: 'FROM', value: 0, min: 0, max: 127, precision: 1 },
        { type: 'field_number', name: 'TO', value: 127, min: 0, max: 127, precision: 1 }],
      message2: 'wave %1 one cycle every %2',
      args2: [dropdown('WAVE', WAVE_OPTIONS), dropdown('SPEED', LFO_SPEED_OPTIONS)],
      message3: 'free speed %1 Hz  curve %2',
      args3: [{ type: 'field_number', name: 'HZ', value: 1, min: 0.01, max: 20, precision: 0.01 },
        dropdown('CURVE', CURVE_OPTIONS)],
      tooltip: 'An LFO moves the output up and down over and over, in time with the tempo (or at a free speed in Hz). The controller number only matters when it sends a controller. For pitch bend, 64 is the middle.',
    },
    {
      type: 'sc_envelope_def', colour: COLOURS.modulation,
      message0: 'modulator %1 is an envelope',
      args0: [dropdown('MOD', MOD_OPTIONS)],
      message1: 'sends %1 %2 from %3 to %4',
      args1: [dropdown('OUTPUT', MOD_OUTPUT_OPTIONS), dropdown('CC', CC_OPTIONS),
        { type: 'field_number', name: 'FROM', value: 0, min: 0, max: 127, precision: 1 },
        { type: 'field_number', name: 'TO', value: 127, min: 0, max: 127, precision: 1 }],
      message2: 'attack %1 ms decay %2 ms',
      args2: [{ type: 'field_number', name: 'ATTACK', value: 500, min: 0, max: 60000, precision: 1 },
        { type: 'field_number', name: 'DECAY', value: 300, min: 0, max: 60000, precision: 1 }],
      message3: 'sustain %1 %% release %2 ms',
      args3: [{ type: 'field_number', name: 'SUSTAIN', value: 100, min: 0, max: 100, precision: 1 },
        { type: 'field_number', name: 'RELEASE', value: 800, min: 0, max: 60000, precision: 1 }],
      message4: 'curve %1 follows %2',
      args4: [dropdown('CURVE', CURVE_OPTIONS), dropdown('FOLLOW', FOLLOW_OPTIONS)],
      tooltip: 'An envelope rises to the top over the attack, falls to the sustain level over the decay, stays there while it’s open, then falls back over the release. With sustain 100 and a held switch it’s a sweep: up while held, down when let go. “Follows” opens it for each note of a sequence.',
    },
    {
      type: 'sc_settings', colour: COLOURS.setup,
      message0: 'Preset settings',
      message1: 'name %1', args1: [{ type: 'field_input', name: 'NAME', text: 'Untitled' }],
      message2: 'key %1 %2 from octave %3',
      args2: [dropdown('KEY', KEY_OPTIONS), dropdown('SCALE', SCALE_OPTIONS),
        dropdown('OCTAVE', range(0, 9).map((o) => [String(o), String(o)]))],
      message3: 'tempo %1 beats per minute',
      args3: [{ type: 'field_number', name: 'TEMPO', value: 120, min: 20, max: 300, precision: 0.1 }],
      message4: 'MIDI channel %1 velocity %2',
      args4: [dropdown('CHANNEL', range(0, 15).map((c) => [String(c + 1), String(c)])),
        { type: 'field_number', name: 'VELOCITY', value: 100, min: 1, max: 127, precision: 1 }],
      message5: 'hold time %1 ms',
      args5: [{ type: 'field_number', name: 'HOLD', value: 500, min: 50, max: 10000, precision: 1 }],
      message6: 'ignore repeat presses within %1 ms',
      args6: [{ type: 'field_number', name: 'LOCKOUT', value: 0, min: 0, max: 10000, precision: 1 }],
      tooltip: 'Settings for the whole preset. “Hold time” decides when a press counts as held rather than tapped.',
    },
    {
      type: 'sc_sequence_def', colour: COLOURS.sequences,
      message0: 'sequence %1 plays %2',
      args0: [dropdown('SEQ', SEQ_OPTIONS), dropdown('MODE', MODE_OPTIONS)],
      message1: '%1 %2',
      args1: [dropdown('NOTE_TYPE', NOTE_TYPE_OPTIONS), { type: 'field_input', name: 'NOTES', text: '1 3 5' }],
      message2: 'order %1 octaves %2',
      args2: [dropdown('ORDER', ORDER_OPTIONS), dropdown('OCTAVES', [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']])],
      message3: 'speed %1 note length %2 %%',
      args3: [dropdown('SPEED', SPEED_OPTIONS),
        { type: 'field_number', name: 'LENGTH', value: 80, min: 0, max: 100, precision: 1 }],
      message4: 'rhythm %1 %2 hits in %3 steps, rotate %4',
      args4: [dropdown('RHYTHM', [['every step', 'all'], ['euclidean', 'euclid']]),
        { type: 'field_number', name: 'HITS', value: 3, min: 0, max: 32, precision: 1 },
        { type: 'field_number', name: 'STEPS', value: 8, min: 1, max: 32, precision: 1 },
        { type: 'field_number', name: 'ROTATE', value: 0, min: 0, max: 31, precision: 1 }],
      tooltip: 'The notes of a sequence. Scale steps: 1 is the key note, 3 and 5 make a chord, - is a rest. Fixed notes: C4 E4 G4. Length 0 holds each note until the next (one note per press only). Speed only matters when it plays in time. A euclidean rhythm spreads the hits as evenly as possible over the steps: each hit plays the next note, the other steps are rests.',
    },
  ];

  let defined = false;

  function define(Blockly) {
    if (defined) return;
    defined = true;
    Blockly.common.defineBlocksWithJsonArray(DEFINITIONS);
    // Sequence notes: check as they're typed, and tidy the text afterwards.
    const base = Blockly.Blocks.sc_sequence_def.init;
    Blockly.Blocks.sc_sequence_def.init = function () {
      base.call(this);
      this.getField('NOTES').setValidator(function (text) {
        const block = this.getSourceBlock();
        const type = block.getFieldValue('NOTE_TYPE');
        const r = parseNotes(text, type, settingsOf(block.workspace));
        return r.error ? text : formatNotes(r.notes, type);
      });
    };
  }

  const TOOLBOX = {
    kind: 'categoryToolbox',
    contents: [
      { kind: 'category', name: 'Events', colour: COLOURS.events, contents: [
        { kind: 'block', type: 'sc_when_switch',
          inputs: { DO: { block: { type: 'sc_play_scale_note', fields: { NOTE: '0', GATE: 'hold' } } } } },
        { kind: 'block', type: 'sc_when_switch', fields: { EVENT: 'HOLD' } },
        { kind: 'block', type: 'sc_when_analog',
          inputs: { DO: { block: { type: 'sc_send_cc', fields: { CC: '74', SOURCE: 'analog' } } } } },
        { kind: 'block', type: 'sc_every', fields: { DIVISION: '24' } },
        { kind: 'block', type: 'sc_when_loaded' },
      ] },
      { kind: 'category', name: 'Sound', colour: COLOURS.sound, contents: [
        { kind: 'block', type: 'sc_play_scale_note', fields: { NOTE: '0' } },
        { kind: 'block', type: 'sc_play_note', fields: { NOTE: '60' } },
        { kind: 'block', type: 'sc_send_cc', fields: { CC: '1', SOURCE: 'analog' } },
      ] },
      { kind: 'category', name: 'Sequences', colour: COLOURS.sequences, contents: [
        { kind: 'block', type: 'sc_sequence_def' },
        { kind: 'block', type: 'sc_sequence', fields: { SEQ: '0', ACTION: 'run-hold' } },
        { kind: 'block', type: 'sc_sequence', fields: { SEQ: '0', ACTION: 'step' } },
        { kind: 'block', type: 'sc_select_sequence' },
      ] },
      { kind: 'category', name: 'Modulation', colour: COLOURS.modulation, contents: [
        { kind: 'block', type: 'sc_envelope_def' },
        { kind: 'block', type: 'sc_lfo_def', fields: { CC: '1' } },
        { kind: 'block', type: 'sc_modulator', fields: { ACTION: 'run-hold' } },
        { kind: 'block', type: 'sc_modulator', fields: { ACTION: 'run-latch' } },
      ] },
      { kind: 'category', name: 'Changes', colour: COLOURS.changes, contents: [
        { kind: 'block', type: 'sc_transpose' },
        { kind: 'block', type: 'sc_set_key', fields: { KEY: 'same', SCALE: String(0x05ad) } },
        { kind: 'block', type: 'sc_preset' },
      ] },
      { kind: 'category', name: 'Setup', colour: COLOURS.setup, contents: [
        { kind: 'block', type: 'sc_settings' },
      ] },
    ],
  };

  // --- Workspace -> table ---

  const ACTION_TO_SEQ = {
    'run-hold': [ACT.SEQ_RUN, GATE.hold], 'run-latch': [ACT.SEQ_RUN, GATE.latch],
    'run-oneshot': [ACT.SEQ_RUN, GATE.oneshot], step: [ACT.SEQ_STEP, 0],
    stop: [ACT.SEQ_STOP, 0], reset: [ACT.SEQ_RESET, 0],
  };

  function globalsFrom(block) {
    const d = S.defaultForm();
    const g = {
      name: d.name, channel: d.channel, velocity: d.velocity, root: d.root, octave: d.octave,
      mask: d.mask, tempo: d.tempo, debounceMs: d.debounceMs, lockoutMs: d.lockoutMs, holdMs: d.holdMs,
    };
    if (!block) return g;
    const data = readData(block);
    const num = (f) => Number(block.getFieldValue(f));
    g.name = block.getFieldValue('NAME').replace(/[^\x20-\x7e]/g, '').slice(0, 16);
    g.root = num('KEY');
    g.mask = settingsOf(block.workspace).mask;
    g.octave = num('OCTAVE');
    g.tempo = Math.round(num('TEMPO') * 10);
    g.channel = num('CHANNEL');
    g.velocity = num('VELOCITY');
    g.holdMs = num('HOLD');
    g.lockoutMs = num('LOCKOUT');
    if (data.debounceMs !== undefined) g.debounceMs = data.debounceMs;
    return g;
  }

  function triggerOf(block) {
    const data = readData(block);
    switch (block.type) {
      case 'sc_when_switch':
        return { trig: TRIG[block.getFieldValue('EVENT')], src: Number(block.getFieldValue('SWITCH')), arg: data.arg || 0 };
      case 'sc_every': {
        const v = block.getFieldValue('DIVISION');
        return { trig: TRIG.CLOCK, src: 0, arg: v === 'custom' ? (data.arg || 24) : Number(v) };
      }
      case 'sc_when_loaded':
        return { trig: TRIG.LOAD, src: 0, arg: 0 };
      case 'sc_when_analog':
        return { trig: TRIG.ANALOG, src: Number(block.getFieldValue('ANALOG')), arg: 0 };
      default:
        return null;
    }
  }

  // One action block -> one rule (or null, with a problem noted).
  function ruleOf(block, t, sequenceIds, modulatorIds, warn) {
    const data = readData(block);
    const r = { trig: t.trig, src: t.src, arg: t.arg, act: ACT.NONE, flags: 0, p0: 0, p1: 0, p2: 0, p3: 0 };
    const extra = data.flags || 0;  // flag bits the block doesn't show
    const seqName = (id) => (id === 255 ? 'the selected sequence' : `Sequence ${'ABCD'[id]}`);
    switch (block.type) {
      case 'sc_play_scale_note':
      case 'sc_play_note':
        Object.assign(r, {
          act: ACT.NOTE,
          flags: GATE[block.getFieldValue('GATE')] | (block.type === 'sc_play_scale_note' ? FLAG.DEGREE : 0) | extra,
          p0: data.ch ?? DEFAULT, p1: data.vel ?? 0, p2: Number(block.getFieldValue('NOTE')), p3: data.ms ?? 0,
        });
        return r;
      case 'sc_send_cc': {
        const source = block.getFieldValue('SOURCE');
        const fromAnalog = source !== 'number';
        if (fromAnalog && t.trig !== TRIG.ANALOG)
          warn(block, '“To the analog value” only works inside “when the analog input moves”. Here it sends 0.');
        Object.assign(r, {
          act: ACT.CC,
          flags: (fromAnalog ? FLAG.VALUE_FROM_TRIGGER : 0) | (source === 'analog-rev' ? FLAG.REVERSE : 0) | extra,
          p0: data.ch ?? DEFAULT, p1: Number(block.getFieldValue('CC')),
          p2: fromAnalog ? 0 : Number(block.getFieldValue('VALUE')),
        });
        return r;
      }
      case 'sc_sequence': {
        const id = Number(block.getFieldValue('SEQ'));
        if (id !== 255 && !sequenceIds.has(id)) {
          warn(block, `${seqName(id)} has no notes yet, so this does nothing. Add a “sequence ${'ABCD'[id]} plays” block.`);
          return null;
        }
        const [act, gate] = ACTION_TO_SEQ[block.getFieldValue('ACTION')];
        Object.assign(r, { act, flags: gate | (block.getFieldValue('BEAT') === 'TRUE' ? FLAG.QUANTIZE : 0) | extra, p0: id });
        return r;
      }
      case 'sc_select_sequence': {
        const id = Number(block.getFieldValue('SEQ'));
        if (!sequenceIds.has(id)) {
          warn(block, `${seqName(id)} has no notes yet, so it can’t be selected.`);
          return null;
        }
        Object.assign(r, { act: ACT.SEQ_SELECT, flags: extra, p0: id });
        return r;
      }
      case 'sc_modulator': {
        const id = Number(block.getFieldValue('MOD'));
        if (!modulatorIds.has(id)) {
          warn(block, `Modulator ${id + 1} isn’t set up yet. Add a “modulator ${id + 1} is an LFO” or “is an envelope” block.`);
          return null;
        }
        const action = block.getFieldValue('ACTION');
        const gate = { 'run-hold': GATE.hold, 'run-latch': GATE.latch, 'run-oneshot': GATE.oneshot }[action];
        Object.assign(r, {
          act: action === 'stop' ? ACT.MOD_STOP : ACT.MOD_RUN,
          flags: (action === 'stop' ? 0 : gate) | (block.getFieldValue('BEAT') === 'TRUE' ? FLAG.QUANTIZE : 0) | extra,
          p0: id,
        });
        return r;
      }
      case 'sc_transpose':
        Object.assign(r, {
          act: ACT.TRANSPOSE, flags: extra, p0: Number(block.getFieldValue('MODE')),
          p2: Number(block.getFieldValue('AMOUNT')),
        });
        return r;
      case 'sc_set_key': {
        const key = block.getFieldValue('KEY');
        const scale = block.getFieldValue('SCALE');
        Object.assign(r, {
          act: ACT.SET_SCALE, flags: extra, p0: key === 'same' ? 0xff : Number(key),
          p2: scale === 'same' ? 0 : scale === 'custom' ? (data.mask ?? 0x0ab5) : Number(scale),
        });
        return r;
      }
      case 'sc_preset': {
        if (t.trig === TRIG.LOAD) {
          warn(block, 'A preset can’t switch presets as it starts: they could keep switching forever.');
          return null;
        }
        const v = block.getFieldValue('PRESET');
        Object.assign(r, {
          act: ACT.PRESET, flags: extra,
          p0: v === 'next' ? 1 : v === 'previous' ? 2 : 0, p1: v === 'next' || v === 'previous' ? 0 : Number(v),
        });
        return r;
      }
      default:
        return null;
    }
  }

  const OUTPUT_INDEX = { cc: 0, bend: 1, pressure: 2 };

  function modulatorOf(block, sequenceIds, warn) {
    const data = readData(block);
    const output = block.getFieldValue('OUTPUT');
    const m = {
      id: Number(block.getFieldValue('MOD')), type: block.type === 'sc_lfo_def' ? 0 : 1,
      output: OUTPUT_INDEX[output], controller: output === 'cc' ? Number(block.getFieldValue('CC')) : 0,
      channel: data.ch ?? DEFAULT, from: Number(block.getFieldValue('FROM')), to: Number(block.getFieldValue('TO')),
      flags: block.getFieldValue('CURVE') === 'exp' ? 1 : 0,
    };
    if (m.type === 0) {
      const speed = block.getFieldValue('SPEED');
      m.wave = S.WAVES.indexOf(block.getFieldValue('WAVE'));
      if (speed === 'free') {
        m.rate = Math.max(1, Math.min(2000, Math.round(Number(block.getFieldValue('HZ')) * 100)));
      } else {
        m.flags |= 2;
        m.rate = speed === 'custom' ? (data.rate || 96) : Number(speed);
      }
    } else {
      const follow = block.getFieldValue('FOLLOW');
      let followId = follow === 'none' ? DEFAULT : Number(follow);
      if (followId !== DEFAULT && !sequenceIds.has(followId)) {
        warn(block, `Sequence ${'ABCD'[followId]} has no notes yet, so there’s nothing to follow.`);
        followId = DEFAULT;
      }
      Object.assign(m, {
        sustain: Number(block.getFieldValue('SUSTAIN')), follow: followId,
        attack: Number(block.getFieldValue('ATTACK')), decay: Number(block.getFieldValue('DECAY')),
        release: Number(block.getFieldValue('RELEASE')),
      });
    }
    return m;
  }

  function sequenceOf(block, settings, warn) {
    const data = readData(block);
    const type = block.getFieldValue('NOTE_TYPE');
    const parsed = parseNotes(block.getFieldValue('NOTES'), type, settings);
    if (parsed.error) {
      warn(block, parsed.error);
      return null;
    }
    const mode = block.getFieldValue('MODE');
    const speed = block.getFieldValue('SPEED');
    let gate = Number(block.getFieldValue('LENGTH'));
    if (mode === 'clock' && gate === 0) gate = 100;  // "until the next note" is press-only
    const steps = parsed.notes.map((n, i) => {
      const extra = (data.steps && data.steps[i]) || {};
      return { note: n === null ? 0 : n, rest: n === null, velocity: extra.velocity || 0, length: extra.length || 1 };
    });
    let euclid = null;
    if (block.getFieldValue('RHYTHM') === 'euclid') {
      const steps = Number(block.getFieldValue('STEPS'));
      let hits = Number(block.getFieldValue('HITS'));
      if (hits > steps) {
        warn(block, `${hits} hits don’t fit in ${steps} steps: using ${steps}.`);
        hits = steps;
      }
      if (mode !== 'clock') warn(block, 'A euclidean rhythm only works when the sequence plays in time.');
      euclid = { steps, hits, rotation: Number(block.getFieldValue('ROTATE')) % steps };
    }
    return {
      id: Number(block.getFieldValue('SEQ')), advance: mode === 'clock' ? 1 : 0, euclid,
      order: S.ORDERS.indexOf(block.getFieldValue('ORDER')), octaves: Number(block.getFieldValue('OCTAVES')),
      channel: data.ch ?? DEFAULT, velocity: data.vel ?? 0,
      division: speed === 'custom' ? (data.division || 6) : Number(speed),
      gate, noteMode: type === 'scale' ? 1 : 0, steps,
    };
  }

  // Returns {table, problems: [{id, text}]}. Blocks with problems are left
  // out of the table, so the table is always one the board accepts.
  function compile(ws) {
    const problems = [];
    const warn = (block, text) => problems.push({ id: block.id, text });

    const settingsBlocks = ws.getBlocksByType('sc_settings', true);
    for (const b of settingsBlocks.slice(1)) warn(b, 'Only the first “Preset settings” block is used.');
    const globals = globalsFrom(settingsBlocks[0]);
    const settings = settingsOf(ws);

    const sequences = [];
    const sequenceIds = new Set();
    for (const b of ws.getBlocksByType('sc_sequence_def', true)) {
      const q = sequenceOf(b, settings, warn);
      if (!q) continue;
      if (sequenceIds.has(q.id)) {
        warn(b, `There is already a sequence ${'ABCD'[q.id]}: only the first is used.`);
        continue;
      }
      sequenceIds.add(q.id);
      sequences.push(q);
    }

    const modulators = [];
    const modulatorIds = new Set();
    for (const b of [...ws.getBlocksByType('sc_lfo_def', true), ...ws.getBlocksByType('sc_envelope_def', true)]
      .sort((a, b) => a.getRelativeToSurfaceXY().y - b.getRelativeToSurfaceXY().y)) {
      const m = modulatorOf(b, sequenceIds, warn);
      if (modulatorIds.has(m.id)) {
        warn(b, `There is already a modulator ${m.id + 1}: only the first is used.`);
        continue;
      }
      modulatorIds.add(m.id);
      modulators.push(m);
    }
    modulators.sort((a, b) => a.id - b.id);

    const rules = [];
    for (const top of ws.getTopBlocks(true)) {
      const t = triggerOf(top);
      if (!t) {
        if (top.previousConnection) warn(top, 'Put this inside a “when …” block so something starts it.');
        continue;
      }
      for (let b = top.getInputTargetBlock('DO'); b; b = b.getNextBlock()) {
        const r = ruleOf(b, t, sequenceIds, modulatorIds, warn);
        if (r) rules.push(r);
      }
    }
    if (rules.length > 128) {
      problems.push({ id: null, text: `There are ${rules.length} actions; the board holds 128. The rest are left out.` });
      rules.length = 128;
    }
    return { table: { globals, rules, sequences, modulators }, problems };
  }

  // --- Table -> workspace ---

  const SPEEDS = new Set(SPEED_OPTIONS.map(([, v]) => v));
  const DIVISIONS = new Set(DIVISION_OPTIONS.map(([, v]) => v));
  const MASKS = new Set(S.SCALES.map((s) => s.mask));
  const SEQ_TO_ACTION = {
    [ACT.SEQ_RUN]: ['run-hold', 'run-latch', 'run-oneshot'], [ACT.SEQ_STEP]: 'step',
    [ACT.SEQ_STOP]: 'stop', [ACT.SEQ_RESET]: 'reset',
  };
  const GATE_NAMES = ['hold', 'latch', 'oneshot'];
  const TRIG_EVENTS = { [TRIG.PRESS]: 'PRESS', [TRIG.RELEASE]: 'RELEASE', [TRIG.HOLD]: 'HOLD', [TRIG.TAP]: 'TAP' };

  // Only keeps data that differs from the defaults.
  function dataOf(obj) {
    const clean = Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
    return Object.keys(clean).length ? JSON.stringify(clean) : undefined;
  }

  function stateWithData(state, data) {
    const d = dataOf(data);
    if (d) state.data = d;
    return state;
  }

  function settingsState(g) {
    return stateWithData({
      type: 'sc_settings',
      fields: {
        NAME: g.name, KEY: String(g.root), SCALE: MASKS.has(g.mask) ? String(g.mask) : 'custom',
        OCTAVE: String(g.octave), TEMPO: g.tempo / 10, CHANNEL: String(g.channel),
        VELOCITY: g.velocity, HOLD: g.holdMs, LOCKOUT: g.lockoutMs,
      },
    }, {
      mask: MASKS.has(g.mask) ? undefined : g.mask,
      debounceMs: g.debounceMs === 10 ? undefined : g.debounceMs,
    });
  }

  function sequenceState(q) {
    const type = q.noteMode ? 'scale' : 'fixed';
    const notes = q.steps.map((st) => (st.rest ? null : st.note));
    const stepExtras = q.steps.map((st) => (st.velocity || st.length > 1 ? { velocity: st.velocity, length: st.length } : null));
    return stateWithData({
      type: 'sc_sequence_def',
      fields: {
        SEQ: String(q.id), MODE: q.advance ? 'clock' : 'press', NOTE_TYPE: type,
        NOTES: formatNotes(notes, type), ORDER: S.ORDERS[q.order], OCTAVES: String(q.octaves),
        SPEED: SPEEDS.has(String(q.division)) ? String(q.division) : 'custom', LENGTH: q.gate,
        RHYTHM: q.euclid ? 'euclid' : 'all',
        HITS: q.euclid ? q.euclid.hits : 3, STEPS: q.euclid ? q.euclid.steps : 8,
        ROTATE: q.euclid ? q.euclid.rotation : 0,
      },
    }, {
      ch: q.channel === DEFAULT ? undefined : q.channel,
      vel: q.velocity || undefined,
      division: SPEEDS.has(String(q.division)) ? undefined : q.division,
      steps: stepExtras.some(Boolean) ? stepExtras : undefined,
    });
  }

  const OUTPUT_NAMES = ['cc', 'bend', 'pressure'];
  const LFO_SPEEDS = new Set(LFO_SPEED_OPTIONS.map(([, v]) => v));

  function modulatorState(m) {
    const fields = {
      MOD: String(m.id), OUTPUT: OUTPUT_NAMES[m.output], CC: String(m.output === 0 ? m.controller : 74),
      FROM: m.from, TO: m.to, CURVE: m.flags & 1 ? 'exp' : 'linear',
    };
    const data = { ch: m.channel === DEFAULT ? undefined : m.channel };
    if (m.type === 0) {
      const synced = !!(m.flags & 2);
      Object.assign(fields, {
        WAVE: S.WAVES[m.wave],
        SPEED: !synced ? 'free' : LFO_SPEEDS.has(String(m.rate)) ? String(m.rate) : 'custom',
        HZ: synced ? 1 : m.rate / 100,
      });
      if (synced && !LFO_SPEEDS.has(String(m.rate))) data.rate = m.rate;
      return stateWithData({ type: 'sc_lfo_def', fields }, data);
    }
    Object.assign(fields, {
      ATTACK: m.attack, DECAY: m.decay, SUSTAIN: m.sustain, RELEASE: m.release,
      FOLLOW: m.follow === DEFAULT ? 'none' : String(m.follow),
    });
    return stateWithData({ type: 'sc_envelope_def', fields }, data);
  }

  function triggerState(r) {
    if (TRIG_EVENTS[r.trig])
      return stateWithData({ type: 'sc_when_switch', fields: { SWITCH: String(r.src), EVENT: TRIG_EVENTS[r.trig] } },
        { arg: r.arg || undefined });
    if (r.trig === TRIG.CLOCK)
      return stateWithData({ type: 'sc_every', fields: { DIVISION: DIVISIONS.has(String(r.arg)) ? String(r.arg) : 'custom' } },
        { arg: DIVISIONS.has(String(r.arg)) ? undefined : r.arg });
    if (r.trig === TRIG.LOAD) return { type: 'sc_when_loaded' };
    return { type: 'sc_when_analog', fields: { ANALOG: String(r.src) } };
  }

  function actionState(r) {
    const gate = r.flags & 3;
    switch (r.act) {
      case ACT.NOTE: {
        const degree = !!(r.flags & FLAG.DEGREE);
        const lo = SCALE_STEP_RANGE[0], hi = SCALE_STEP_RANGE[1];
        return stateWithData({
          type: degree ? 'sc_play_scale_note' : 'sc_play_note',
          fields: { NOTE: String(degree ? Math.min(hi, Math.max(lo, r.p2)) : r.p2), GATE: GATE_NAMES[gate] },
        }, {
          ch: r.p0 === DEFAULT ? undefined : r.p0, vel: r.p1 || undefined, ms: r.p3 || undefined,
          flags: (r.flags & ~(3 | FLAG.DEGREE)) || undefined,
        });
      }
      case ACT.CC: {
        const fromAnalog = !!(r.flags & FLAG.VALUE_FROM_TRIGGER);
        const source = !fromAnalog ? 'number' : r.flags & FLAG.REVERSE ? 'analog-rev' : 'analog';
        const shown = fromAnalog ? FLAG.VALUE_FROM_TRIGGER | FLAG.REVERSE : 0;
        return stateWithData({
          type: 'sc_send_cc',
          fields: { CC: String(r.p1), SOURCE: source, VALUE: fromAnalog ? 64 : r.p2 },
        }, { ch: r.p0 === DEFAULT ? undefined : r.p0, flags: (r.flags & ~shown) || undefined });
      }
      case ACT.SEQ_RUN:
      case ACT.SEQ_STEP:
      case ACT.SEQ_STOP:
      case ACT.SEQ_RESET: {
        const action = r.act === ACT.SEQ_RUN ? SEQ_TO_ACTION[r.act][gate] : SEQ_TO_ACTION[r.act];
        const shown = (r.act === ACT.SEQ_RUN ? 3 : 0) | FLAG.QUANTIZE;
        return stateWithData({
          type: 'sc_sequence',
          fields: { SEQ: String(r.p0), ACTION: action, BEAT: !!(r.flags & FLAG.QUANTIZE) },
        }, { flags: (r.flags & ~shown) || undefined });
      }
      case ACT.SEQ_SELECT:
        return stateWithData({ type: 'sc_select_sequence', fields: { SEQ: String(r.p0) } }, { flags: r.flags || undefined });
      case ACT.TRANSPOSE:
        return stateWithData({ type: 'sc_transpose', fields: { MODE: String(r.p0), AMOUNT: r.p2 } }, { flags: r.flags || undefined });
      case ACT.SET_SCALE: {
        const scale = r.p2 === 0 ? 'same' : MASKS.has(r.p2) ? String(r.p2) : 'custom';
        return stateWithData({
          type: 'sc_set_key', fields: { KEY: r.p0 === 0xff ? 'same' : String(r.p0), SCALE: scale },
        }, { mask: scale === 'custom' ? r.p2 : undefined, flags: r.flags || undefined });
      }
      case ACT.MOD_RUN:
      case ACT.MOD_STOP: {
        const action = r.act === ACT.MOD_STOP ? 'stop' : ['run-hold', 'run-latch', 'run-oneshot'][gate];
        const shown = (r.act === ACT.MOD_RUN ? 3 : 0) | FLAG.QUANTIZE;
        return stateWithData({
          type: 'sc_modulator', fields: { MOD: String(r.p0), ACTION: action, BEAT: !!(r.flags & FLAG.QUANTIZE) },
        }, { flags: (r.flags & ~shown) || undefined });
      }
      case ACT.PRESET:
        return stateWithData({
          type: 'sc_preset', fields: { PRESET: r.p0 === 1 ? 'next' : r.p0 === 2 ? 'previous' : String(r.p1) },
        }, { flags: r.flags || undefined });
      default:
        return null;  // ACT.NONE: nothing to show
    }
  }

  // Returns a Blockly workspace state for the table.
  function decompile(table) {
    const blocks = [];
    let y = 20;
    const place = (state, height) => {
      blocks.push({ ...state, x: 20, y });
      y += height;
    };
    place(settingsState(table.globals), 240);
    for (const q of [...table.sequences].sort((a, b) => a.id - b.id)) place(sequenceState(q), 170);
    for (const m of [...(table.modulators || [])].sort((a, b) => a.id - b.id)) place(modulatorState(m), 170);

    // One "when" block per distinct trigger, in order of first appearance.
    const groups = new Map();
    for (const r of table.rules) {
      const key = `${r.trig}:${r.src}:${r.arg}`;
      if (!groups.has(key)) groups.set(key, { first: r, actions: [] });
      const a = actionState(r);
      if (a) groups.get(key).actions.push(a);
    }
    for (const { first, actions } of groups.values()) {
      const hat = triggerState(first);
      let chain = null;
      for (const a of [...actions].reverse()) chain = chain ? { ...a, next: { block: chain } } : a;
      if (chain) hat.inputs = { DO: { block: chain } };
      place(hat, 70 + 56 * actions.length);
    }
    return { blocks: { languageVersion: 0, blocks } };
  }

  global.SwitchcraftBlocks = {
    COLOURS, TOOLBOX, define, compile, decompile, parseNotes, formatNotes, settingsOf,
  };
})(typeof window !== 'undefined' ? window : globalThis);
