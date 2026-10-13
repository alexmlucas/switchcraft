#include "modulators.h"

#include <math.h>
#include <string.h>

#include "midi.h"

#define UPDATE_US 10000  // at most 100 output updates per second (spec B.6.2)
#define NO_OWNER 0xFF
#define TWO_PI 6.28318531f

enum { ENV_IDLE, ENV_ATTACK, ENV_DECAY, ENV_SUSTAIN, ENV_RELEASE };

typedef struct {
    bool active;        // LFO running, or envelope not idle
    bool stopping;      // LFO stopped: send the bottom value once, then idle
    uint8_t type;       // MOD_LFO / MOD_ENVELOPE when it became active
    uint8_t stage;      // envelope stage
    uint8_t gate_mode;  // GATE_HOLD / GATE_LATCH / GATE_ONESHOT
    uint8_t owner;      // input holding it (GATE_HOLD), or NO_OWNER
    float value;        // 0..1
    float phase;        // LFO, 0..1
    float start_tick;   // synced LFO: clock position when started
    uint32_t cycle;     // LFO cycles completed
    float random_value; // random wave: this cycle's value
    int32_t last_sent;  // last output value, -1 = none yet
} mod_rt_t;

static const table_t *tab;
static mod_rt_t mods[MAX_MODS];
static uint64_t last_us, next_update_us;
static uint32_t rng = 0x9E3779B9u;

static float random01(void) {
    rng ^= rng << 13;
    rng ^= rng >> 17;
    rng ^= rng << 5;
    return (float)(rng >> 8) * (1.0f / 16777216.0f);
}

static void reset(mod_rt_t *m) {
    memset(m, 0, sizeof(*m));
    m->owner = NO_OWNER;
    m->last_sent = -1;
}

void mods_load(const table_t *t, bool live) {
    // `t` may be the same struct as the old table (already overwritten), so
    // the runtime remembers each modulator's type itself.
    for (int i = 0; i < MAX_MODS; i++) {
        const mod_def_t *d = &t->mods[i];
        bool keep = live && mods[i].active && !mods[i].stopping && d->defined && d->type == mods[i].type;
        if (!keep)
            reset(&mods[i]);
    }
    tab = t;
}

void mods_silence(void) {
    for (int i = 0; i < MAX_MODS; i++)
        reset(&mods[i]);
}

static void lfo_stop(mod_rt_t *m) {
    if (m->active)
        m->stopping = true;  // the next update sends the bottom value
}

static void env_close(mod_rt_t *m) {
    if (m->active && m->stage != ENV_RELEASE)
        m->stage = ENV_RELEASE;
}

void mods_run(uint8_t id, uint8_t gate_mode, uint8_t owner, uint32_t tick) {
    if (!tab || id >= MAX_MODS || !tab->mods[id].defined)
        return;
    const mod_def_t *d = &tab->mods[id];
    mod_rt_t *m = &mods[id];
    if (d->type == MOD_LFO) {
        if (gate_mode == GATE_LATCH && m->active && !m->stopping) {
            lfo_stop(m);
            return;
        }
        m->active = true;
        m->stopping = false;
        m->phase = 0;
        m->cycle = 0;
        m->start_tick = (float)tick;
        m->random_value = random01();
    } else {
        bool open = m->active && m->stage != ENV_RELEASE;
        if (gate_mode == GATE_LATCH && open) {
            env_close(m);
            return;
        }
        m->active = true;
        m->stage = ENV_ATTACK;  // from the current value: retriggering doesn't jump
    }
    m->type = d->type;
    m->gate_mode = gate_mode;
    m->owner = owner;
}

void mods_stop(uint8_t id) {
    if (!tab || id >= MAX_MODS || !tab->mods[id].defined)
        return;
    mod_rt_t *m = &mods[id];
    if (tab->mods[id].type == MOD_LFO)
        lfo_stop(m);
    else
        env_close(m);
}

void mods_release_owned(uint8_t input) {
    for (uint8_t i = 0; i < MAX_MODS; i++)
        if (mods[i].active && mods[i].gate_mode == GATE_HOLD && mods[i].owner == input)
            mods_stop(i);
}

void mods_seq_note(int seq, bool on) {
    if (!tab)
        return;
    for (uint8_t i = 0; i < MAX_MODS; i++) {
        const mod_def_t *d = &tab->mods[i];
        if (!d->defined || d->type != MOD_ENVELOPE || d->follow != seq)
            continue;
        if (on)
            mods_run(i, GATE_HOLD, NO_OWNER, 0);  // closed by the note-off below
        else
            env_close(&mods[i]);
    }
}

static float wave(uint8_t w, float p, float random_value) {
    switch (w) {
    case WAVE_SINE:
        return 0.5f - 0.5f * cosf(TWO_PI * p);  // starts at the bottom
    case WAVE_TRIANGLE:
        return p < 0.5f ? 2 * p : 2 - 2 * p;
    case WAVE_SAW:
        return p;
    case WAVE_SQUARE:
        return p < 0.5f ? 1.0f : 0.0f;
    default:
        return random_value;
    }
}

static void update_lfo(const mod_def_t *d, mod_rt_t *m, float dt, float tick_pos) {
    float pos;
    if (d->flags & MOD_SYNCED) {
        pos = (tick_pos - m->start_tick) / d->rate;
        if (pos < 0)
            pos = 0;
    } else {
        pos = m->cycle + m->phase + dt * d->rate / 100.0f;
    }
    uint32_t cycle = (uint32_t)pos;
    if (cycle != m->cycle) {
        m->cycle = cycle;
        m->random_value = random01();
        if (m->gate_mode == GATE_ONESHOT) {  // one cycle only
            lfo_stop(m);
            return;
        }
    }
    m->phase = pos - (float)cycle;
    m->value = wave(d->wave, m->phase, m->random_value);
}

static void update_envelope(const mod_def_t *d, mod_rt_t *m, float dt) {
    float sustain = d->sustain / 100.0f;
    float ms = dt * 1000.0f;
    switch (m->stage) {
    case ENV_ATTACK:
        m->value = d->attack ? m->value + ms / d->attack : 1.0f;
        if (m->value >= 1.0f) {
            m->value = 1.0f;
            m->stage = ENV_DECAY;
        }
        break;
    case ENV_DECAY:
        m->value = d->decay ? m->value - ms / d->decay : sustain;
        if (m->value <= sustain) {
            m->value = sustain;
            // ONESHOT: attack and decay, then release (an AD envelope).
            m->stage = m->gate_mode == GATE_ONESHOT ? ENV_RELEASE : ENV_SUSTAIN;
        }
        break;
    case ENV_SUSTAIN:
        m->value = sustain;
        break;
    case ENV_RELEASE:
        m->value = d->release ? m->value - ms / d->release : 0.0f;
        if (m->value <= 0.0f) {
            m->value = 0.0f;
            m->stage = ENV_IDLE;
        }
        break;
    }
}

static void send(const mod_def_t *d, mod_rt_t *m) {
    float v = m->value;
    if (d->flags & MOD_EXPONENTIAL)
        v *= v;
    float out = d->from + (d->to - d->from) * v;  // 0..127
    uint8_t ch = d->channel == CHANNEL_DEFAULT ? tab->g.channel : d->channel;
    int32_t sent;
    if (d->output == MOD_OUT_BEND)
        sent = (int32_t)lroundf(out / 127.0f * 16383.0f);
    else
        sent = (int32_t)lroundf(out);
    if (sent == m->last_sent)
        return;  // only on change
    m->last_sent = sent;
    if (d->output == MOD_OUT_CC)
        midi_cc(ch, d->controller, (uint8_t)sent);
    else if (d->output == MOD_OUT_BEND)
        midi_pitch_bend(ch, (uint16_t)sent);
    else
        midi_channel_pressure(ch, (uint8_t)sent);
}

void mods_task(uint64_t now, float tick_pos) {
    if (!tab || now < next_update_us)
        return;
    float dt = last_us ? (float)(now - last_us) / 1e6f : 0;
    if (dt > 0.1f)
        dt = 0.1f;  // after a stall (flash write), don't jump
    last_us = now;
    next_update_us = now + UPDATE_US;

    for (int i = 0; i < MAX_MODS; i++) {
        const mod_def_t *d = &tab->mods[i];
        mod_rt_t *m = &mods[i];
        if (!m->active || !d->defined)
            continue;
        if (m->type == MOD_LFO) {
            if (m->stopping) {
                m->value = 0;
                send(d, m);
                m->active = m->stopping = false;
                continue;
            }
            update_lfo(d, m, dt, tick_pos);
            if (m->stopping)
                m->value = 0;  // ONESHOT ended this cycle
        } else {
            update_envelope(d, m, dt);
            if (m->stage == ENV_IDLE)
                m->active = false;
        }
        send(d, m);
        if (m->type == MOD_LFO && m->stopping)
            m->active = m->stopping = false;
    }
}
