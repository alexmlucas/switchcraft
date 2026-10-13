#include "table.h"

#include <string.h>

#include "board.h"

#define FAIL(off, why)                                                         \
    do {                                                                       \
        if (err) {                                                             \
            err->offset = (uint16_t)(off);                                     \
            err->reason = (why);                                               \
        }                                                                      \
        return false;                                                          \
    } while (0)

static bool valid_channel(uint8_t ch) {
    return ch < 16 || ch == CHANNEL_DEFAULT;
}

static bool valid_mask(uint16_t mask) {
    return (mask & 1) && mask <= 0x0FFF;
}

static bool load_globals(const uint8_t *p, uint16_t off, globals_t *g, table_error_t *err) {
    memcpy(g->name, p, 16);
    g->name[16] = 0;
    g->channel = p[16];
    g->velocity = p[17];
    g->scale_root = p[18];
    g->base_octave = p[19];
    g->scale_mask = rd16(p + 20);
    g->tempo = rd16(p + 22);
    g->debounce_ms = p[24];
    g->lockout_ms = rd16(p + 26);
    g->hold_ms = rd16(p + 28);
    // Bytes 30-39 are reserved (analog calibration before 0.3.0): ignored.
    if (g->channel > 15)
        FAIL(off + 16, INVALID_PARAM);
    if (g->velocity < 1 || g->velocity > 127)
        FAIL(off + 17, INVALID_PARAM);
    if (g->scale_root > 11)
        FAIL(off + 18, INVALID_PARAM);
    if (g->base_octave > 9)
        FAIL(off + 19, INVALID_PARAM);
    if (!valid_mask(g->scale_mask))
        FAIL(off + 20, INVALID_PARAM);
    if (g->tempo < 200 || g->tempo > 3000)  // 20-300 BPM
        FAIL(off + 22, INVALID_PARAM);
    return true;
}

static bool load_sequence(const uint8_t *p, uint16_t len, uint16_t off, table_t *t,
                          table_error_t *err) {
    if (len < SEQ_HEADER_LEN)
        FAIL(off, INVALID_SECTION_BOUNDS);
    uint8_t id = p[0];
    if (id >= MAX_SEQS || t->seqs[id].defined)
        FAIL(off, INVALID_SEQUENCE);
    seq_def_t *s = &t->seqs[id];
    s->advance = p[1];
    s->order = p[2];
    s->octaves = p[3];
    s->channel = p[4];
    s->velocity = p[5];
    s->division = p[6];
    s->gate = p[7];
    s->note_mode = p[8];
    s->step_count = rd16(p + 10);
    s->steps = p + SEQ_HEADER_LEN;
    if (s->advance > ADVANCE_CLOCK || s->order > ORDER_RANDOM || s->octaves < 1 ||
        s->octaves > 4 || !valid_channel(s->channel) || s->velocity > 127 ||
        s->division < 1 || s->gate > 100 || (s->advance == ADVANCE_CLOCK && s->gate < 1) ||
        s->note_mode > 1)
        FAIL(off, INVALID_PARAM);
    if (s->step_count < 1 || s->step_count > MAX_STEPS ||
        len != SEQ_HEADER_LEN + s->step_count * STEP_LEN)
        FAIL(off + 10, INVALID_SEQUENCE);
    for (int i = 0; i < s->step_count; i++) {
        const uint8_t *st = s->steps + i * STEP_LEN;
        if (!(st[2] & STEP_REST) && s->note_mode == 0 && st[0] > 127)
            FAIL(off + SEQ_HEADER_LEN + i * STEP_LEN, INVALID_PARAM);
        if (st[1] > 127)
            FAIL(off + SEQ_HEADER_LEN + i * STEP_LEN + 1, INVALID_PARAM);
    }
    s->defined = true;
    return true;
}

static bool seq_ref_ok(const table_t *t, uint8_t id, bool allow_selected) {
    if (id == SEQ_SELECTED)
        return allow_selected;
    return id < MAX_SEQS && t->seqs[id].defined;
}

static bool check_rule(const table_t *t, const rule_t *r, uint16_t off, table_error_t *err) {
    switch (r->trig_type) {
    case TRIG_PRESS:
    case TRIG_RELEASE:
    case TRIG_HOLD:
    case TRIG_TAP:
        if (r->trig_src >= NUM_INPUTS)
            FAIL(off + 1, INVALID_TRIGGER);
        break;
    case TRIG_CLOCK:
        if (r->trig_src != 0 || r->trig_arg < 1)
            FAIL(off + 1, INVALID_TRIGGER);
        break;
    case TRIG_LOAD:
        if (r->trig_src != 0)
            FAIL(off + 1, INVALID_TRIGGER);
        break;
    case TRIG_ANALOG:
        if (r->trig_src >= NUM_ANALOG)
            FAIL(off + 1, INVALID_TRIGGER);
        break;
    default:
        FAIL(off, INVALID_TRIGGER);
    }

    if ((r->flags & FLAGS_RESERVED) || (r->flags & GATE_MASK) > GATE_ONESHOT)
        FAIL(off + 5, INVALID_PARAM);

    switch (r->act_type) {
    case ACT_NONE:
        break;
    case ACT_NOTE:
        if (!valid_channel(r->p0) || r->p1 > 127)
            FAIL(off + 6, INVALID_PARAM);
        if (r->flags & FLAG_DEGREE) {
            int16_t deg = (int16_t)r->p2;
            if (deg < -127 || deg > 127)
                FAIL(off + 8, INVALID_PARAM);
        } else if (r->p2 > 127) {
            FAIL(off + 8, INVALID_PARAM);
        }
        break;
    case ACT_CC:
        if (!valid_channel(r->p0) || r->p1 > 119 || r->p2 > 127)
            FAIL(off + 6, INVALID_PARAM);
        break;
    case ACT_SEQ_STEP:
    case ACT_SEQ_RUN:
    case ACT_SEQ_STOP:
    case ACT_SEQ_RESET:
        if (!seq_ref_ok(t, r->p0, true))
            FAIL(off + 6, INVALID_SEQ_REF);
        break;
    case ACT_SEQ_SELECT:
        if (!seq_ref_ok(t, r->p0, false))
            FAIL(off + 6, INVALID_SEQ_REF);
        break;
    case ACT_TRANSPOSE: {
        int16_t semis = (int16_t)r->p2;
        if (r->p0 > 1 || semis < -48 || semis > 48)
            FAIL(off + 6, INVALID_PARAM);
        break;
    }
    case ACT_SET_SCALE:
        if ((r->p0 > 11 && r->p0 != 0xFF) || (r->p2 != 0 && !valid_mask(r->p2)))
            FAIL(off + 6, INVALID_PARAM);
        break;
    case ACT_PRESET:
        // LOAD -> PRESET could chain loads forever, writing flash each time.
        if (r->trig_type == TRIG_LOAD)
            FAIL(off + 4, INVALID_ACTION);
        if (r->p0 > 2 || (r->p0 == 0 && r->p1 >= 8))
            FAIL(off + 6, INVALID_PARAM);
        break;
    default:
        FAIL(off + 4, INVALID_ACTION);
    }
    return true;
}

bool table_load(const uint8_t *blob, uint16_t len, table_t *out, table_error_t *err) {
    memset(out, 0, sizeof(*out));
    if (len < TABLE_HEADER_LEN || len > TABLE_MAX_LEN)
        FAIL(0, INVALID_HEADER);
    if (rd16(blob) != TABLE_FORMAT_VERSION)
        FAIL(0, INVALID_HEADER);
    if (rd16(blob + 2) != len)
        FAIL(2, INVALID_HEADER);

    // Pass 1: walk sections, load globals and sequences, find the rules.
    uint8_t sections = blob[4];
    uint16_t off = TABLE_HEADER_LEN;
    const uint8_t *rules = NULL;
    uint16_t rules_len = 0, rules_off = 0;
    bool have_globals = false;
    for (int i = 0; i < sections; i++) {
        if (off + 4 > len)
            FAIL(off, INVALID_SECTION_BOUNDS);
        uint8_t id = blob[off];
        uint16_t slen = rd16(blob + off + 2);
        uint16_t body = off + 4;
        if (body + slen > len)
            FAIL(off, INVALID_SECTION_BOUNDS);
        switch (id) {
        case SECTION_GLOBALS:
            if (have_globals)
                FAIL(off, INVALID_REQUIRED_SECTION);
            if (slen != GLOBALS_LEN)
                FAIL(off, INVALID_SECTION_BOUNDS);
            if (!load_globals(blob + body, body, &out->g, err))
                return false;
            have_globals = true;
            break;
        case SECTION_RULES:
            if (rules)
                FAIL(off, INVALID_REQUIRED_SECTION);
            rules = blob + body;
            rules_len = slen;
            rules_off = body;
            break;
        case SECTION_SEQUENCE:
            if (!load_sequence(blob + body, slen, body, out, err))
                return false;
            break;
        default:
            if (id < 0x10)
                FAIL(off, INVALID_SECTION_ID);
            break;  // editor data etc.: skipped
        }
        off = body + slen;
    }
    if (off != len)
        FAIL(off, INVALID_SECTION_BOUNDS);
    if (!have_globals || !rules)
        FAIL(0, INVALID_REQUIRED_SECTION);

    // Pass 2: rules (they may refer to sequences).
    if (rules_len < 4)
        FAIL(rules_off, INVALID_SECTION_BOUNDS);
    uint8_t count = rules[0];
    if (count > MAX_RULES || rules_len != 4 + count * RULE_LEN)
        FAIL(rules_off, INVALID_SECTION_BOUNDS);
    for (int i = 0; i < count; i++) {
        const uint8_t *p = rules + 4 + i * RULE_LEN;
        rule_t *r = &out->rules[i];
        r->trig_type = p[0];
        r->trig_src = p[1];
        r->trig_arg = rd16(p + 2);
        r->act_type = p[4];
        r->flags = p[5];
        r->p0 = p[6];
        r->p1 = p[7];
        r->p2 = rd16(p + 8);
        r->p3 = rd16(p + 10);
        if (!check_rule(out, r, rules_off + 4 + i * RULE_LEN, err))
            return false;
    }
    out->rule_count = count;
    return true;
}

// --- Built-in default table ---

static uint8_t *put_rule(uint8_t *p, uint8_t trig, uint8_t src, uint8_t act, uint8_t flags,
                         uint8_t p0, uint8_t p1, uint16_t p2) {
    memset(p, 0, RULE_LEN);
    p[0] = trig;
    p[1] = src;
    p[4] = act;
    p[5] = flags;
    p[6] = p0;
    p[7] = p1;
    wr16(p + 8, p2);
    return p + RULE_LEN;
}

uint16_t table_build_default(uint8_t *buf) {
    uint8_t *p = buf + TABLE_HEADER_LEN;

    // GLOBALS
    p[0] = SECTION_GLOBALS;
    p[1] = 0;
    wr16(p + 2, GLOBALS_LEN);
    uint8_t *g = p + 4;
    memset(g, 0, GLOBALS_LEN);
    memcpy(g, "Scale player", 12);
    g[16] = 0;    // channel 1
    g[17] = 100;  // velocity
    g[18] = 0;    // C
    g[19] = 4;    // C4 = 60
    wr16(g + 20, 0x0AB5);  // major
    wr16(g + 22, 1200);    // 120.0 BPM
    g[24] = 10;            // debounce ms
    wr16(g + 26, 0);       // lockout
    wr16(g + 28, 500);     // hold ms
    p = g + GLOBALS_LEN;

    // RULES
    uint8_t *section = p;
    p[0] = SECTION_RULES;
    p[1] = 0;
    uint8_t *r = p + 4;
    uint8_t *rules = r;
    r[0] = 0;
    r[1] = r[2] = r[3] = 0;
    r += 4;
    uint8_t n = 0;
    for (uint8_t i = 0; i < 10; i++, n++)
        r = put_rule(r, TRIG_PRESS, i, ACT_NOTE, GATE_HOLD | FLAG_DEGREE, CHANNEL_DEFAULT, 0, i);
    r = put_rule(r, TRIG_PRESS, 10, ACT_TRANSPOSE, 0, 1, 0, (uint16_t)-12);
    r = put_rule(r, TRIG_PRESS, 11, ACT_TRANSPOSE, 0, 1, 0, 12);
    r = put_rule(r, TRIG_ANALOG, 0, ACT_CC, FLAG_VALUE_FROM_TRIGGER, CHANNEL_DEFAULT, 1, 0);
    r = put_rule(r, TRIG_ANALOG, 1, ACT_CC, FLAG_VALUE_FROM_TRIGGER, CHANNEL_DEFAULT, 74, 0);
    n += 4;
    rules[0] = n;
    wr16(section + 2, (uint16_t)(r - rules));
    p = r;

    uint16_t len = (uint16_t)(p - buf);
    memset(buf, 0, TABLE_HEADER_LEN);
    wr16(buf, TABLE_FORMAT_VERSION);
    wr16(buf + 2, len);
    buf[4] = 2;  // sections
    return len;
}
