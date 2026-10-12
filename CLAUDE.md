# Switchcraft

Custom RP2040 board (16 MB W25Q128 flash, no WiFi) that turns access switches
into USB MIDI. Repo layout: `electronics/` (KiCad), `mechanical/` (OpenSCAD),
`pd/` (Pure Data prototypes, including a step sequencer), plus early GTK
experiments at the root. The original Pico SDK firmware is still to be added.

## Current work: configuration interface

Full design and reasoning: [docs/config-interface-plan.md](docs/config-interface-plan.md).
Read it before working on firmware or the config page. Key constraints:

- Firmware: **Pico SDK (C) + TinyUSB**. Not Arduino, not CircuitPython.
- Config UI: an offline-capable browser page (Chrome/Edge) using **WebMIDI +
  SysEx**. Nothing is hosted on the board.
- USB: **two MIDI virtual cables**. Port 1 carries music for a DAW; port 2
  carries config SysEx plus a copy of all musical output. Increment
  `bcdDevice` on every descriptor change.
- Firmware core: a versioned **rule table** ("when trigger do action") in
  flash, plus preset slots. Arpeggiator and step sequencer share one engine.
- Editors: form view first, then a Blockly view; both write the same rule table.
- Deadline: conference demo and workshop on **2026-11-27**. Follow the
  priority list in the plan and don't add features beyond it.
