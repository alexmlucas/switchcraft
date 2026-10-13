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

// Slot to load at power-up (0 if the boot sector is blank or corrupt).
uint8_t boot_slot_get(void);
int boot_slot_set(uint8_t slot);

// True if the firmware image overlaps the slot area.
bool slots_overlap_firmware(void);
