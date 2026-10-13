#include "engine.h"

#include <string.h>

#include "board.h"
#include "config.h"
#include "midi.h"
#include "protocol.h"
#include "slots.h"

#define NO_OWNER 0xFF
#define MAX_VOICES 32
#define MAX_QUEUE 16
#define TICKS_PER_BEAT 24
#define MAX_ORDER (2 * MAX_STEPS * 4)  // up-down over 4 octaves
#define HOLD_SCAN_US 1000

// --- State ---

static const table_t *tab;
static const globals_t fallback_globals = {
    .debounce_ms = 10,
    .hold_ms = 500,
};

// Musical state changed at run time by rules; reset on every load.
static int16_t transpose;
static uint8_t root;
static uint16_t mask;
static uint8_t selected_seq;

static uint64_t now_us;
static uint32_t tick;
static uint64_t next_tick_us;
static uint32_t tick_us;
static uint64_t next_hold_scan;
static uint32_t rng = 0x12345678;

static bool pressed[NUM_INPUTS];
static uint64_t press_time[NUM_INPUTS];
static bool hold_reported[NUM_INPUTS];
static uint32_t hold_fired[MAX_RULES / 32];
static bool latched[MAX_RULES];

typedef struct {
    bool used;
    uint8_t ch, note;
    uint8_t owner;  // input whose release ends the note, or NO_OWNER
    uint8_t rule;
    uint64_t off_us;  // 0 = no timeout
} voice_t;
static voice_t voices[MAX_VOICES];

typedef struct {
    uint8_t rule, owner, value;
} queued_t;
static queued_t queue[MAX_QUEUE];  // QUANTIZE actions waiting for the beat
static int queue_len;

static int pending_preset_mode = -1;
static uint8_t pending_preset_slot;

typedef struct {
    bool running;
    bool finish;  // ONESHOT: stop at the next step time
    uint8_t gate_mode;
    uint8_t owner;
    uint16_t order[MAX_ORDER];  // (octave << 8) | step index
    uint16_t order_len;
    uint16_t pos;
    uint32_t next_tick;
    bool sounding;
    uint8_t snd_ch, snd_note;
    bool off_by_tick;
    uint32_t off_tick;
    uint64_t off_us;
    uint8_t step_owner;  // press mode, gate 0: input whose release ends the note
} seq_rt_t;
static seq_rt_t seqs[MAX_SEQS];

// --- Helpers ---

static uint32_t random32(void) {
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return rng;
}

static uint8_t clamp_note(int n) {
    return (uint8_t)(n < 0 ? 0 : n > 127 ? 127 : n);
}

static uint8_t resolve_ch(uint8_t ch) {
    return ch == CHANNEL_DEFAULT ? tab->g.channel : ch;
}

static uint8_t resolve_vel(uint8_t vel) {
    return vel ? vel : tab->g.velocity;
}

// Scale degree -> MIDI note, before transpose (spec B.5).
static int degree_to_note(int deg) {
    int semis[12], n = 0;
    for (int s = 0; s < 12; s++)
        if (mask & (1u << s))
            semis[n++] = s;
    int oct = deg >= 0 ? deg / n : -((-deg + n - 1) / n);
    int idx = deg - oct * n;
    return 12 * (tab->g.base_octave + 1) + root + 12 * oct + semis[idx];
}

static uint64_t beat_us(void) {
    return (uint64_t)tick_us * TICKS_PER_BEAT;
}

// --- Note output ---

// How many sources (voices, sequences) hold each note. A note-off is sent
// only when the last one lets go, so releasing one switch can't cut off the
// same pitch still held by a sequence or another switch.
static uint8_t note_refs[16][128];

static void note_on(uint8_t ch, uint8_t note, uint8_t vel) {
    // At most MAX_VOICES + MAX_SEQS holders, so the count can't overflow.
    if (note_refs[ch][note])
        midi_note_off(ch, note);  // already sounding: re-strike it
    note_refs[ch][note]++;
    midi_note_on(ch, note, vel);
}

static void note_off(uint8_t ch, uint8_t note) {
    if (note_refs[ch][note] && --note_refs[ch][note] == 0)
        midi_note_off(ch, note);
}

// --- Voices (notes from NOTE actions) ---

static void voice_off(voice_t *v) {
    note_off(v->ch, v->note);
    v->used = false;
}

static void voice_on(uint8_t ch, uint8_t note, uint8_t vel, uint8_t owner, uint8_t rule,
                     uint64_t off_us) {
    voice_t *slot = NULL;
    for (int i = 0; i < MAX_VOICES; i++) {
        voice_t *v = &voices[i];
        if (v->used && v->ch == ch && v->note == note)
            voice_off(v);  // retrigger
        if (!v->used && !slot)
            slot = v;
    }
    if (!slot) {
        slot = &voices[0];  // all busy: steal
        voice_off(slot);
    }
    note_on(ch, note, vel);
    *slot = (voice_t){true, ch, note, owner, rule, off_us};
}

// --- Sequences ---

static int step_pitch(const seq_def_t *d, uint16_t entry) {
    const uint8_t *st = d->steps + (entry & 0xFF) * STEP_LEN;
    int note = d->note_mode ? degree_to_note((int8_t)st[0]) : st[0];
    return note + 12 * (entry >> 8);
}

static void seq_build_order(int i) {
    const seq_def_t *d = &tab->seqs[i];
    seq_rt_t *s = &seqs[i];
    uint16_t n = 0;
    for (int oct = 0; oct < d->octaves; oct++)
        for (int st = 0; st < d->step_count; st++) {
            // Rests only make sense in written order.
            if (d->order != ORDER_WRITTEN && (d->steps[st * STEP_LEN + 2] & STEP_REST))
                continue;
            s->order[n++] = (uint16_t)((oct << 8) | st);
        }
    if (d->order == ORDER_UP || d->order == ORDER_DOWN || d->order == ORDER_UPDOWN) {
        for (int a = 1; a < n; a++) {  // insertion sort by pitch
            uint16_t e = s->order[a];
            int p = step_pitch(d, e), b = a - 1;
            while (b >= 0 && step_pitch(d, s->order[b]) > p) {
                s->order[b + 1] = s->order[b];
                b--;
            }
            s->order[b + 1] = e;
        }
        if (d->order == ORDER_DOWN)
            for (int a = 0, b = n - 1; a < b; a++, b--) {
                uint16_t t = s->order[a];
                s->order[a] = s->order[b];
                s->order[b] = t;
            }
        if (d->order == ORDER_UPDOWN)
            for (int a = n - 2; a >= 1; a--)
                s->order[n + (n - 2 - a)] = s->order[a];
        if (d->order == ORDER_UPDOWN && n > 2)
            n = (uint16_t)(2 * n - 2);
    }
    s->order_len = n;
    s->pos = 0;
}

static void seq_note_off(seq_rt_t *s) {
    if (s->sounding) {
        note_off(s->snd_ch, s->snd_note);
        s->sounding = false;
    }
}

static void seq_stop(int i) {
    seq_rt_t *s = &seqs[i];
    s->running = false;
    s->finish = false;
    seq_note_off(s);
}

static void seq_play_step(int i, uint8_t owner) {
    const seq_def_t *d = &tab->seqs[i];
    seq_rt_t *s = &seqs[i];
    if (!s->order_len)
        return;
    seq_note_off(s);

    uint16_t entry = d->order == ORDER_RANDOM ? s->order[random32() % s->order_len]
                                               : s->order[s->pos];
    if (++s->pos >= s->order_len) {
        s->pos = 0;
        if (s->running && s->gate_mode == GATE_ONESHOT)
            s->finish = true;
    }

    const uint8_t *st = d->steps + (entry & 0xFF) * STEP_LEN;
    uint32_t len = st[2] & STEP_LENGTH_MASK;
    if (!len)
        len = 1;
    uint32_t step_ticks = len * d->division;
    if (d->advance == ADVANCE_CLOCK)
        s->next_tick = tick + step_ticks;
    if (st[2] & STEP_REST)
        return;

    s->snd_ch = resolve_ch(d->channel);
    s->snd_note = clamp_note(step_pitch(d, entry) + transpose);
    uint8_t vel = st[1] ? st[1] : resolve_vel(d->velocity);
    note_on(s->snd_ch, s->snd_note, vel);
    s->sounding = true;
    s->off_by_tick = false;
    s->off_us = 0;
    s->step_owner = NO_OWNER;
    if (d->advance == ADVANCE_CLOCK) {
        uint32_t gate_ticks = step_ticks * d->gate / 100;
        s->off_by_tick = true;
        s->off_tick = tick + (gate_ticks ? gate_ticks : 1);
    } else if (d->gate) {
        s->off_us = now_us + beat_us() * d->gate / 100;
    } else {
        s->step_owner = owner;  // held until next step or release
    }
}

static void seq_start(int i, uint8_t gate_mode, uint8_t owner) {
    seq_rt_t *s = &seqs[i];
    seq_note_off(s);
    seq_build_order(i);
    s->running = true;
    s->finish = false;
    s->gate_mode = gate_mode;
    s->owner = owner;
    seq_play_step(i, owner);
}

static int seq_target(uint8_t p0) {
    uint8_t id = p0 == SEQ_SELECTED ? selected_seq : p0;
    return id < MAX_SEQS && tab->seqs[id].defined ? id : -1;
}

// --- Actions ---

static void do_action(uint8_t ri, uint8_t value, uint8_t owner, bool from_queue);

static void enqueue(uint8_t ri, uint8_t value, uint8_t owner) {
    if (queue_len < MAX_QUEUE)
        queue[queue_len++] = (queued_t){ri, owner, value};
}

static void run_queue(void) {
    int n = queue_len;
    queue_len = 0;
    for (int i = 0; i < n; i++)
        do_action(queue[i].rule, queue[i].value, queue[i].owner, true);
}

static void act_note(uint8_t ri, const rule_t *r, uint8_t owner) {
    uint8_t gate = r->flags & GATE_MASK;
    if (gate == GATE_HOLD && owner == NO_OWNER)
        gate = GATE_ONESHOT;
    if (gate == GATE_LATCH && latched[ri]) {
        for (int i = 0; i < MAX_VOICES; i++)
            if (voices[i].used && voices[i].rule == ri && voices[i].owner == NO_OWNER &&
                !voices[i].off_us)
                voice_off(&voices[i]);
        latched[ri] = false;
        return;
    }
    int note = (r->flags & FLAG_DEGREE) ? degree_to_note((int16_t)r->p2) : r->p2;
    uint8_t ch = resolve_ch(r->p0), n = clamp_note(note + transpose), vel = resolve_vel(r->p1);
    if (gate == GATE_LATCH) {
        latched[ri] = true;
        voice_on(ch, n, vel, NO_OWNER, ri, 0);
    } else if (gate == GATE_HOLD) {
        voice_on(ch, n, vel, owner, ri, 0);
    } else {
        uint32_t ms = r->p3 ? r->p3 : DEFAULT_ONESHOT_MS;
        voice_on(ch, n, vel, NO_OWNER, ri, now_us + (uint64_t)ms * 1000);
    }
}

static void act_seq_run(const rule_t *r, uint8_t owner) {
    int i = seq_target(r->p0);
    if (i < 0 || tab->seqs[i].advance != ADVANCE_CLOCK)
        return;  // press-mode sequences are played by SEQ_STEP
    uint8_t gate = r->flags & GATE_MASK;
    if (gate == GATE_HOLD && owner == NO_OWNER)
        gate = GATE_ONESHOT;
    if (gate == GATE_LATCH && seqs[i].running)
        seq_stop(i);
    else
        seq_start(i, gate, owner);
}

static void do_action(uint8_t ri, uint8_t value, uint8_t owner, bool from_queue) {
    const rule_t *r = &tab->rules[ri];
    if ((r->flags & FLAG_QUANTIZE) && !from_queue) {
        enqueue(ri, value, owner);
        return;
    }
    // A held note or sequence whose switch was released before the beat.
    if (from_queue && owner != NO_OWNER && !pressed[owner] &&
        (r->flags & GATE_MASK) == GATE_HOLD &&
        (r->act_type == ACT_NOTE || r->act_type == ACT_SEQ_RUN))
        return;

    int i;
    switch (r->act_type) {
    case ACT_NOTE:
        act_note(ri, r, owner);
        break;
    case ACT_CC:
        midi_cc(resolve_ch(r->p0), r->p1,
                (r->flags & FLAG_VALUE_FROM_TRIGGER) ? value : (uint8_t)r->p2);
        break;
    case ACT_SEQ_STEP:
        if ((i = seq_target(r->p0)) >= 0)
            seq_play_step(i, owner);
        break;
    case ACT_SEQ_RUN:
        act_seq_run(r, owner);
        break;
    case ACT_SEQ_STOP:
        if ((i = seq_target(r->p0)) >= 0)
            seq_stop(i);
        break;
    case ACT_SEQ_RESET:
        if ((i = seq_target(r->p0)) >= 0) {
            seqs[i].finish = false;
            seq_build_order(i);
        }
        break;
    case ACT_SEQ_SELECT:
        selected_seq = r->p0;
        break;
    case ACT_TRANSPOSE: {
        int t = (r->p0 == 0 ? 0 : transpose) + (int16_t)r->p2;
        transpose = (int16_t)(t < -48 ? -48 : t > 48 ? 48 : t);
        break;
    }
    case ACT_SET_SCALE:
        if (r->p0 != 0xFF)
            root = r->p0;
        if (r->p2)
            mask = r->p2;
        break;
    case ACT_PRESET:
        // Applied after the current event, since loading replaces the table.
        pending_preset_mode = r->p0;
        pending_preset_slot = r->p1;
        break;
    default:
        break;
    }
}

static void fire(uint8_t trig, uint8_t src, uint8_t value, uint8_t owner) {
    for (uint8_t i = 0; i < tab->rule_count; i++)
        if (tab->rules[i].trig_type == trig && tab->rules[i].trig_src == src)
            do_action(i, value, owner, false);
}

static uint64_t threshold_us(const rule_t *r) {
    return (uint64_t)(r->trig_arg ? r->trig_arg : tab->g.hold_ms) * 1000;
}

// --- Events ---

static void release_owned(uint8_t input) {
    for (int i = 0; i < MAX_VOICES; i++)
        if (voices[i].used && voices[i].owner == input)
            voice_off(&voices[i]);
    for (int i = 0; i < MAX_SEQS; i++) {
        seq_rt_t *s = &seqs[i];
        if (s->running && s->gate_mode == GATE_HOLD && s->owner == input)
            seq_stop(i);
        else if (s->sounding && s->step_owner == input)
            seq_note_off(s);
    }
}

void engine_input(uint8_t input, bool down, uint64_t now) {
    now_us = now;
    if (!tab || input >= NUM_INPUTS)
        return;
    if (down) {
        rng ^= (uint32_t)now;  // press timing seeds the random arpeggio order
        if (!rng)
            rng = 1;
        pressed[input] = true;
        press_time[input] = now;
        hold_reported[input] = false;
        for (int i = 0; i < tab->rule_count; i++)
            if (tab->rules[i].trig_type == TRIG_HOLD && tab->rules[i].trig_src == input)
                hold_fired[i / 32] &= ~(1u << (i % 32));
        protocol_report_input(input, EVENT_PRESS);
        fire(TRIG_PRESS, input, 0, input);
        return;
    }

    pressed[input] = false;
    uint64_t held = now - press_time[input];
    protocol_report_input(input, EVENT_RELEASE);
    if (held < (uint64_t)tab->g.hold_ms * 1000)
        protocol_report_input(input, EVENT_TAP);
    release_owned(input);
    for (uint8_t i = 0; i < tab->rule_count; i++) {
        const rule_t *r = &tab->rules[i];
        if (r->trig_type == TRIG_TAP && r->trig_src == input && held < threshold_us(r))
            do_action(i, 0, NO_OWNER, false);
    }
    fire(TRIG_RELEASE, input, 0, NO_OWNER);
}

void engine_analog(uint8_t analog, uint8_t value) {
    if (tab)
        fire(TRIG_ANALOG, analog, value, NO_OWNER);
}

static void scan_holds(void) {
    for (uint8_t in = 0; in < NUM_INPUTS; in++) {
        if (!pressed[in])
            continue;
        uint64_t held = now_us - press_time[in];
        if (!hold_reported[in] && held >= (uint64_t)tab->g.hold_ms * 1000) {
            hold_reported[in] = true;
            protocol_report_input(in, EVENT_HOLD);
        }
        for (uint8_t i = 0; i < tab->rule_count; i++) {
            const rule_t *r = &tab->rules[i];
            if (r->trig_type != TRIG_HOLD || r->trig_src != in ||
                (hold_fired[i / 32] & (1u << (i % 32))) || held < threshold_us(r))
                continue;
            hold_fired[i / 32] |= 1u << (i % 32);
            do_action(i, 0, in, false);
        }
    }
}

static void on_tick(void) {
    for (uint8_t i = 0; i < tab->rule_count; i++) {
        const rule_t *r = &tab->rules[i];
        if (r->trig_type == TRIG_CLOCK && tick % r->trig_arg == 0)
            do_action(i, 0, NO_OWNER, false);
    }
    if (tick % TICKS_PER_BEAT == 0)
        run_queue();
    for (int i = 0; i < MAX_SEQS; i++) {
        seq_rt_t *s = &seqs[i];
        if (s->sounding && s->off_by_tick && (int32_t)(tick - s->off_tick) >= 0)
            seq_note_off(s);
        if (s->running && tab->seqs[i].advance == ADVANCE_CLOCK &&
            (int32_t)(tick - s->next_tick) >= 0) {
            if (s->finish)
                seq_stop(i);
            else
                seq_play_step(i, s->owner);
        }
    }
}

static void apply_pending_preset(void) {
    int mode = pending_preset_mode;
    pending_preset_mode = -1;
    uint8_t active = config_active_slot();
    int slot = -1;
    if (mode == 0) {
        slot = pending_preset_slot;
    } else {
        int dir = mode == 1 ? 1 : NUM_SLOTS - 1;
        const uint8_t *blob;
        uint16_t len;
        for (int n = 1; n < NUM_SLOTS && slot < 0; n++) {
            int s = (active + dir * n) % NUM_SLOTS;
            if (slot_read((uint8_t)s, &blob, &len, NULL))
                slot = s;
        }
    }
    if (slot >= 0 && config_load_slot((uint8_t)slot) == STATUS_OK)
        protocol_report_slot((uint8_t)slot);
}

void engine_task(uint64_t now) {
    now_us = now;
    if (!tab)
        return;

    if (now >= next_hold_scan) {
        next_hold_scan = now + HOLD_SCAN_US;
        scan_holds();
    }

    if (now >= next_tick_us) {
        if (now - next_tick_us > 10ull * tick_us)
            next_tick_us = now;  // fell behind (e.g. flash write): skip ahead
        next_tick_us += tick_us;
        tick++;
        on_tick();
    }

    for (int i = 0; i < MAX_VOICES; i++)
        if (voices[i].used && voices[i].off_us && now >= voices[i].off_us)
            voice_off(&voices[i]);
    for (int i = 0; i < MAX_SEQS; i++)
        if (seqs[i].sounding && seqs[i].off_us && now >= seqs[i].off_us)
            seq_note_off(&seqs[i]);

    if (pending_preset_mode >= 0)
        apply_pending_preset();
}

// --- Loading ---

static void silence(void) {
    for (int i = 0; i < MAX_VOICES; i++)
        if (voices[i].used)
            voice_off(&voices[i]);
    for (int i = 0; i < MAX_SEQS; i++)
        seq_stop(i);
    memset(note_refs, 0, sizeof(note_refs));  // all released above; reset anyway
    memset(latched, 0, sizeof(latched));
    queue_len = 0;
}

void engine_all_notes_off(void) {
    silence();
    for (uint8_t ch = 0; ch < 16; ch++)
        midi_cc(ch, 123, 0);
}

void engine_load(const table_t *t) {
    silence();
    tab = t;
    transpose = 0;
    root = t->g.scale_root;
    mask = t->g.scale_mask;
    tick_us = 25000000u / t->g.tempo;  // tempo is tenths of BPM, 24 ticks per beat
    memset(hold_fired, 0, sizeof(hold_fired));
    pending_preset_mode = -1;
    selected_seq = 0;
    for (int i = MAX_SEQS - 1; i >= 0; i--) {
        memset(&seqs[i], 0, sizeof(seqs[i]));
        if (t->seqs[i].defined) {
            selected_seq = (uint8_t)i;
            seq_build_order(i);
        }
    }
    fire(TRIG_LOAD, 0, 0, NO_OWNER);
}

const globals_t *engine_globals(void) {
    return tab ? &tab->g : &fallback_globals;
}
