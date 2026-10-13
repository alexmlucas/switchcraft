# Switchcraft SysEx protocol and rule-table format

Status: **draft v1**, October 2026. Both the firmware and the config page are
built against this document. Background and reasoning:
[config-interface-plan.md](config-interface-plan.md). Input numbering:
[pin-map.md](pin-map.md).

Scope: priority items 1–2 of the plan in full (rule table, flash slots,
SysEx, note/scale form, shared sequencer/arpeggiator engine), plus the two
analog inputs (sent as CCs) and tap-versus-hold triggers. Items 4–5
(Euclidean rhythms, CC modulation) get reserved IDs only, so they can be
added later without breaking v1 tables.

Conventions: all multi-byte integers are **little-endian**. `u8/u16/u32` are
unsigned, `i8/i16` are signed two's complement. "Input" means a logical
switch input 0–11 from the pin map; "analog" means analog input 0–1.

---

## Part A: SysEx protocol

### A.1 Where config messages are accepted

- Config SysEx is accepted **only on virtual cable 2** (USB cable number 1,
  "Switchcraft Config"). SysEx arriving on cable 1 is ignored, so a DAW
  sending its own SysEx can't change the configuration.
- Replies and unsolicited reports go out on cable 2 only.

### A.2 Message frame

```
F0 7D 53 43 <ver> <cmd> <seq> <payload…> F7
```

| Byte | Value | Meaning |
|---|---|---|
| `F0` | | SysEx start |
| `7D` | | Manufacturer ID: non-commercial/educational |
| `53 43` | `'S' 'C'` | Product signature. `7D` is shared by everyone, so messages without this are ignored |
| `ver` | `01` | Protocol version (this document) |
| `cmd` | 0x00–0x7F | Command (see A.4) |
| `seq` | 0x00–0x7F | Chosen by the host; the reply echoes it. Unsolicited reports use 0 |
| payload | | Nibble-encoded bytes (A.3) |
| `F7` | | SysEx end |

The firmware buffers from `F0` to `F7` before acting (TinyUSB delivers SysEx
in 3-byte pieces). Messages longer than **256 bytes** including `F0`/`F7`
are dropped and answered with `ERR_TOO_LONG` if the header was readable.

### A.3 Payload encoding

Every payload byte is sent as **two SysEx bytes, high nibble first**:
byte `0xA7` → `0A 07`. This applies to the whole payload, including small
values like slot numbers, so both sides use one decoder and then read the
decoded bytes as a little-endian struct. An odd number of payload bytes on
the wire is a malformed message (`ERR_BAD_LENGTH`).

With the 256-byte limit, a decoded payload is at most 120 bytes. Data
chunks carry at most **64** data bytes.

### A.4 Commands

Host → device commands are 0x01–0x3F. Each gets exactly one reply with
`cmd | 0x40`, whose first decoded payload byte is a status code (A.6).
Device → host unsolicited reports are 0x60–0x6F.

Payload columns below show the **decoded** bytes.

| Cmd | Name | Request payload | Reply payload (after status) |
|---|---|---|---|
| 0x01 | `IDENTIFY` | — | see A.5 |
| 0x02 | `TABLE_INFO` | `u8 source` | `u16 length, u32 crc32, u16 format_version` |
| 0x03 | `TABLE_READ` | `u8 source, u16 offset, u8 count` (count ≤ 64) | `u16 offset, u8 data[count]` |
| 0x04 | `WRITE_BEGIN` | `u16 length, u32 crc32` | — |
| 0x05 | `WRITE_DATA` | `u16 offset, u8 data[≤64]` | `u16 next_offset` |
| 0x06 | `WRITE_COMMIT` | `u8 flags` | on `ERR_INVALID`: `u16 offset, u8 reason` |
| 0x07 | `SLOT_SAVE` | `u8 slot` | — |
| 0x08 | `SLOT_LOAD` | `u8 slot` | — |
| 0x09 | `SLOT_ERASE` | `u8 slot` | — |
| 0x0A | `ALL_NOTES_OFF` | — | — |

**`source`** in `TABLE_INFO`/`TABLE_READ`: `0x00–0x07` = flash slot,
`0xFF` = the working table (the one currently running, in RAM).

**Writing a table** (the only way to change configuration):

1. `WRITE_BEGIN` with the total blob length and its CRC-32. Discards any
   unfinished write.
2. `WRITE_DATA` chunks **in order**, offset 0 upwards. The host waits for
   each reply before sending the next (this is the flow control). An offset
   other than the expected one gives `ERR_SEQUENCE`.
3. `WRITE_COMMIT`. The device checks length, CRC and validity (B.8). On
   success the new table replaces the working table immediately: notes
   sounding from the old table get note-offs, sequencers stop, runtime state
   (transpose, scale changes) resets to the table's defaults.

`WRITE_COMMIT` flags:

| Bit | Meaning |
|---|---|
| 0 | Also save to the **active** slot after applying (same as a following `SLOT_SAVE active`) |
| 1–7 | Reserved, must be 0 |

The page should apply every edit immediately (flag 0 clear) and save
(flag 0 set, or `SLOT_SAVE`) after edits have paused for about 2 s. A
flash write stalls both cores for tens of milliseconds and wears the
sector, so it shouldn't happen on every Blockly keystroke.

**`SLOT_SAVE n`**: writes the working table to slot `n`. Doesn't change
which slot is active.
**`SLOT_LOAD n`**: loads slot `n` into the working table (same reset rules
as a commit), makes it the active slot and the slot used at power-up.
`ERR_SLOT_EMPTY` if the slot has no valid table.
**`SLOT_ERASE n`**: erases the slot. Erasing the active slot is allowed;
the working table keeps running until the next load or power cycle.

### A.5 `IDENTIFY` reply

| Field | Type | Notes |
|---|---|---|
| status | `u8` | always `OK` |
| protocol_version | `u8` | 1 |
| fw_version | `u8 major, u8 minor, u8 patch` | |
| hw_revision | `u8` | 1 = current board (stock Pico, 2 MB flash) |
| unique_id | `u8[8]` | `pico_get_unique_board_id()`; lets the page tell boards apart in the workshop |
| table_format_version | `u16` | highest rule-table format the firmware reads (1) |
| num_inputs | `u8` | 12 |
| num_analog | `u8` | 2 |
| num_slots | `u8` | 8 |
| active_slot | `u8` | 0–7: the slot last loaded, which `WRITE_COMMIT` flag 0 saves to. On a board with no valid slots it is the boot-state slot (0 on a new board), and the built-in default table is running. The page tracks unsaved edits itself |
| max_table_length | `u16` | 4080 (B.1) |
| max_rules | `u8` | 128 |
| max_sequences | `u8` | 4 |

The page opens port 2 by position, sends `IDENTIFY`, and treats the port as
a Switchcraft only if a valid reply arrives within 500 ms.

### A.6 Status codes

| Code | Name | Meaning |
|---|---|---|
| 0x00 | `OK` | |
| 0x01 | `ERR_UNKNOWN_CMD` | |
| 0x02 | `ERR_BAD_LENGTH` | payload too short/long for the command, or odd nibble count |
| 0x03 | `ERR_TOO_LONG` | message exceeded 256 bytes |
| 0x04 | `ERR_VERSION` | protocol version or table format not supported |
| 0x05 | `ERR_SEQUENCE` | `WRITE_DATA` without `WRITE_BEGIN`, or wrong offset |
| 0x06 | `ERR_CRC` | committed data doesn't match the CRC from `WRITE_BEGIN` |
| 0x07 | `ERR_INVALID` | table failed validation; reply carries offset and reason (B.8) |
| 0x08 | `ERR_RANGE` | slot or source number out of range, read past end |
| 0x09 | `ERR_SLOT_EMPTY` | slot has no valid table |
| 0x0A | `ERR_FLASH` | flash erase/program failed or read-back mismatch |
| 0x0B | `ERR_BUSY` | another write is in progress (reserved; single host for v1) |

### A.7 Unsolicited reports (device → host)

Sent on cable 2 whenever port 2 is open (the device can't tell, so always
send; the host may ignore them).

| Cmd | Name | Payload |
|---|---|---|
| 0x60 | `INPUT_EVENT` | `u8 input, u8 event` (1 = press, 2 = release, 3 = hold, 4 = tap) |
| 0x61 | `ANALOG_VALUE` | `u8 analog, u16 raw (0–4095), u8 scaled (0–127)` |
| 0x62 | `SLOT_CHANGED` | `u8 slot` (sent when a rule action switches preset) |

Events are reported after debounce and lockout (B.4), i.e. the events the
rule engine actually sees. Hold and tap reports use the global `hold_ms`
(individual rules may use their own hold times). `ANALOG_VALUE` is sent
only when `scaled` changes, at most 50 times per second per input.

Musical output (notes, CCs, clock) is also copied to cable 2 as ordinary
MIDI, per the plan; it isn't wrapped in SysEx.

### A.8 Worked example

Host asks for info on the working table, `seq` = 5:

```
F0 7D 53 43 01 02 05  0F 0F  F7            TABLE_INFO source=0xFF
```

Reply (status OK, length 0x0134, CRC 0x1A2B3C4D, format 1):

```
F0 7D 53 43 01 42 05
   00 00                 status   = 0x00
   03 04 00 01           length   = 0x34 0x01  → 0x0134
   04 0D 03 0C 02 0B 01 0A   crc  = 4D 3C 2B 1A
   00 01 00 00           format   = 0x01 0x00  → 1
F7
```

---

## Part B: Rule-table format (format version 1)

### B.1 Flash layout

Slots occupy the **last nine 4 KB sectors** of flash, addressed from
`PICO_FLASH_SIZE_BYTES` (2 MB on the stock Pico), so a future board with
more flash needs no change:

| Sector (from end) | Use |
|---|---|
| −1 | Boot state: which slot to load at power-up |
| −9 … −2 | Slots 0–7 (slot 0 lowest address) |

The firmware image must stay clear of these sectors (check in the linker
script or with a static assert against `__flash_binary_end`).

**Slot sector:**

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | magic | `u32` | `0x31464353` (`"SCF1"`) |
| 4 | format_version | `u16` | 1 |
| 6 | length | `u16` | table blob length, ≤ 4080 |
| 8 | crc32 | `u32` | over the blob only |
| 12 | reserved | `u32` | 0 |
| 16 | blob | `u8[length]` | the table, as transferred over SysEx |

A slot is **valid** only if magic, version and CRC all check out. An erased
sector (all `0xFF`) or a half-written one fails and is treated as empty.

**Boot-state sector:** `u32 magic 0x42435353 ("SSCB"), u8 boot_slot,
u8[3] reserved, u32 crc32` over the first 8 bytes. At power-up, the firmware
loads `boot_slot`; if that's invalid it tries slots 0–7 in order; if none is
valid it runs the built-in default table (B.9).

CRC-32 throughout is the standard IEEE/zlib polynomial (`0xEDB88320`
reflected, init `0xFFFFFFFF`, final XOR `0xFFFFFFFF`). The page computes
it in JS; the firmware can use software or the DMA sniffer.

### B.2 Blob structure

The blob is a fixed header followed by sections in any order:

```
header (8 bytes)
section: u8 id, u8 reserved, u16 length, u8 body[length]
section …
```

**Header:**

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | format_version | `u16` | 1 |
| 2 | blob_length | `u16` | must equal the transferred length |
| 4 | section_count | `u8` | |
| 5 | reserved | `u8[3]` | 0 |

**Section IDs:**

| ID | Section | Required | Status |
|---|---|---|---|
| 0x01 | `GLOBALS` | yes, once | v1 |
| 0x02 | `RULES` | yes, once (may hold 0 rules) | v1 |
| 0x03 | `SEQUENCE` | no, up to 4 | v1 |
| 0x10 | `EDITOR` | no | v1, ignored by firmware (B.7) |
| 0x04 | `EUCLID` | | reserved, priority 4 |
| 0x05 | `MODULATOR` | | reserved, priority 5 |

The firmware **rejects** a blob with an unknown section ID below 0x10 and
**skips** unknown IDs from 0x10 up. So adding editor-only data later never
breaks older firmware, while adding behaviour the firmware doesn't
understand fails loudly rather than silently doing nothing.

### B.3 `GLOBALS` section (0x01), 40 bytes

| Offset | Field | Type | Default | Notes |
|---|---|---|---|---|
| 0 | name | `u8[16]` | | ASCII preset name, NUL-padded |
| 16 | channel | `u8` | 0 | Default MIDI channel 0–15, used when an action's channel is `0xFF` |
| 17 | velocity | `u8` | 100 | Default velocity 1–127 |
| 18 | scale_root | `u8` | 0 | Pitch class 0–11 (0 = C) |
| 19 | base_octave | `u8` | 4 | Octave of scale degree 0; MIDI note = `12 * (octave + 1) + root` (4 → C4 = 60) |
| 20 | scale_mask | `u16` | `0x0AB5` | Bit *n* set = semitone *n* above the root is in the scale. `0x0AB5` = major. Bit 0 must be set |
| 22 | tempo | `u16` | 1200 | Internal tempo in tenths of BPM (1200 = 120.0) |
| 24 | debounce_ms | `u8` | 10 | |
| 25 | reserved | `u8` | 0 | |
| 26 | lockout_ms | `u16` | 0 | Accessibility: presses of the same input within this time of the last accepted press are ignored |
| 28 | hold_ms | `u16` | 500 | Default time for `HOLD` triggers |
| 30 | analog_min | `u16[2]` | 0, 0 | Raw ADC reading (0–4095) mapped to 0, per analog input |
| 34 | analog_max | `u16[2]` | 4095, 4095 | Raw ADC reading mapped to 127. May be **less** than `analog_min` to invert the input; the two must differ |
| 38 | reserved | `u8[2]` | 0 | |

Scales are just masks; the page owns the list of named scales. A rule can
change the root and mask at run time (`SET_SCALE`).

**Analog calibration.** The analog jacks read a voltage divider (sensor to
3.3 V, 10 kΩ to ground), so a typical 10 kΩ pedal only spans about half the
ADC range, and backwards. `analog_min`/`analog_max` map the range a sensor
actually covers onto 0–127; swapping them inverts it. Raw readings outside
the range are clamped. Note that an inverted input with nothing plugged in
reads 127.

### B.4 Inputs and events

Before any rule sees an input, the firmware:

1. debounces it (`debounce_ms`);
2. applies `lockout_ms` to presses (a press inside the lockout is dropped,
   and so is its matching release);
3. produces events: **press**, **release**, **hold** (once per press,
   when the input has stayed pressed for the rule's hold time) and **tap**
   (on release, if the input was released before the rule's hold time).

A press always fires `PRESS` rules immediately, even if the input also has
`HOLD` rules. To make one switch do different things on a short and a long
press, use `TAP` and `HOLD` rules on it (and no `PRESS` rule). A tap only
fires on release, so it is always slightly later than a press; editors
should offer `PRESS` by default and `TAP` only when the switch also has a
`HOLD` rule.

### B.5 `RULES` section (0x02)

Body: `u8 rule_count, u8 reserved[3]`, then `rule_count` rules of **12 bytes**
each. Maximum 128 rules. Rules are evaluated **in order**; every rule whose
trigger matches an event fires (no "first match wins").

**Rule layout:**

| Offset | Field | Type |
|---|---|---|
| 0 | trigger_type | `u8` |
| 1 | trigger_source | `u8` |
| 2 | trigger_arg | `u16` |
| 4 | action_type | `u8` |
| 5 | action_flags | `u8` |
| 6 | p0 | `u8` |
| 7 | p1 | `u8` |
| 8 | p2 | `u16` (or `i16`) |
| 10 | p3 | `u16` (or `i16`) |

#### Triggers

| Type | Name | source | arg |
|---|---|---|---|
| 0x01 | `PRESS` | input 0–11 | 0 |
| 0x02 | `RELEASE` | input 0–11 | 0 |
| 0x03 | `HOLD` | input 0–11 | hold time ms; 0 = `hold_ms` from globals |
| 0x04 | `CLOCK` | 0 | division in 24-PPQN ticks (24 = quarter note, 6 = sixteenth), at least 1. Fires on every *arg*-th tick of the internal clock |
| 0x05 | `LOAD` | 0 | 0. Fires once when this table becomes the working table (start a drone sequence, set initial state) |
| 0x06 | `ANALOG` | analog 0–1 | 0. Fires when the scaled 0–127 value changes; the value is passed to the action (see `CC`) |
| 0x07 | `TAP` | input 0–11 | hold time ms; 0 = `hold_ms` from globals. Fires on release if the input was held for less than this. Use the same value as the matching `HOLD` rule |

#### Actions

**Gate modes** (bits 0–1 of `action_flags`, used by `NOTE` and `SEQ_RUN`):

| Value | Mode | Behaviour |
|---|---|---|
| 0 | `HOLD` | On until the triggering input is released (with `PRESS` or `HOLD` triggers; with any other trigger it behaves as `ONESHOT`) |
| 1 | `LATCH` | Each firing toggles on/off |
| 2 | `ONESHOT` | On for a fixed time (`NOTE`: p3 ms; `SEQ_RUN`: one pass through the sequence) |

Other `action_flags` bits:

| Bit | Name | Meaning |
|---|---|---|
| 2 | `QUANTIZE` | Wait for the next beat (24-tick boundary) before acting. Accessibility: "start on the next beat" |
| 3 | `VALUE_FROM_TRIGGER` | Use the `ANALOG` trigger's value instead of the stored value (`CC` only) |
| 4 | `DEGREE` | p2 is a signed scale degree, not an absolute MIDI note (`NOTE` only) |
| 5–7 | | Reserved, 0 |

Channel `0xFF` and velocity `0` mean "use the default from globals".

| Type | Name | p0 | p1 | p2 | p3 |
|---|---|---|---|---|---|
| 0x00 | `NONE` | | | | |
| 0x01 | `NOTE` | channel | velocity | note: `i16` scale degree (−127…127) if `DEGREE` is set, else MIDI note 0–127 | ONESHOT length ms; 0 = 250 ms |
| 0x02 | `CC` | channel | controller 0–119 | value 0–127 | 0 |
| 0x10 | `SEQ_STEP` | sequence 0–3, or `0xFF` = selected | 0 | 0 | 0 |
| 0x11 | `SEQ_RUN` | sequence or `0xFF` | 0 | 0 | 0 |
| 0x12 | `SEQ_STOP` | sequence or `0xFF` | 0 | 0 | 0 |
| 0x13 | `SEQ_RESET` | sequence or `0xFF` | 0 | 0 | 0 |
| 0x14 | `SEQ_SELECT` | sequence 0–3 | 0 | 0 | 0 |
| 0x20 | `TRANSPOSE` | mode: 0 = set, 1 = add | 0 | `i16` semitones, −48…48 (the running total is also kept within ±48) | 0 |
| 0x21 | `SET_SCALE` | root 0–11, or `0xFF` = unchanged | 0 | scale_mask, or 0 = unchanged | 0 |
| 0x30 | `PRESET` | mode: 0 = slot p1, 1 = next, 2 = previous | slot 0–7 | 0 | 0 |
| 0x40–0x4F | | reserved: modulators (LFO/envelope start, stop, trigger) | | | |

**Scale-degree notes.** Degree 0 is `12 * (base_octave + 1) + scale_root`.
Positive degrees walk up through the set bits of `scale_mask`, wrapping into
the next octave; negative degrees walk down. Then `transpose` is added, and
the result is clamped to 0–127. So a form-view "switch 3 plays the 3rd
degree" survives a later `SET_SCALE` or `TRANSPOSE`, while absolute notes
(drum pads) are affected by `TRANSPOSE` only.

**Note-off is automatic.** A `NOTE` with `HOLD` sends its note-off on the
input's release; `LATCH` on the next firing; `ONESHOT` after p3 ms. The
note-off uses the pitch that was sent, even if the scale or transpose has
changed since. The form view therefore needs **one rule per switch**.

**`PRESET`** loads a slot exactly like `SLOT_LOAD` (including the boot
slot change and a `SLOT_CHANGED` report). Empty slots are skipped by
next/previous and ignored by direct selection.

### B.6 `SEQUENCE` section (0x03)

One section per sequence; the arpeggiator and the step sequencer are the
same thing. Header 12 bytes, then steps of 3 bytes. Maximum 256 steps per
sequence, and the whole blob must still fit in 4080 bytes.

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | id | `u8` | 0–3, unique |
| 1 | advance | `u8` | 0 = press (`SEQ_STEP` plays the next step), 1 = clock |
| 2 | order | `u8` | 0 = as written, 1 = up, 2 = down, 3 = up-down, 4 = random |
| 3 | octaves | `u8` | 1–4: the step list repeats this many octaves up |
| 4 | channel | `u8` | 0–15, `0xFF` = default |
| 5 | velocity | `u8` | 0 = default |
| 6 | division | `u8` | Clock mode: ticks per step (24-PPQN) |
| 7 | gate | `u8` | Clock mode: note length as % of the step, 1–100. Press mode: 0 = note held until the next step or the input's release; 1–100 = note length as % of a beat at the internal tempo |
| 8 | note_mode | `u8` | 0 = absolute MIDI notes, 1 = scale degrees (as in `NOTE`) |
| 9 | reserved | `u8` | 0 |
| 10 | step_count | `u16` | 1–256 |
| 12 | steps | `step[step_count]` | |

**Step (3 bytes):** `i8/u8 note` (absolute 0–127, or signed degree),
`u8 velocity` (0 = sequence velocity), `u8 flags_length`: bit 7 = rest,
bits 0–6 = length in steps (0 treated as 1; for imported tunes).

`order` reorders the notes when the sequence starts (up/down sort by
resulting pitch, so they work on chords entered in any order); `random`
picks a fresh step each time. `octaves` > 1 appends transposed copies
before ordering.

`SEQ_RUN` in clock mode starts playback from the first step, playing it
immediately (gate mode as in B.5: `HOLD` plays while the input is held,
`LATCH` toggles, `ONESHOT` plays once through). `SEQ_RUN` has no effect on
press-mode sequences: `SEQ_STEP` plays them. `SEQ_STEP` also works on a
clock-mode sequence, to advance it by hand. Only one note per sequence
sounds at a time.

### B.7 `EDITOR` section (0x10)

Opaque bytes for the page: e.g. a compressed Blockly workspace or a template
ID so a slot read back from the board can be reopened in the same editor.
Firmware stores and returns it but never reads it. Keep it small; it shares
the 4080-byte budget. (The JSON save files hold the full Blockly program
anyway, so the page may store nothing here.)

### B.8 Validation

`WRITE_COMMIT` and slot loads reject a table, with `ERR_INVALID`, a byte
offset into the blob and one of these reasons, if:

| Reason | Check |
|---|---|
| 0x01 | header `format_version` > supported, or `blob_length` mismatch |
| 0x02 | section runs past the end of the blob |
| 0x03 | unknown section ID < 0x10 |
| 0x04 | `GLOBALS` or `RULES` missing or duplicated |
| 0x05 | unknown trigger type, or source out of range |
| 0x06 | unknown action type, or a `PRESET` action on a `LOAD` trigger (it could chain loads forever) |
| 0x07 | parameter out of range (channel, note, CC number, slot, root, mask without bit 0) |
| 0x08 | action refers to a sequence ID that isn't defined |
| 0x09 | duplicate sequence ID, or step_count out of range |

The page should run the same checks before sending and show them in the
editor; the firmware check is the safety net. A table that fails at boot is
skipped (B.1), so a bad table can never brick the board.

### B.9 Built-in default table

Used when no slot is valid (new board, or all erased): C major from C4,
inputs 0–9 play scale degrees 0–9 with `HOLD` on the default channel,
inputs 10–11 transpose −12/+12, analog 0–1 send CC 1 and CC 74. The page
ships the identical blob as its "Scale player" starter template.
