"""Sends MIDI clock into a connected board and checks that it follows (spec B.11).

A sequence plays a note every sixteenth (6 clock ticks), started by the preset.
1. Internal clock, 120 BPM: notes every 125 ms.
2. Start, then clock at 100 BPM into the music port: the first note on the
   first clock, then every 150 ms; the board reports "external, 100 BPM".
3. The clock stops without a Stop message: within about 0.5 s the board is
   back on 120 BPM (notes every 125 ms) and reports "internal".
4. Clock again, then Stop: back to internal straight away.
5. A preset with "ignore clock": clock at 100 BPM changes nothing.

The board's working table is restored afterwards (nothing is saved).

    python tools/check_board_clock.py

Needs firmware 0.6.1 or later, and: pip install mido python-rtmidi
"""

import struct
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import sc  # noqa: E402

TOLERANCE_MS = 30


def now_ms():
    return time.perf_counter() * 1000


def table(ignore_clock=False):
    return sc.build([
        sc.globals_section("Clock test", tempo=1200, ignore_clock=ignore_clock),
        sc.rules_section([sc.rule("LOAD", 0, "SEQ_RUN", sc.GATE_LATCH, 0)]),
        sc.sequence_section(0, [60], advance=1, order=0, division=6, gate=50, degrees=False),
    ])


class ClockSender:
    """Sends MIDI clock at a steady tempo from a thread (busy-waits for accuracy)."""

    def __init__(self, port, bpm):
        self.port, self.interval = port, 60_000 / bpm / 24
        self.running = False
        self.first_clock_ms = None

    def start(self, send_start=True):
        self.running = True
        if send_start:
            self.port.send(sc_mido().Message("start"))
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        clock = sc_mido().Message("clock")
        t = now_ms()
        while self.running:
            if self.first_clock_ms is None:
                self.first_clock_ms = now_ms()
            self.port.send(clock)
            t += self.interval
            while now_ms() < t - 2:
                time.sleep(0.001)
            while now_ms() < t:
                pass

    def stop(self, send_stop=False):
        self.running = False
        self.thread.join()
        if send_stop:
            self.port.send(sc_mido().Message("stop"))


def sc_mido():
    import mido
    return mido


def listen(board, seconds):
    """Note-on times (ms) and clock reports [(ms, source, tempo)] on the config port."""
    notes, clocks = [], []
    end = time.time() + seconds
    while time.time() < end:
        for m in board.inp.iter_pending():
            t = now_ms()
            if m.type == "note_on" and m.velocity > 0:
                notes.append(t)
            elif m.type == "sysex":
                r = sc.decode([0xF0, *m.data, 0xF7])
                if r and r[0] == sc.REPORT_CLOCK:
                    source, tempo = struct.unpack("<BH", r[2])
                    clocks.append((t, source, tempo / 10))
        time.sleep(0.0005)
    return notes, clocks


def gaps(times):
    return [round(b - a) for a, b in zip(times, times[1:])]


def steady(gs, expected):
    return len(gs) >= 4 and all(abs(g - expected) <= TOLERANCE_MS for g in gs)


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")
    return ok


def music_port(board):
    mido = sc_mido()
    names = [n for n in mido.get_output_names() if "Switchcraft" in n and n != board.out.name]
    if not names:
        sys.exit("can't find the board's music port")
    return mido.open_output(names[0])


def main():
    board = sc.Board()
    version = board.identify()["firmware"]
    if tuple(int(x) for x in version.split(".")) < (0, 6, 1):
        sys.exit(f"firmware {version} is too old for this test: flash 0.6.1 or later")
    music = music_port(board)
    original = board.read_table(sc.SOURCE_WORKING)
    ok = True
    try:
        # 1. Internal clock.
        board.write_table(table())
        notes, _ = listen(board, 1.2)
        ok &= check("internal 120 BPM: a note every 125 ms", steady(gaps(notes[1:]), 125), f"gaps {gaps(notes[1:])}")

        # 2. Follow 100 BPM from a Start.
        sender = ClockSender(music, 100)
        sender.start()
        notes, clocks = listen(board, 2.5)
        first = notes[0] - sender.first_clock_ms if notes and sender.first_clock_ms else None
        ok &= check("Start: first note on the first clock", first is not None and abs(first) <= TOLERANCE_MS,
                    f"{first:.0f} ms after it" if first is not None else "no notes")
        ok &= check("following 100 BPM: a note every 150 ms", steady(gaps(notes[1:]), 150), f"gaps {gaps(notes[1:])}")
        ext = [c for c in clocks if c[1] == 1]
        ok &= check("board reports external ~100 BPM (from the first report)",
                    bool(ext) and all(abs(t - 100) <= 2 for _, _, t in ext),
                    f"reports {[(s, t) for _, s, t in clocks]}")

        # 3. Clock stops (no Stop message): fall back after ~0.5 s.
        sender.stop()
        stopped = now_ms()
        notes, clocks = listen(board, 2.0)
        back = [c for c in clocks if c[1] == 0]
        delay = back[0][0] - stopped if back else None
        ok &= check("clock gone: back to internal after ~0.5 s", delay is not None and 450 <= delay <= 650,
                    f"internal reported after {delay:.0f} ms" if delay is not None else f"reports {clocks}")
        late = [t for t in notes if t > stopped + 700]
        ok &= check("then a note every 125 ms again", steady(gaps(late), 125), f"gaps {gaps(late)}")

        # 4. Explicit Stop: immediate.
        sender = ClockSender(music, 100)
        sender.start(send_start=False)
        listen(board, 0.6)
        sender.stop(send_stop=True)
        stopped = now_ms()
        _, clocks = listen(board, 0.4)
        back = [c for c in clocks if c[1] == 0]
        delay = back[0][0] - stopped if back else None
        ok &= check("Stop: back to internal straight away", delay is not None and delay <= 100,
                    f"after {delay:.0f} ms" if delay is not None else f"reports {clocks}")

        # 5. A preset that ignores clock.
        board.write_table(table(ignore_clock=True))
        sender = ClockSender(music, 100)
        sender.start()
        notes, clocks = listen(board, 1.5)
        sender.stop(send_stop=True)
        ok &= check("ignore clock: stays at 125 ms", steady(gaps(notes[1:]), 125) and not any(c[1] for c in clocks),
                    f"gaps {gaps(notes[1:])}, reports {clocks}")
    finally:
        board.write_table(original)
        board.request("ALL_NOTES_OFF")
        music.close()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
