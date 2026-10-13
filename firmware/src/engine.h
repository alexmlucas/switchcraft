// Rule engine: runs the working table (spec B.4-B.6).
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "table.h"

// Switches to a new table: silences everything, resets runtime state
// (transpose, scale, sequences) and fires LOAD rules.
void engine_load(const table_t *t);

const globals_t *engine_globals(void);

void engine_input(uint8_t input, bool pressed, uint64_t now_us);
void engine_analog(uint8_t analog, uint8_t value);

// Call often: runs the internal clock, hold detection and note timing.
void engine_task(uint64_t now_us);

// Note-offs for everything sounding, stops sequences, CC 123 on all channels.
void engine_all_notes_off(void);
