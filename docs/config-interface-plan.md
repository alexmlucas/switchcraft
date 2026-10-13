# Switchcraft configuration interface — plan

Status: agreed design, implementation not started (October 2026).
Target: conference demo and 2-hour hands-on workshop on **27 November 2026**.

## Goal

Let people configure Switchcraft (access switches → USB MIDI) with no
software install, with changes taking effect immediately on the hardware.
In the workshop, participants should be able to learn the system and build
their own switch interactions within two hours.

## Key decisions

### Configuration runs in a browser page and reaches the board over USB MIDI

The board is a stock Raspberry Pi Pico (RP2040) with no WiFi, so it can't serve its own web page.
Instead, a static web page (Chrome/Edge) talks to the board over USB MIDI
using **SysEx messages via WebMIDI**:

- No install. Open the page, plug in the board, allow MIDI access.
- Changes apply immediately and are saved to flash; the board then works
  standalone with no computer.
- The page also listens to the board's output to show live switch presses.

Safari/iOS don't support WebMIDI, so configuration needs a laptop with Chrome
or Edge. The page must work offline (single self-contained HTML or a PWA),
since conference WiFi can't be relied on.

Alternatives considered and rejected for this deadline: a WebUSB landing
page (Chrome-only, extra Windows descriptors), presenting the board as a
USB drive holding the page (unclear WebMIDI support from `file://`),
a USB network adapter with an on-board web server (driver risk),
Web Serial (extra interface, Chrome-only).

### Firmware: Pico SDK (C) + TinyUSB

Same stack as the original Switchcraft firmware. That firmware is lost, so
the new firmware is written from scratch.

### Two USB MIDI ports (virtual cables)

On Windows, a MIDI port has traditionally been usable by only one
application at a time. To let a DAW and the config page run together, the
device exposes two virtual cables on one USB MIDI interface:

| Port | Opened by | Carries |
|---|---|---|
| 1: Switchcraft | DAW / external synth | Notes, CCs, clock in and out |
| 2: Switchcraft Config | Browser page | Config SysEx, live switch events, a copy of all musical output |

Notes:
- Needs a hand-built TinyUSB MIDI descriptor (two pairs of in/out jacks);
  `TUD_MIDI_DESCRIPTOR` only describes one cable.
- Windows' built-in class driver may show port 2 as `MIDIIN2 (Switchcraft)`.
  The page finds it by order and confirms with an identify SysEx message.
- Windows remembers USB descriptors per VID/PID: increment `bcdDevice` on
  every descriptor change.
- **Week 1 test:** on a Windows laptop, run a DAW on port 1 and Chrome on
  port 2 at the same time. **Passed (13 October 2026).**

### The firmware is built around a rule table

Rather than fixed modes, the firmware stores a table of
**"when ⟨trigger⟩ do ⟨action⟩"** rules in flash. Every editor in the page
writes the same table:

- Triggers: switch press, release or hold; clock beat or division; …
- Actions: play a note from the scale, play the next step, start/stop/latch
  the arpeggiator, transpose, change scale, select a sequence, start/stop an
  LFO or envelope, switch preset slot, …

The arpeggiator and step sequencer are **one engine**: a list of notes plus
an advance source.
- **Press mode:** each switch press plays the next step.
- **Clock mode:** a switch starts/stops playback and the clock advances
  the steps. Arpeggio patterns (up, down, up-down, random, octave range)
  just reorder the note list.

### Page and board split the work

| Feature | Browser | RP2040 |
|---|---|---|
| Scale/note per switch | Scale picker UI | Note table in flash |
| Rule editing | Form view and Blockly view | Runs the rule table |
| MIDI file → sequence | Parses the file, picks a track, trims it | Stores the step list |
| Notation | Renders it (VexFlow or abcjs) | Nothing |
| Euclidean rhythms | Circle display | Decides play/rest per clock tick, live |
| LFOs / envelopes | Editing UI | Generates the CC/pitch-bend output |
| Audition | Built-in Web Audio synth | Copies output to port 2 |

### Editors

1. **Form view** (first; the guaranteed demo): note/scale per switch.
2. **Blockly view** (Scratch-style blocks; Blockly is the library Scratch's
   editor was built from): about 10 custom, colour-coded blocks that
   produce the rule table. Workshop participants start from a ready-made
   program and change it, rather than starting from blank. Every edit is
   sent to the board immediately. Use the Blockly keyboard-navigation
   plugin and large blocks for motor accessibility.

### Templates and presets

- **In the page:** built-in starter templates (scale player, chord
  arpeggiator, step through a tune, drum pads); save/load as JSON files
  holding both the Blockly blocks and the generated rule table; recent
  configs in browser storage as a convenience only.
- **On the board:** 4–8 preset slots, one 4 KB flash sector each, in the
  last sectors of the Pico's 2 MB flash. A rule action "switch to preset N" lets
  a switch cycle presets without a laptop.
- **Every template and slot carries a format version number** from day one.

### Musical features

- **Euclidean rhythms:** steps, hits and rotation; hit if
  `((i + rotation) * k) % n < k`. Decides play or rest on each clock tick.
- **CC modulation (one engine):**
  - LFOs: sine, triangle, saw, square, random; free rate or clock-synced;
    depth, centre, CC number, channel.
  - Envelopes: AD (one-shot, suits tap-only users), AR, ADSR; triggered by
    a switch or by every arpeggiator/sequencer note; linear or exponential
    curve; restart from the current value on retrigger.
  - Press-driven sweeps: hold or latch to ramp a CC up, release to ramp down.
  - Outputs: any CC, pitch bend, channel pressure.
  - Rate-limit output to about 50–100 updates/s, sent only on change.
- **MIDI clock:** follow external clock (0xF8 and start/stop/continue);
  fall back to the internal tempo if no ticks arrive for about 0.5 s.
  Don't rely on clock sync during the conference demo.
- **Accessibility:** latch as well as hold, start on the next beat,
  per-user minimum time between presses.

### Audition

A small built-in **Web Audio synth** in the page (oscillator → filter →
amplifier, with CC74 → cutoff, CC7 → volume, CC1 → vibrato, pitch bend)
makes every feature audible with no DAW. It needs a "Sound on" button,
since browsers only start audio after a click. A source switch offers
browser synth / external only / both. A General MIDI soundfont player
(e.g. SpessaSynth; check that CC74 affects the sound) is a later addition.
Browser audio latency on Windows is fine for auditioning; use a hardware
synth or DAW for polished live playing.

## Firmware notes (Pico SDK)

- Stock Pico: build with `PICO_BOARD=pico` (2 MB flash); no custom board
  header needed.
- Wrap flash erase/program in `flash_safe_execute` (`pico_flash`). Each slot
  header has a magic number, version and CRC, so a half-written slot is
  detected and skipped rather than loaded.
- SysEx carries only 7-bit bytes: pack rule-table data as nibbles.
- TinyUSB delivers SysEx in pieces: buffer from `0xF0` to `0xF7` before
  acting, and reply with an acknowledgement or error.
- SysEx manufacturer ID `0x7D` (non-commercial/educational).

## Priority order (cut from the bottom if late)

1. Rule table (including tap/hold triggers and analog inputs → CC), flash slots, SysEx protocol, two-port USB descriptor, note/scale form *(guaranteed demo)*
2. Shared engine: press mode, clock mode, arpeggio patterns
3. Blockly view, starter templates, built-in browser synth *(workshop essentials)*
4. Euclidean rhythms
5. CC modulation: LFOs, envelopes, sweeps
6. External clock sync
7. MIDI file import
8. Notation, GM soundfont player

No new features before 27 November beyond this list.

## Timeline

| Week (from 12 Oct) | Work |
|---|---|
| 1–2 | Items 1 + Windows two-port test |
| 3 | Item 2, Euclidean rhythms |
| 4 | CC modulation, clock sync, MIDI file import |
| 5 | Blockly, starter templates, browser synth |
| 6 | Stop adding features; practice workshop with a colleague; prepare backup board with demo config |

## Next step

Done: the pin map ([pin-map.md](pin-map.md)) and the SysEx and rule-table
spec ([sysex-rule-table-spec.md](sysex-rule-table-spec.md)). Next, start the
firmware from scratch against the spec: two-port USB descriptor first, so
the Windows two-port test can run in week 1.
