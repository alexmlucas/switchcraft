# Switchcraft firmware

Pico SDK (C) + TinyUSB firmware for the stock Raspberry Pi Pico board.
Implements [docs/sysex-rule-table-spec.md](../docs/sysex-rule-table-spec.md);
pins are in [docs/pin-map.md](../docs/pin-map.md).

| File | Does |
|---|---|
| `src/main.c` | Start-up and main loop |
| `src/usb_descriptors.c` | USB MIDI device with two virtual cables. **Bump `USB_BCD_DEVICE` on every change** |
| `src/midi.c` | USB-MIDI packets in and out; musical output goes to both cables |
| `src/protocol.c` | Config SysEx: framing, nibble encoding, commands, reports |
| `src/table.c` | Rule-table format: validation, parsing, built-in default table |
| `src/config.c` | The working table and active slot |
| `src/slots.c` | Preset slots and boot state in the last 36 KB of flash |
| `src/inputs.c` | Switch debounce/lockout, analog smoothing, analog LEDs |
| `src/engine.c` | Runs the rules: notes, CCs, sequencer/arpeggiator, transpose, scales, presets, internal clock |

## Build

Needs the Pico SDK 2.1.1, an `arm-none-eabi-gcc` toolchain, CMake, Ninja
and a prebuilt picotool 2.1.1 (otherwise the SDK tries to compile picotool,
which needs a host C++ compiler). The VS Code Raspberry Pi Pico extension
installs all of these under `~/.pico-sdk`.

```sh
export PICO_SDK_PATH=~/.pico-sdk/sdk/2.1.1
cmake -S firmware -B firmware/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -Dpicotool_DIR=~/.pico-sdk/picotool/2.1.1/picotool
cmake --build firmware/build
```

Output: `firmware/build/switchcraft.uf2`.

## Flash

Hold BOOTSEL on the Pico while plugging it in, then copy `switchcraft.uf2`
to the `RPI-RP2` drive. The Pico's own LED lights once USB MIDI is up. If
it blinks fast, the firmware has grown into the preset-slot area of flash.

## Test without the browser page

`tools/sc.py` speaks the config protocol from a laptop:

```sh
pip install mido python-rtmidi
python tools/sc.py ports         # expect two Switchcraft ports in each list
python tools/sc.py identify
python tools/sc.py monitor       # press switches: events and notes appear
python tools/sc.py write demo    # sequencer, tap/hold, latch (see demo_table())
python tools/sc.py save 0        # keep it across power cycles
python tools/sc.py dump          # read the working table back
```

`python tools/sc.py selftest` checks the encoding and table builder offline.

### Week 1: two ports at once on Windows

1. Flash the board and plug it in.
2. Open a DAW (or MIDI-OX) on port 1, **Switchcraft**, and arm a track.
3. While the DAW is open, run `python tools/sc.py monitor` (port 2).
4. Press switches: the notes should reach the DAW **and** appear in the monitor.
5. Run `python tools/sc.py identify` with the DAW still open.

If step 3 or 5 can't open the port, the two-cable plan needs rethinking
before the browser page is built on it.

## Not done yet

- External MIDI clock in (priority 6). Input on cable 1 is ignored.
- Euclidean rhythms and LFO/envelope modulation (priorities 4–5): their
  section and action IDs are reserved in the spec.
- The USB VID/PID are TinyUSB placeholders (`0xCAFE`). Get a real PID
  (e.g. from pid.codes) before boards are handed out.
