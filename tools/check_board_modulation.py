"""Runs modulators on a connected board and checks what it sends.

1. A square LFO synced to the beat (120 BPM) on CC 20, 10 -> 100: only those
   two values, switching every half beat (250 ms).
2. An AD envelope on CC 21 (attack 300 ms, decay 600 ms): rises to 127 in
   about 300 ms and is back at 0 about 900 ms after it starts; never more
   than about 100 messages a second.
3. An envelope on pitch bend, middle -> top: 14-bit bend values, ending at
   full bend.
4. A live edit changing the LFO's speed: it keeps running (spec A.4).

The board's working table is restored afterwards (nothing is saved).

    python tools/check_board_modulation.py

Needs firmware 0.5.0 or later, and: pip install mido python-rtmidi
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import sc  # noqa: E402

TOLERANCE_MS = 30


def table(*mods, run=(0,)):
    rules = [sc.rule("LOAD", 0, "MOD_RUN", sc.GATE_LATCH, m) for m in run]
    return sc.build([sc.globals_section("Modulation test", tempo=1200), sc.rules_section(rules), *mods])


def listen(board, seconds):
    """[(time ms, kind, number, value)] for CCs and pitch bend on the config port."""
    got = []
    end = time.time() + seconds
    while time.time() < end:
        for m in board.inp.iter_pending():
            t = time.perf_counter() * 1000
            if m.type == "control_change":
                got.append((t, "cc", m.control, m.value))
            elif m.type == "pitchwheel":
                got.append((t, "bend", 0, m.pitch + 8192))
        time.sleep(0.0005)
    return got


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")
    return ok


def main():
    board = sc.Board()
    version = board.identify()["firmware"]
    if tuple(int(x) for x in version.split(".")) < (0, 5, 0):
        sys.exit(f"firmware {version} has no modulators: flash 0.5.0 or later")
    original = board.read_table(sc.SOURCE_WORKING)
    ok = True
    try:
        # 1. Square LFO, one cycle per beat.
        lfo = sc.modulator_section(0, "lfo", "cc", 20, low=10, high=100, synced=True, wave="square", rate=24)
        board.write_table(table(lfo))
        msgs = [m for m in listen(board, 2.5) if m[1] == "cc" and m[2] == 20]
        values = {v for _, _, _, v in msgs}
        gaps = [b[0] - a[0] for a, b in zip(msgs[1:], msgs[2:])]
        ok &= check("square LFO sends only 10 and 100", values == {10, 100}, f"values {sorted(values)}")
        ok &= check("square LFO switches every 250 ms",
                    len(gaps) >= 6 and all(abs(g - 250) <= TOLERANCE_MS for g in gaps),
                    f"{len(msgs)} changes, gaps {[round(g) for g in gaps]} ms")

        # 4. Live edit: twice as fast, without stopping.
        lfo2 = sc.modulator_section(0, "lfo", "cc", 20, low=10, high=100, synced=True, wave="square", rate=12)
        t0 = time.perf_counter() * 1000
        board.write_table(table(lfo2, run=()), restart=False)
        msgs = [m for m in listen(board, 1.5) if m[1] == "cc" and m[2] == 20]
        gaps = [b[0] - a[0] for a, b in zip(msgs[1:], msgs[2:])]
        ok &= check("live edit: LFO keeps running", bool(msgs) and msgs[0][0] - t0 < 300 + TOLERANCE_MS,
                    f"first change {msgs[0][0] - t0:.0f} ms after the edit" if msgs else "nothing after the edit")
        ok &= check("live edit: now every 125 ms", len(gaps) >= 6 and all(abs(g - 125) <= TOLERANCE_MS for g in gaps),
                    f"gaps {[round(g) for g in gaps]} ms")

        # 2. AD envelope.
        env = sc.modulator_section(0, "env", "cc", 21, low=0, high=127, sustain=0, attack=300, decay=600)
        start = time.perf_counter() * 1000
        board.write_table(table(env))
        msgs = [m for m in listen(board, 1.5) if m[1] == "cc" and m[2] == 21]
        if msgs:
            t_first = msgs[0][0]
            peak_t = next(t for t, _, _, v in msgs if v == 127) - t_first if any(v == 127 for *_, v in msgs) else None
            end_t = msgs[-1][0] - t_first
            rises = [v for _, _, _, v in msgs[: [v for *_, v in msgs].index(127) + 1]] if peak_t is not None else []
            spacing = [b[0] - a[0] for a, b in zip(msgs, msgs[1:])]
            ok &= check("envelope peaks at 127 after ~300 ms", peak_t is not None and abs(peak_t - 300) <= 60,
                        f"peak after {peak_t:.0f} ms" if peak_t is not None else "never reached 127")
            ok &= check("envelope back to 0 after ~900 ms", msgs[-1][3] == 0 and abs(end_t - 900) <= 90,
                        f"last value {msgs[-1][3]} after {end_t:.0f} ms")
            ok &= check("envelope rises steadily", rises == sorted(rises), "")
            ok &= check("at most ~100 messages a second", len(msgs) <= 100 and min(spacing) >= 8,
                        f"{len(msgs)} messages, closest {min(spacing):.1f} ms apart")
        else:
            ok &= check("envelope sends CC 21", False, "nothing received")

        # 3. Pitch bend envelope, middle to top.
        bend = sc.modulator_section(0, "env", "bend", low=64, high=127, sustain=100, attack=200)
        board.write_table(table(bend))
        msgs = [m for m in listen(board, 0.8) if m[1] == "bend"]
        vals = [v for *_, v in msgs]
        ok &= check("pitch bend from the middle to full", bool(vals) and abs(vals[0] - 8192) < 1500 and vals[-1] == 16383,
                    f"{len(vals)} bends, {vals[0] if vals else '-'} -> {vals[-1] if vals else '-'}")
    finally:
        board.write_table(original)
        board.request("ALL_NOTES_OFF")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
