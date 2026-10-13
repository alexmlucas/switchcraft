// Rule engine: runs the working table (spec B.4-B.6).
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "table.h"

// Switches to a new table: silences everything, resets runtime state
// (transpose, scale, sequences) and fires LOAD rules. `live` (an edit from
// the page) instead keeps playing clock-mode sequences and transpose, and
// doesn't fire LOAD rules (spec A.4).
void engine_load(const table_t *t, bool live);

const globals_t *engine_globals(void);

void engine_input(uint8_t input, bool pressed, uint64_t now_us);
void engine_analog(uint8_t analog, uint8_t value);

// A MIDI realtime message from the music port: clock 0xF8, start 0xFA,
// continue 0xFB, stop 0xFC (spec B.11).
void engine_clock(uint8_t msg, uint64_t now_us);

// Call often: runs the internal clock, hold detection and note timing.
void engine_task(uint64_t now_us);

// Note-offs for everything sounding, stops sequences, CC 123 on all channels.
void engine_all_notes_off(void);
