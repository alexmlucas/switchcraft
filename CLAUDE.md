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
  Protocol/table logic is in `web/switchcraft.js`, the audition synth in
  `web/synth.js`, and the Blockly blocks with workspace <-> table conversion
  in `web/blocks.js` (no page code in any of them). Blockly 13 is vendored in
  `web/vendor/blockly/` (see its README); don't load it from a CDN. Run the unit tests in
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
- Editors: form view first, then a Blockly view; both write the same rule table.
- Deadline: conference demo and workshop on **2026-11-27**. Follow the
  priority list in the plan and don't add features beyond it.
