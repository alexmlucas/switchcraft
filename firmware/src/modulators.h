// Modulators: LFOs and envelopes sent as CC, pitch bend or channel pressure
// (spec B.6.2). Driven by the engine.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "table.h"

// A new table. `live` (an edit) keeps running modulators going if the new
// table has them with the same type (spec A.4).
void mods_load(const table_t *t, bool live);

// MOD_RUN with a gate mode (GATE_HOLD needs an owner input). `tick` is the
// engine's clock, for synced LFOs.
void mods_run(uint8_t id, uint8_t gate_mode, uint8_t owner, uint32_t tick);
void mods_stop(uint8_t id);

// The input was released: stop or release modulators it was holding.
void mods_release_owned(uint8_t input);

// A note started or stopped in sequence `seq` (envelopes can follow one).
void mods_seq_note(int seq, bool on);

// Stops everything without sending (all notes off, preset change).
void mods_silence(void);

// Call often. `tick_pos` is the clock position in ticks, with a fraction.
void mods_task(uint64_t now_us, float tick_pos);
