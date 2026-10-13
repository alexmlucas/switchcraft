"""Plays Euclidean rhythms on a connected board and checks their timing.

1. 3 hits in 8 sixteenths at 120 BPM, started by the preset: the gaps
   between notes must follow the pattern x..x..x. (3, 3, 2 steps).
2. A live edit to 5 hits in 8 while it plays: the notes must carry on
   without stopping, now in the x.x.xx.x pattern (spec A.4, B.6.1).
3. A chord with a rhythm: hits play the notes in order, misses don't skip.

The board's working table is restored afterwards (nothing is saved).

    python tools/check_board_rhythm.py

Needs a board with firmware 0.4.1 or later, and: pip install mido python-rtmidi
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import sc  # noqa: E402

STEP_MS = 125      # a sixteenth note at 120 BPM
TOLERANCE_MS = 25  # USB and host timing jitter


def rhythm_table(steps, hits, notes, start=True):
    rules = [sc.rule("LOAD", 0, "SEQ_RUN", sc.GATE_LATCH, 0)] if start else []
    return sc.build([
        sc.globals_section("Rhythm test", tempo=1200),
        sc.rules_section(rules),
        sc.sequence_section(0, notes, advance=1, order=0, division=6, gate=50, degrees=False),
        sc.euclid_section(0, steps, hits),
    ])


def expected_gaps(steps, hits):
    """Gaps in steps between hits, going round the pattern once."""
    on = [i for i, h in enumerate(sc.euclid_hits(steps, hits)) if h]
    return [(on[(j + 1) % len(on)] - on[j]) % steps or steps for j in range(len(on))]


def listen(board, seconds):
    """Note-ons on the config port: [(time ms, note)]."""
    notes = []
    end = time.time() + seconds
    while time.time() < end:
        for m in board.inp.iter_pending():
            if m.type == "note_on" and m.velocity > 0:
                notes.append((time.perf_counter() * 1000, m.note))
        time.sleep(0.0005)
    return notes


def gaps_in_steps(notes):
    """Gaps between note-ons, in steps; raises if a gap isn't close to a whole step."""
    gaps = []
    for (a, _), (b, _) in zip(notes, notes[1:]):
        steps = round((b - a) / STEP_MS)
        if abs((b - a) - steps * STEP_MS) > TOLERANCE_MS:
            raise AssertionError(f"gap of {b - a:.0f} ms is not a whole number of {STEP_MS} ms steps")
        gaps.append(steps)
    return gaps


def fits_cycle(gaps, cycle):
    """True if `gaps` is a run of the repeating `cycle`, starting anywhere in it."""
    return any(all(g == cycle[(start + i) % len(cycle)] for i, g in enumerate(gaps)) for start in range(len(cycle)))


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")
    return ok


def main():
    board = sc.Board()
    version = board.identify()["firmware"]
    if tuple(int(x) for x in version.split(".")) < (0, 4, 1):
        sys.exit(f"firmware {version} is too old for this test: flash 0.4.1 or later")
    original = board.read_table(sc.SOURCE_WORKING)
    ok = True
    try:
        # 1. Timing of 3 in 8.
        board.write_table(rhythm_table(8, 3, [60]))
        notes = listen(board, 3)
        gaps = gaps_in_steps(notes[1:])  # the first note can come before the clock settles
        cycle = expected_gaps(8, 3)
        ok &= check("3 in 8: pattern x..x..x.", len(gaps) >= 6 and fits_cycle(gaps, cycle),
                    f"{len(notes)} notes, gaps {gaps} (expected repeats of {cycle})")

        # 2. Live edit to 5 in 8: no restart, no stop, new pattern.
        t0 = time.perf_counter() * 1000
        board.write_table(rhythm_table(8, 5, [60], start=False), restart=False)  # an edit
        notes = listen(board, 3)
        first_gap = notes[0][0] - t0 if notes else None
        gaps = gaps_in_steps(notes[1:])
        cycle = expected_gaps(8, 5)
        ok &= check("live edit keeps playing", bool(notes) and first_gap < 3 * STEP_MS + TOLERANCE_MS,
                    f"first note {first_gap:.0f} ms after the edit" if notes else "no notes after the edit")
        ok &= check("5 in 8 after the edit: pattern x.x.xx.x", len(gaps) >= 8 and fits_cycle(gaps, cycle),
                    f"gaps {gaps} (expected repeats of {cycle})")

        # 3. A chord with a rhythm: hits take the notes in order. (A new preset:
        # a restart, so its "when this preset starts" rule fires.)
        board.write_table(rhythm_table(8, 3, [60, 64, 67]))
        notes = [n for _, n in listen(board, 2)]
        in_order = all(notes[i + 1] == {60: 64, 64: 67, 67: 60}[notes[i]] for i in range(len(notes) - 1))
        ok &= check("chord: hits play C E G in order", len(notes) >= 4 and in_order, f"notes {notes}")
    finally:
        board.write_table(original)
        board.request("ALL_NOTES_OFF")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
