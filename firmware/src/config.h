// The working table (the one running) and the active slot.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "slots.h"
#include "table.h"

// Loads the boot slot, or the first valid slot, or the built-in default.
void config_init(void);

const uint8_t *config_blob(uint16_t *len, uint32_t *crc);
uint8_t config_active_slot(void);

// Validates `blob`, makes it the working table and restarts the engine.
// Returns a protocol status; fills `err` on STATUS_ERR_INVALID.
int config_apply(const uint8_t *blob, uint16_t len, table_error_t *err);

// Board-wide analog calibration (spec B.10).
const board_settings_t *config_settings(void);
// Returns a protocol status. `save` also writes it to flash.
int config_set_calibration(const uint16_t min[2], const uint16_t max[2], bool save);

// SLOT_LOAD: apply the slot, make it active and the power-up slot.
int config_load_slot(uint8_t slot);
int config_save_slot(uint8_t slot);
