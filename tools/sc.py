"""Switchcraft config tool: talks to the board over its config MIDI port.

A stand-in for the browser page while the firmware is being tested. Protocol
and table format: docs/sysex-rule-table-spec.md.

Needs:  pip install mido python-rtmidi   (not needed for `selftest`)

    python tools/sc.py ports              list MIDI ports
    python tools/sc.py identify
    python tools/sc.py info [SOURCE]      SOURCE: slot 0-7 or "working" (default)
    python tools/sc.py dump [SOURCE]      read a table and print its rules
    python tools/sc.py write default|demo [--save]
    python tools/sc.py load|save|erase SLOT
    python tools/sc.py panic              all notes off
    python tools/sc.py calibration [MIN0 MAX0 MIN1 MAX1]   show or save analog calibration
    python tools/sc.py monitor            print switch events and MIDI output
    python tools/sc.py selftest           check encoding without a board
"""

import argparse
import struct
import sys
import time
import zlib

# --- Protocol (spec part A) ---

HEADER = [0xF0, 0x7D, 0x53, 0x43]
PROTOCOL_VERSION = 1
SOURCE_WORKING = 0xFF
CHUNK = 64

CMD = {
    "IDENTIFY": 0x01, "TABLE_INFO": 0x02, "TABLE_READ": 0x03, "WRITE_BEGIN": 0x04,
    "WRITE_DATA": 0x05, "WRITE_COMMIT": 0x06, "SLOT_SAVE": 0x07, "SLOT_LOAD": 0x08,
    "SLOT_ERASE": 0x09, "ALL_NOTES_OFF": 0x0A, "CALIBRATION_GET": 0x0B, "CALIBRATION_SET": 0x0C,
}
REPORT_INPUT, REPORT_ANALOG, REPORT_SLOT = 0x60, 0x61, 0x62
EVENTS = {1: "press", 2: "release", 3: "hold", 4: "tap"}

STATUS = {
    0x00: "OK", 0x01: "ERR_UNKNOWN_CMD", 0x02: "ERR_BAD_LENGTH", 0x03: "ERR_TOO_LONG",
    0x04: "ERR_VERSION", 0x05: "ERR_SEQUENCE", 0x06: "ERR_CRC", 0x07: "ERR_INVALID",
    0x08: "ERR_RANGE", 0x09: "ERR_SLOT_EMPTY", 0x0A: "ERR_FLASH", 0x0B: "ERR_BUSY",
}
INVALID = {
    1: "header", 2: "section bounds", 3: "unknown section", 4: "missing/duplicate section",
    5: "bad trigger", 6: "bad action", 7: "parameter out of range", 8: "undefined sequence",
    9: "bad sequence",
}


def encode(cmd, seq, payload=b""):
    msg = HEADER + [PROTOCOL_VERSION, cmd, seq & 0x7F]
    for b in payload:
        msg += [b >> 4, b & 0x0F]
    return msg + [0xF7]


def decode(msg):
    """Returns (cmd, seq, payload) or None if not a Switchcraft message."""
    msg = list(msg)
    if len(msg) < 8 or msg[:4] != HEADER or msg[-1] != 0xF7 or msg[4] != PROTOCOL_VERSION:
        return None
    nibbles = msg[7:-1]
    if len(nibbles) % 2:
        return None
    payload = bytes((nibbles[i] << 4) | nibbles[i + 1] for i in range(0, len(nibbles), 2))
    return msg[5], msg[6], payload


def crc32(data):
    return zlib.crc32(data) & 0xFFFFFFFF


# --- Table builder (spec part B) ---

TRIG = {"PRESS": 1, "RELEASE": 2, "HOLD": 3, "CLOCK": 4, "LOAD": 5, "ANALOG": 6, "TAP": 7}
ACT = {
    "NONE": 0x00, "NOTE": 0x01, "CC": 0x02, "SEQ_STEP": 0x10, "SEQ_RUN": 0x11,
    "SEQ_STOP": 0x12, "SEQ_RESET": 0x13, "SEQ_SELECT": 0x14, "TRANSPOSE": 0x20,
    "SET_SCALE": 0x21, "PRESET": 0x30,
}
GATE_HOLD, GATE_LATCH, GATE_ONESHOT = 0, 1, 2
QUANTIZE, VALUE_FROM_TRIGGER, DEGREE, REVERSE = 0x04, 0x08, 0x10, 0x20
DEFAULT = 0xFF  # default channel / selected sequence
MAJOR = 0x0AB5


def globals_section(name="", channel=0, velocity=100, root=0, octave=4, mask=MAJOR,
                    tempo=1200, debounce=10, lockout=0, hold=500):
    body = name.encode("ascii")[:16].ljust(16, b"\0")
    body += struct.pack("<BBBBHHBBHH", channel, velocity, root, octave, mask, tempo,
                        debounce, 0, lockout, hold)
    body += bytes(10)  # reserved: analog calibration is board-wide (spec B.10)
    return section(0x01, body)


def rule(trig, src, act, flags=0, p0=0, p1=0, p2=0, p3=0, arg=0):
    return struct.pack("<BBHBBBBHH", TRIG[trig], src, arg, ACT[act], flags, p0, p1,
                       p2 & 0xFFFF, p3 & 0xFFFF)


def rules_section(rules):
    return section(0x02, bytes([len(rules), 0, 0, 0]) + b"".join(rules))


def sequence_section(seq_id, steps, advance=1, order=0, octaves=1, channel=DEFAULT,
                     velocity=0, division=6, gate=50, degrees=True):
    """steps: list of note numbers/degrees, None for a rest."""
    body = struct.pack("<BBBBBBBBBBH", seq_id, advance, order, octaves, channel, velocity,
                       division, gate, 1 if degrees else 0, 0, len(steps))
    for s in steps:
        body += bytes([0, 0, 0x81]) if s is None else bytes([s & 0xFF, 0, 1])
    return section(0x03, body)


def section(section_id, body):
    return struct.pack("<BBH", section_id, 0, len(body)) + body


def build(sections):
    length = 8 + sum(len(s) for s in sections)
    return struct.pack("<HHB3x", 1, length, len(sections)) + b"".join(sections)


def default_table():
    """Same as the firmware's built-in table (spec B.9)."""
    rules = [rule("PRESS", i, "NOTE", GATE_HOLD | DEGREE, DEFAULT, 0, i) for i in range(10)]
    rules += [
        rule("PRESS", 10, "TRANSPOSE", 0, 1, 0, -12),
        rule("PRESS", 11, "TRANSPOSE", 0, 1, 0, 12),
        rule("ANALOG", 0, "CC", VALUE_FROM_TRIGGER, DEFAULT, 1),
        rule("ANALOG", 1, "CC", VALUE_FROM_TRIGGER, DEFAULT, 74),
    ]
    return build([globals_section("Scale player", hold=500), rules_section(rules)])


def demo_table():
    """Exercises the sequencer, tap/hold and latch."""
    rules = [rule("PRESS", i, "NOTE", GATE_HOLD | DEGREE, DEFAULT, 0, i) for i in range(6)]
    rules += [
        # 6: hold to play an up-down arpeggio over two octaves
        rule("PRESS", 6, "SEQ_RUN", GATE_HOLD, 0),
        # 7: latch a drone on the root, an octave down
        rule("PRESS", 7, "NOTE", GATE_LATCH | DEGREE, DEFAULT, 80, -7),
        # 8: tap steps through a tune, hold rewinds it
        rule("TAP", 8, "SEQ_STEP", 0, 1),
        rule("HOLD", 8, "SEQ_RESET", 0, 1),
        # 9: tap = next preset, hold = minor scale (until reloaded)
        rule("TAP", 9, "PRESET", 0, 1),
        rule("HOLD", 9, "SET_SCALE", 0, 0xFF, 0, 0x05AD),
        rule("PRESS", 10, "TRANSPOSE", 0, 1, 0, -12),
        rule("PRESS", 11, "TRANSPOSE", 0, 1, 0, 12),
        rule("ANALOG", 0, "CC", VALUE_FROM_TRIGGER, DEFAULT, 1),
        rule("ANALOG", 1, "CC", VALUE_FROM_TRIGGER, DEFAULT, 74),
    ]
    arp = sequence_section(0, [0, 2, 4], advance=1, order=3, octaves=2, division=6, gate=60)
    tune = sequence_section(1, [0, 0, 4, 4, 5, 5, 4, None, 3, 3, 2, 2, 1, 1, 0],
                            advance=0, gate=90)
    return build([globals_section("Demo"), rules_section(rules), arp, tune])


def describe(blob):
    """Short human-readable listing of a table."""
    ver, length, nsec = struct.unpack_from("<HHB", blob)
    out = [f"format {ver}, {length} bytes, {nsec} sections"]
    names = {v: k for k, v in TRIG.items()}
    acts = {v: k for k, v in ACT.items()}
    off = 8
    for _ in range(nsec):
        sid, _, slen = struct.unpack_from("<BBH", blob, off)
        body = blob[off + 4:off + 4 + slen]
        if sid == 0x01:
            name = body[:16].rstrip(b"\0").decode("ascii", "replace")
            ch, vel, root, octv, mask, tempo = struct.unpack_from("<BBBBHH", body, 16)
            out.append(f"globals: '{name}' ch {ch + 1} vel {vel} root {root} octave {octv} "
                       f"mask {mask:#06x} tempo {tempo / 10:g}")
        elif sid == 0x02:
            for i in range(body[0]):
                t, s, a, act, fl, p0, p1, p2, p3 = struct.unpack_from("<BBHBBBBhH", body, 4 + 12 * i)
                out.append(f"  rule {i:3}: {names.get(t, t)} {s}"
                           f"{f' ({a})' if a else ''} -> {acts.get(act, act)} "
                           f"flags {fl:#04x} p {p0} {p1} {p2} {p3}")
        elif sid == 0x03:
            out.append(f"sequence {body[0]}: {struct.unpack_from('<H', body, 10)[0]} steps, "
                       f"{'clock' if body[1] else 'press'} mode, order {body[2]}")
        else:
            out.append(f"section {sid:#04x}: {slen} bytes")
        off += 4 + slen
    return "\n".join(out)


# --- Board connection ---

class BoardError(Exception):
    pass


class Board:
    def __init__(self, port=None):
        import mido
        self.mido = mido
        ins, outs = mido.get_input_names(), mido.get_output_names()
        self.inp = mido.open_input(port or self._pick(ins))
        self.out = mido.open_output(port or self._pick(outs))
        self.seq = 0

    @staticmethod
    def _pick(names):
        # Port 2 of the board: "Switchcraft Config", or "MIDIIN2 (Switchcraft)"
        # style names from the Windows class driver.
        for n in names:
            if "Config" in n or ("Switchcraft" in n and "2" in n.split("Switchcraft")[0]):
                return n
        matches = [n for n in names if "Switchcraft" in n]
        if len(matches) >= 2:
            return sorted(matches)[1]
        raise BoardError(f"no Switchcraft config port in {names}")

    def request(self, cmd, payload=b"", timeout=1.0):
        self.seq = (self.seq + 1) & 0x7F
        self.out.send(self.mido.Message("sysex", data=encode(CMD[cmd], self.seq, payload)[1:-1]))
        deadline = time.time() + timeout
        while time.time() < deadline:
            for msg in self.inp.iter_pending():
                if msg.type != "sysex":
                    continue
                r = decode([0xF0, *msg.data, 0xF7])
                if r and r[0] == CMD[cmd] | 0x40 and r[1] == self.seq:
                    status, data = r[2][0], r[2][1:]
                    if status != 0:
                        detail = ""
                        if status == 0x07 and len(data) == 3:
                            off, why = struct.unpack("<HB", data)
                            detail = f" at byte {off}: {INVALID.get(why, why)}"
                        raise BoardError(f"{cmd}: {STATUS.get(status, status)}{detail}")
                    return data
            time.sleep(0.001)
        raise BoardError(f"{cmd}: no reply")

    def identify(self):
        d = self.request("IDENTIFY")
        f = struct.unpack("<BBBBB8sHBBBBHBB", d)
        return {
            "protocol": f[0], "firmware": f"{f[1]}.{f[2]}.{f[3]}", "hw_revision": f[4],
            "unique_id": f[5].hex(), "table_format": f[6], "inputs": f[7], "analog": f[8],
            "slots": f[9], "active_slot": f[10], "max_table": f[11], "max_rules": f[12],
            "max_sequences": f[13],
        }

    def info(self, source):
        return struct.unpack("<HIH", self.request("TABLE_INFO", bytes([source])))

    def read_table(self, source):
        length, crc, _ = self.info(source)
        blob = b""
        while len(blob) < length:
            n = min(CHUNK, length - len(blob))
            d = self.request("TABLE_READ", struct.pack("<BHB", source, len(blob), n))
            blob += d[2:]
        if crc32(blob) != crc:
            raise BoardError("CRC mismatch reading table")
        return blob

    def write_table(self, blob, save=False):
        self.request("WRITE_BEGIN", struct.pack("<HI", len(blob), crc32(blob)))
        for off in range(0, len(blob), CHUNK):
            self.request("WRITE_DATA", struct.pack("<H", off) + blob[off:off + CHUNK])
        self.request("WRITE_COMMIT", bytes([1 if save else 0]))

    def monitor(self):
        print("Listening (Ctrl+C to stop)...")
        for msg in self.inp:
            if msg.type == "sysex":
                r = decode([0xF0, *msg.data, 0xF7])
                if r and r[0] == REPORT_INPUT:
                    print(f"input {r[2][0]:2}  {EVENTS.get(r[2][1], r[2][1])}")
                elif r and r[0] == REPORT_ANALOG:
                    a, raw, scaled = struct.unpack("<BHB", r[2])
                    print(f"analog {a}  raw {raw:4}  value {scaled}")
                elif r and r[0] == REPORT_SLOT:
                    print(f"preset slot {r[2][0]}")
            else:
                print(f"  midi  {msg}")


# --- Self-test (no board needed) ---

def selftest():
    msg = encode(0x02, 5, bytes([0xFF]))
    assert msg == [0xF0, 0x7D, 0x53, 0x43, 0x01, 0x02, 0x05, 0x0F, 0x0F, 0xF7], msg
    # Worked example from spec A.8.
    reply = [0xF0, 0x7D, 0x53, 0x43, 0x01, 0x42, 0x05, 0, 0, 3, 4, 0, 1,
             4, 0xD, 3, 0xC, 2, 0xB, 1, 0xA, 0, 1, 0, 0, 0xF7]
    cmd, seq, payload = decode(reply)
    assert (cmd, seq) == (0x42, 5)
    assert struct.unpack("<BHIH", payload) == (0, 0x0134, 0x1A2B3C4D, 1)
    assert crc32(b"123456789") == 0xCBF43926  # standard CRC-32 check value

    for name, blob in (("default", default_table()), ("demo", demo_table())):
        length = struct.unpack_from("<H", blob, 2)[0]
        assert length == len(blob) <= 4080, (name, length)
        assert len(rule("PRESS", 0, "NOTE")) == 12
        # Longest message: a full WRITE_DATA chunk.
        chunk = encode(0x05, 1, struct.pack("<H", 0) + blob[:CHUNK])
        assert len(chunk) <= 256
        print(f"{name}: {len(blob)} bytes, CRC {crc32(blob):08x}")
        print(describe(blob))
    print("selftest OK")


def parse_source(s):
    return SOURCE_WORKING if s in (None, "working") else int(s)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--port", help="MIDI port name (default: auto-detect port 2)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("ports", "identify", "panic", "monitor", "selftest"):
        sub.add_parser(name)
    for name in ("info", "dump"):
        sub.add_parser(name).add_argument("source", nargs="?")
    w = sub.add_parser("write")
    w.add_argument("table", choices=["default", "demo"])
    w.add_argument("--save", action="store_true", help="also save to the active slot")
    for name in ("load", "save", "erase"):
        sub.add_parser(name).add_argument("slot", type=int)
    sub.add_parser("calibration").add_argument("values", nargs="*", type=int)
    args = ap.parse_args()

    if args.cmd == "selftest":
        return selftest()
    if args.cmd == "ports":
        import mido
        print("inputs: ", mido.get_input_names())
        print("outputs:", mido.get_output_names())
        return

    try:
        board = Board(args.port)
        if args.cmd == "identify":
            for k, v in board.identify().items():
                print(f"{k:14} {v}")
        elif args.cmd == "info":
            length, crc, fmt = board.info(parse_source(args.source))
            print(f"length {length}, CRC {crc:08x}, format {fmt}")
        elif args.cmd == "dump":
            print(describe(board.read_table(parse_source(args.source))))
        elif args.cmd == "write":
            blob = default_table() if args.table == "default" else demo_table()
            board.write_table(blob, save=args.save)
            print(f"wrote {len(blob)} bytes{' and saved' if args.save else ''}")
        elif args.cmd in ("load", "save", "erase"):
            board.request("SLOT_" + args.cmd.upper(), bytes([args.slot]))
            print("OK")
        elif args.cmd == "calibration":
            if args.values:
                if len(args.values) != 4:
                    sys.exit("give MIN0 MAX0 MIN1 MAX1")
                min0, max0, min1, max1 = args.values
                board.request("CALIBRATION_SET", struct.pack("<BHHHH", 1, min0, min1, max0, max1))
            cal = struct.unpack("<HHHH", board.request("CALIBRATION_GET"))
            for i in range(2):
                lo, hi = cal[i], cal[2 + i]
                print(f"analog {i}: {lo} -> 0, {hi} -> 127{' (inverted)' if hi < lo else ''}")
        elif args.cmd == "panic":
            board.request("ALL_NOTES_OFF")
        elif args.cmd == "monitor":
            board.monitor()
    except BoardError as e:
        sys.exit(f"error: {e}")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
