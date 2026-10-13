"""Writes example MIDI files for trying the page's MIDI import (examples/midi/).

    python tools/make_example_midi.py

Needs: pip install mido. The tunes are traditional (public domain).
"""

from pathlib import Path

import mido

OUT = Path(__file__).resolve().parent.parent / "examples" / "midi"
PPQ = 480
PITCH = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def midi(name):
    """'E4', 'F#3', 'Bb2' -> MIDI note number."""
    letter, rest = name[0], name[1:]
    acc = 1 if rest.startswith("#") else -1 if rest.startswith("b") else 0
    octave = int(rest.lstrip("#b"))
    return 12 * (octave + 1) + PITCH[letter] + acc


def add_notes(track, events, channel=0, velocity=90):
    """events: [(start beats, length beats, [note names])]. Adds them in time order."""
    msgs = []
    for start, length, names in events:
        for n in names:
            msgs.append((round(start * PPQ), 1, mido.Message("note_on", channel=channel, note=midi(n), velocity=velocity)))
            msgs.append((round((start + length) * PPQ), 0, mido.Message("note_off", channel=channel, note=midi(n), velocity=0)))
    msgs.sort(key=lambda m: (m[0], m[1]))  # note-offs before note-ons at the same time
    now = 0
    for t, _, msg in msgs:
        track.append(msg.copy(time=t - now))
        now = t


def melody(notes_and_beats, gap=0.1, start=0.0):
    """[('E4', 1), ('-', 1), ...] -> events, each note slightly short of its length."""
    events, t = [], start
    for name, beats in notes_and_beats:
        if name != "-":
            events.append((t, beats * (1 - gap), [name]))
        t += beats
    return events


def named_track(name):
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("track_name", name=name))
    return track


def ode_to_joy():
    """Format 1: tempo track, melody, chords (channel 2), drums (channel 10)."""
    mid = mido.MidiFile(type=1, ticks_per_beat=PPQ)
    tempo = mido.MidiTrack()
    tempo.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(96)))
    tempo.append(mido.MetaMessage("time_signature", numerator=4, denominator=4))
    mid.tracks.append(tempo)

    tune = ("E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4".split(), "E4 D4 D4".split())
    phrase1 = [(n, 1) for n in tune[0]] + [("E4", 1.5), ("D4", 0.5), ("D4", 2)]
    phrase2 = [(n, 1) for n in tune[0][:10]] + [("D4", 1), ("E4", 1), ("D4", 1.5), ("C4", 0.5), ("C4", 2)]
    lead = named_track("Ode to Joy (melody)")
    add_notes(lead, melody(phrase1 + phrase2))
    mid.tracks.append(lead)

    chords = named_track("Chords")
    progression = ["C3 E3 G3", "G2 B2 D3", "C3 E3 G3", "G2 B2 D3", "C3 E3 G3", "G2 B2 D3", "C3 E3 G3", "G2 B2 D3 C3 E3 G3"]
    add_notes(chords, [(4 * i, 3.8, c.split()[:3]) for i, c in enumerate(progression)], channel=1, velocity=60)
    mid.tracks.append(chords)

    drums = named_track("Drums")
    beat = []
    for bar in range(8):
        for b in range(4):
            t = 4 * bar + b
            beat.append((t, 0.25, ["C2" if b % 2 == 0 else "D2"]))  # kick, snare
            beat.append((t + 0.5, 0.25, ["F#2"]))                    # hi-hat
    add_notes(drums, beat, channel=9, velocity=80)
    mid.tracks.append(drums)
    return mid


def twinkle_one_track():
    """Format 0: melody with harmony underneath, all on one track and channel."""
    mid = mido.MidiFile(type=0, ticks_per_beat=PPQ)
    track = named_track("Twinkle Twinkle")
    track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(100)))
    tune = "C5 C5 G5 G5 A5 A5 G5 - F5 F5 E5 E5 D5 D5 C5 -".split()
    harmony = ["E4 G4", "E4 G4", "E4 G4", "E4 G4", "F4 A4", "F4 A4", "E4 G4", "",
               "D4 F4", "D4 F4", "C4 E4", "C4 E4", "B3 D4", "B3 D4", "E4 G4", ""]
    events = []
    for i, (top, under) in enumerate(zip(tune, harmony)):
        names = ([top] if top != "-" else []) + under.split()
        if names:
            events.append((i, 0.9, names))
    add_notes(track, events)
    mid.tracks.append(track)
    return mid


def rhythm_and_rests():
    """Format 1: a melody with mixed lengths and real rests (for "in time" import)."""
    mid = mido.MidiFile(type=1, ticks_per_beat=PPQ)
    lead = named_track("Rhythm and rests")
    lead.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(110)))
    # Frère Jacques, with some lengths and rests changed to make the rhythm interesting.
    tune = [("G4", 1), ("A4", 1), ("B4", 1), ("G4", 1),
            ("G4", 0.5), ("A4", 0.5), ("B4", 1), ("-", 1), ("G4", 1),
            ("B4", 1), ("C5", 1), ("D5", 2),
            ("B4", 1), ("C5", 1), ("D5", 1.5), ("-", 0.5),
            ("D5", 0.5), ("E5", 0.5), ("D5", 0.5), ("C5", 0.5), ("B4", 1), ("G4", 1),
            ("G4", 1), ("D4", 1), ("G4", 2)]
    add_notes(lead, melody(tune, gap=0.15))
    mid.tracks.append(lead)
    return mid


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, make in [("ode-to-joy.mid", ode_to_joy), ("twinkle-one-track.mid", twinkle_one_track),
                       ("rhythm-and-rests.mid", rhythm_and_rests)]:
        path = OUT / name
        make().save(path)
        print(f"wrote {path.relative_to(OUT.parent.parent)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
