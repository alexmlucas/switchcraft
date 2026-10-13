// Preset slots and boot state in the last nine 4 KB flash sectors (spec B.1).
#pragma once

#include <stdbool.h>
#include <stdint.h>

#define NUM_SLOTS 8

// Checks a slot's header and CRC. On success returns true and points `blob`
// at the table in flash (memory-mapped).
bool slot_read(uint8_t slot, const uint8_t **blob, uint16_t *len, uint32_t *crc);

// These return a protocol status code (STATUS_OK or STATUS_ERR_FLASH).
int slot_write(uint8_t slot, const uint8_t *blob, uint16_t len);
int slot_erase(uint8_t slot);

// Board settings (spec B.1, B.10): power-up slot and analog calibration.
typedef struct {
    uint8_t boot_slot;
    uint16_t analog_min[2];  // raw reading mapped to 0
    uint16_t analog_max[2];  // raw reading mapped to 127 (< min = inverted)
} board_settings_t;

// Default analog calibration: Logitech Adaptive Gaming Kit variable
// triggers, about 3850 at rest and 2250 fully pressed (inverted).
#define ANALOG_DEFAULT_REST 3750
#define ANALOG_DEFAULT_PRESSED 2350

// Reads the settings; a blank or corrupt sector gives slot 0 and the
// default calibration. Settings written by firmware before 0.3.0 keep
// their boot slot.
void board_settings_read(board_settings_t *s);
int board_settings_write(const board_settings_t *s);

// True if the firmware image overlaps the slot area.
bool slots_overlap_firmware(void);
