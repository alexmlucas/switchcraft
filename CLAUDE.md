# Switchcraft

A board built around a stock Raspberry Pi Pico (RP2040, 2 MB flash, no WiFi)
that turns access switches into USB MIDI: 10 switch inputs and 2 analog
inputs, see [docs/pin-map.md](docs/pin-map.md). It is designed as a companion
for the **Logitech G Adaptive Gaming Kit**: its buttons plug into the switch
jacks and its continuous (variable trigger) controllers into the analog jacks,
so defaults such as analog calibration should suit those. Repo layout: `electronics/`
(KiCad), `mechanical/` (OpenSCAD), `pd/` (Pure Data prototypes, including a
step sequencer), plus early GTK experiments at the root. The original
firmware is lost; the new firmware is written from scratch.

## Current work: configuration interface

Full design and reasoning: [docs/config-interface-plan.md](docs/config-interface-plan.md).
Read it before working on firmware or the config page. Key constraints:

- Firmware: **Pico SDK (C) + TinyUSB**. Not Arduino, not CircuitPython.
  Lives in `firmware/`; build and test steps in
  [firmware/README.md](firmware/README.md). `tools/sc.py` talks to the board
  from Python (`python tools/sc.py selftest` runs without one).
- Config UI: an offline-capable browser page (Chrome/Edge) using **WebMIDI +
  SysEx**. Nothing is hosted on the board. Lives in `web/`: open
  `web/index.html` straight from disk (WebMIDI works over `file://`).
  Protocol/table logic is in `web/switchcraft.js`, the musician view's model
  (musicians -> devices -> switch roles, compiled to the rule table, with the
  musicians stored in the table's EDITOR section) in `web/band.js`, the
  audition synth in `web/synth.js`, and the Blockly blocks with workspace <->
  table conversion in `web/blocks.js` (no page code in any of them).
  **Blocks are switched off in the page for now** (Nov 2026, before the
  workshops): `blocks.js` and Blockly 13 in `web/vendor/blockly/` stay in the
  repo and in the tests, but `index.html` doesn't load them. Don't load
  Blockly from a CDN.
  The look follows the noise guaranteed brand (`BRAND.md` in the
  noiseguaranteed.github.io repo, sage wash): colours, font and borders are in
  `web/brand.css`, loaded after the page's own styles; the font, logo,
  favicon, `noise.js` and `motion.js` are copied into `web/fonts/`, `web/img/`
  and `web/vendor/noiseguaranteed/`. Run the unit tests in
  `web/test.html` with `python tools/run_web_tests.py` (headless Chrome;
  `--dump-dom` alone doesn't wait for the audio tests).
  `python tools/check_page_tables.py` sends the page's sample tables to a
  connected board.
- USB: **two MIDI virtual cables**. Port 1 carries music for a DAW; port 2
  carries config SysEx plus a copy of all musical output. Increment
  `bcdDevice` on every descriptor change.
- Firmware core: a versioned **rule table** ("when trigger do action") in
  flash, plus preset slots. Arpeggiator and step sequencer share one engine.
  The SysEx protocol and table layout are fixed in
  [docs/sysex-rule-table-spec.md](docs/sysex-rule-table-spec.md); change the
  spec first, then the firmware and page.
- Editor: the **musician view**. Each musician (name, colour, MIDI channel)
  adds devices (notes, sequencer, arpeggiator, wobble = LFO, swell =
  envelope, controls) and fills each device's roles with switches, by menu or
  by pressing the switch. It writes the same rule table as before; presets
  without stored musicians open as one musician per channel.
- Deadline: conference demo and workshop on **2026-11-27**. Follow the
  priority list in the plan and don't add features beyond it.
