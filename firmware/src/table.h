// Rule-table blob format v1. See docs/sysex-rule-table-spec.md, part B.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define TABLE_FORMAT_VERSION 1
#define TABLE_MAX_LEN 4080
#define TABLE_HEADER_LEN 8
#define MAX_RULES 128
#define MAX_SEQS 4
#define MAX_STEPS 256

enum {
    SECTION_GLOBALS = 0x01,
    SECTION_RULES = 0x02,
    SECTION_SEQUENCE = 0x03,
};
#define GLOBALS_LEN 40
#define RULE_LEN 12
#define SEQ_HEADER_LEN 12
#define STEP_LEN 3

enum {
    TRIG_PRESS = 0x01,
    TRIG_RELEASE = 0x02,
    TRIG_HOLD = 0x03,
    TRIG_CLOCK = 0x04,
    TRIG_LOAD = 0x05,
    TRIG_ANALOG = 0x06,
    TRIG_TAP = 0x07,
};

enum {
    ACT_NONE = 0x00,
    ACT_NOTE = 0x01,
    ACT_CC = 0x02,
    ACT_SEQ_STEP = 0x10,
    ACT_SEQ_RUN = 0x11,
    ACT_SEQ_STOP = 0x12,
    ACT_SEQ_RESET = 0x13,
    ACT_SEQ_SELECT = 0x14,
    ACT_TRANSPOSE = 0x20,
    ACT_SET_SCALE = 0x21,
    ACT_PRESET = 0x30,
};

// action_flags
#define GATE_MASK 0x03
enum { GATE_HOLD = 0, GATE_LATCH = 1, GATE_ONESHOT = 2 };
#define FLAG_QUANTIZE 0x04
#define FLAG_VALUE_FROM_TRIGGER 0x08
#define FLAG_DEGREE 0x10
#define FLAGS_RESERVED 0xE0

#define DEFAULT_ONESHOT_MS 250

#define CHANNEL_DEFAULT 0xFF
#define SEQ_SELECTED 0xFF

enum { ADVANCE_PRESS = 0, ADVANCE_CLOCK = 1 };
enum { ORDER_WRITTEN, ORDER_UP, ORDER_DOWN, ORDER_UPDOWN, ORDER_RANDOM };
#define STEP_REST 0x80
#define STEP_LENGTH_MASK 0x7F

// Validation failure reasons (spec B.8).
enum {
    INVALID_HEADER = 0x01,
    INVALID_SECTION_BOUNDS = 0x02,
    INVALID_SECTION_ID = 0x03,
    INVALID_REQUIRED_SECTION = 0x04,
    INVALID_TRIGGER = 0x05,
    INVALID_ACTION = 0x06,
    INVALID_PARAM = 0x07,
    INVALID_SEQ_REF = 0x08,
    INVALID_SEQUENCE = 0x09,
};

typedef struct {
    char name[17];
    uint8_t channel;
    uint8_t velocity;
    uint8_t scale_root;
    uint8_t base_octave;
    uint16_t scale_mask;
    uint16_t tempo;  // tenths of BPM
    uint8_t debounce_ms;
    uint16_t lockout_ms;
    uint16_t hold_ms;
} globals_t;

typedef struct {
    uint8_t trig_type;
    uint8_t trig_src;
    uint16_t trig_arg;
    uint8_t act_type;
    uint8_t flags;
    uint8_t p0;
    uint8_t p1;
    uint16_t p2;
    uint16_t p3;
} rule_t;

typedef struct {
    bool defined;
    uint8_t advance;
    uint8_t order;
    uint8_t octaves;
    uint8_t channel;
    uint8_t velocity;
    uint8_t division;
    uint8_t gate;
    uint8_t note_mode;  // 0 = absolute, 1 = scale degree
    uint16_t step_count;
    const uint8_t *steps;  // points into the blob, STEP_LEN bytes each
} seq_def_t;

typedef struct {
    globals_t g;
    uint8_t rule_count;
    rule_t rules[MAX_RULES];
    seq_def_t seqs[MAX_SEQS];
} table_t;

typedef struct {
    uint16_t offset;
    uint8_t reason;
} table_error_t;

// Validates the blob and, if valid, fills `out` (which then points into
// `blob`, so the blob must outlive it). `err` may be NULL.
bool table_load(const uint8_t *blob, uint16_t len, table_t *out, table_error_t *err);

// Writes the built-in default table (spec B.9). Returns its length.
uint16_t table_build_default(uint8_t *buf);

static inline uint16_t rd16(const uint8_t *p) {
    return (uint16_t)(p[0] | (p[1] << 8));
}

static inline uint32_t rd32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static inline void wr16(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}

static inline void wr32(uint8_t *p, uint32_t v) {
    for (int i = 0; i < 4; i++)
        p[i] = (uint8_t)(v >> (8 * i));
}
