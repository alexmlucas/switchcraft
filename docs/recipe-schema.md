# Recipe schema (draft, v1)

A **recipe** is one sentence:

> When **[who]** **[how]** the **[switch]**, the **[device]** will **[job]**.

The recipe schema ([web/recipe.schema.json](../web/recipe.schema.json)) is the
contract between the ways people can describe what they want and the band
model in `band.js`:

```
 recipe cards ─┐
 typed or spoken request ─▶ parser or language model ─┐
 sentence chips in the editor ─────────────────────────┴─▶ recipe request (JSON)
        ─▶ validate ─▶ show as sentences ─▶ person confirms ─▶ compile to band ─▶ rule table
```

Two rules hold throughout:

1. **Nothing writes the rule table directly.** A model, parser or person only
   ever produces recipes. `recipe.js` (to write) checks them and compiles
   them into the band with the existing `addMusician`, `addDevice` and
   `assign` functions.
2. **Every recipe is shown back as a sentence and confirmed before it
   changes the band.** Undo is one step.

Worked examples, which also start the test set, are in
[web/recipe-examples.json](../web/recipe-examples.json).

## Shape

A **recipe request** has:

| Field | What it holds |
|---|---|
| `version` | `1` |
| `mode` | `add`: merge into the open band. `new-band`: start from blank. |
| `band` | Optional: `tempoBpm`, `key` (`root`, `scale`). |
| `musicians` | Who plays, with their access settings. |
| `devices` | The devices the recipes use, each with an `id`, `who`, `kind` and optional `settings`. |
| `recipes` | One per sentence: `device` (an id), `job`, `switch`, `how`, `note`. |
| `unmapped` | Parts of the request that can't be built yet. These go to the **wish pile**. |
| `questions` | What to ask when the request is ambiguous. A slot is left `null` rather than guessed. |

Why devices are separate from recipes: several recipes can share one device
("next note" on switch 1 and "back to the start" on switch 2 drive one tune),
and the device's settings belong in one place, not repeated in each sentence.

Recipe field values use the words on the cards, not the model's internal
names, so a model or parser can produce them and a person can read them.

## Mapping to band.js

### Musicians

| Recipe | band.js |
|---|---|
| `name` | `name` (new musicians get a colour and channel from `addMusician`) |
| `colour` | `colour`: index into `COLOURS` by name |
| `loudness` quiet / medium / loud | `velocity` 60 / 100 / 127 |
| `ignoreRepeatPressesMs` | `lockoutMs` |
| `countsAsHeldMs` | `holdMs` |

A musician who plays drums (a `drum` note, or a sequencer `beat`) gets MIDI
channel 10 (`9` in band.js). If the same musician also plays pitched notes,
the validator asks (see Open questions).

### Devices and jobs

| Recipe `kind` | band.js `kind` | Jobs → roles |
|---|---|---|
| `notes` | `notes` | `play-note` → an entry in `keys` (`{input, value}`) |
| `sequencer` | `seq` | `next-note` → `step` (one note per press only); `play` → `play` (by itself only); `back-to-start` → `restart` |
| `arpeggiator` | `arp` | `play` → `play` |
| `wobble` | `lfo` | `wobble` → `run`; `stop` → `stop` |
| `swell` | `env` | `swell` → `run` |
| `controls` | `controls` | `octave-down` → `down`, `octave-up` → `up`, `semitone-down` → `sdown`, `semitone-up` → `sup`, `next-template` → `next` |

### Switches and how they're pressed

| Recipe | band.js |
|---|---|
| `switch` 1–10 | input 0–9 |
| `left-button` / `right-button` | input 10 / 11 |
| `switch: null` | no input yet: the editor shows "press a switch" and uses Learn |
| `how.press` hold / press-on-press-off / once | device `gate` `hold` / `latch` / `oneshot` |
| `how.onTheBeat` | device `onBeat` |
| `how: null` | the device's default from `addDevice` |

`how` belongs to the **device** in band.js, not to each switch. All recipes
on one device that give a `how` must agree. If they don't, the validator
puts each one on its own device when there's room, or else asks. Jobs with no
press behaviour (`next-note`, `back-to-start`, `stop` and the controls)
ignore `how`. A `notes` device has no "on the beat", so `onTheBeat: true` on
one is reported, not silently dropped.

### Notes

| Recipe `note` | band.js |
|---|---|
| `{step: n}` | `noteType: 'scale'`, value `n` (scale step from the root) |
| `{midi: n}` | `noteType: 'fixed'`, value `n` |
| `{drum: …}` | `noteType: 'fixed'`, General MIDI: kick 36, snare 38, clap 39, closed-hat 42, low-tom 45, open-hat 46, crash 49, high-tom 50, ride 51, cowbell 56 |

One `notes` device has one `noteType`. A request that mixes scale steps with
MIDI notes or drums on one device is split into two devices.

### Settings

Words map to numbers as follows. Each mapping is a starting point to tune in
practice.

| Setting | Applies to | band.js |
|---|---|---|
| `playback` one-note-per-press / by-itself | sequencer | sequence `mode` `press` / `clock` |
| `tune` (steps, `null` = rest) | sequencer | sequence `notes`, `noteType: 'scale'` |
| `tune` ode-to-joy / twinkle-twinkle | sequencer | the note lists from the Tune stepper template |
| `beat` | sequencer | `noteType: 'fixed'`, notes as GM drums, `null` = rest |
| `euclid` | sequencer | `rhythm: {steps, hits, rotation}` (rotation defaults to 0) |
| `chord` I / ii / iii / IV / V / vi | arpeggiator | `notes` [0,2,4] / [1,3,5] / [2,4,6] / [3,5,7] / [4,6,8] / [5,7,9] |
| `pattern` up / down / up-down / random / as-written | arpeggiator | `order` `up` / `down` / `updown` / `random` / `written` |
| `octaves` | arpeggiator | `octaves` |
| `speed` slow / medium / fast | sequencer, arpeggiator | `division` 12 / 6 / 3 (clock ticks per step; 24 per beat) |
| `speed` slow / medium / fast | wobble | `synced: true`, `rate` 192 / 96 / 24 (ticks per cycle: two bars, one bar, one beat) |
| `changes` brightness / vibrato / volume / pitch / pressure | wobble, swell | `output: 'cc'`, `cc` 74 / 1 / 7; `output: 'bend'`; `output: 'pressure'` |
| `shape` smooth / triangle / ramp / on-off / random | wobble | `wave` `sine` / `triangle` / `saw` / `square` / `random` |
| `rise` slow / medium / fast | swell | `attack` 1500 / 500 / 60 ms |
| `fall` slow / medium / fast | swell | `release` (or `decay` when not held) 1500 / 800 / 120 ms |
| `staysWhileHeld` true / false | swell | `sustain` 100 / 0 (false makes it rise and fall once) |
| `onEveryNoteOf` (device id) | swell | `follow` = that device's sequence id |
| `onMusician` (name) | wobble, swell | device `target` = that musician's channel |

The `from` and `to` range for each `changes` value uses the editor's defaults
(brightness 20–110, swell 10–127) until people ask for "a little" or "a lot".
A depth setting can come later.

### Band

| Recipe | band.js |
|---|---|
| `tempoBpm` | `tempo` × 10 |
| `key.root` C … B | `root` 0–11 |
| `key.scale` major / minor / major-pentatonic / minor-pentatonic / dorian | `mask` 0x0AB5 / 0x05AD / 0x0295 / 0x04A9 / 0x06AD |

## Validation beyond the schema

JSON Schema checks the shape. `recipe.js` also checks the meaning, and turns
every problem into a **question** shown to the person, never a silent fix:

- Each recipe's `device` names an entry in `devices`, and each device's `who`
  is in `musicians` or already in the band.
- The `job` belongs to the device's kind, and to its playback (`next-note`
  only for one-note-per-press, `play` only for by-itself).
- `note` is given for `play-note` and only for it.
- Settings apply to the device's kind (for example, `chord` only on an
  arpeggiator).
- `onMusician` names a musician in the request or the band. `onEveryNoteOf`
  names a sequencer or arpeggiator.
- **Room on the board:** at most 4 sequencers plus arpeggiators, 4 wobbles
  plus swells, and 10 musicians in a band.
- **One job per switch:** a switch used twice in the request is a question.
  Taking a switch away from an existing recipe in the band is shown as a
  change ("switch 3 will stop playing Sam's kick").
- A wobble or swell on a musician who plays nothing pitched changes nothing
  audible, so the validator asks whose sound it should change (see the Lena
  example).

## Showing a recipe as a sentence

Each recipe is rendered with the chip colours from the cards:

| Slot | From | Example |
|---|---|---|
| ● who | `device.who` | Sam |
| ▲ how | `how.press`: hold → "holds"; press-on-press-off → "presses (and again to stop)"; once or null → "presses"; plus "on the beat" | holds |
| ■ switch | "switch 3", "the V1 button", or a blinking "press a switch" chip when null | switch 3 |
| ◆ device | kind name, plus "on Ana" for `onMusician` | swell on Keys |
| job | the job in plain words, with the note or drum for `play-note` | rise and fall |

Every chip can be tapped to change it, so the language box is only another
way in. Switch-scanning and screen-reader users keep the direct route.

## Producing recipes with a language model

- **Give the model:** this schema; the jobs-per-kind table above; the
  current band's musicians and device ids (so "make Ana's tune wobbly" can
  find them); and the examples file as worked examples.
- **Constrain the output to the schema.** With the Claude API, use structured
  outputs (`output_config.format` with a JSON schema). With a model in the
  browser, use JSON-schema-constrained decoding. Constrained decoders often
  support only part of JSON Schema: some may ignore `pattern`, `minimum` or
  `maximum`. Check what each one supports, and always re-validate the
  output against the full schema and the rules above.
- **Instruct the model to leave a slot `null` and ask** rather than guess,
  and to put anything it can't express in `unmapped` rather than force it into
  a near miss. Switch colours ("the red switch") aren't known to the editor, so
  they become `switch: null` and Learn.
- **Ask questions in the request's language.** The schema itself is
  language-neutral.
- **Privacy:** use first names or initials in requests. With a cloud model,
  request text leaves the device.

## Test set

`recipe-examples.json` pairs requests with the result they should produce.
Grow it from the Cologne recipe sheets, the wish pile and the SEN sessions,
including German. Score each candidate (a parser, a browser model, Claude) by
slot accuracy: did each recipe get the right device kind, job, switch, how
and note, and did it ask or leave things out where it should have?

## Open questions

- **Drums and pitched notes for one musician.** Channel 10 for drums would
  move their pitched notes too. Options: ask, split them into two musicians
  ("Ana" and "Ana's drums"), or let a device override its musician's channel.
- **Changing and removing.** v1 only adds or updates. "Take away Sam's
  wobble" and "swap switches 2 and 3" need edit operations: a `changes` list
  alongside `recipes`.
- **Depth.** "A little brighter" versus "much brighter" needs a `depth` word
  on wobble and swell, mapped to `from` and `to`.
- **Tempo and key per template.** The band has one tempo and key. Requests
  like "make the chorus faster" need sections or templates in the recipe
  model.
