#include "config.h"

#include <string.h>

#include "crc32.h"
#include "engine.h"
#include "protocol.h"
#include "slots.h"

static uint8_t working[TABLE_MAX_LEN];
static uint16_t working_len;
static uint32_t working_crc;
static table_t live_table;
static table_t scratch;  // validation target; its pointers are never used
static uint8_t active_slot;
static board_settings_t settings;

const board_settings_t *config_settings(void) {
    return &settings;
}

int config_set_calibration(const uint16_t min[2], const uint16_t max[2], bool save) {
    for (int i = 0; i < 2; i++)
        if (min[i] > 4095 || max[i] > 4095 || min[i] == max[i])
            return STATUS_ERR_RANGE;
    for (int i = 0; i < 2; i++) {
        settings.analog_min[i] = min[i];
        settings.analog_max[i] = max[i];
    }
    return save ? board_settings_write(&settings) : STATUS_OK;
}

const uint8_t *config_blob(uint16_t *len, uint32_t *crc) {
    *len = working_len;
    *crc = working_crc;
    return working;
}

uint8_t config_active_slot(void) {
    return active_slot;
}

int config_apply(const uint8_t *blob, uint16_t len, table_error_t *err, bool live) {
    if (!table_load(blob, len, &scratch, err))
        return STATUS_ERR_INVALID;
    memmove(working, blob, len);
    working_len = len;
    working_crc = crc32(working, len);
    table_load(working, working_len, &live_table, NULL);
    engine_load(&live_table, live);
    return STATUS_OK;
}

int config_load_slot(uint8_t slot) {
    const uint8_t *blob;
    uint16_t len;
    if (slot >= NUM_SLOTS)
        return STATUS_ERR_RANGE;
    if (!slot_read(slot, &blob, &len, NULL))
        return STATUS_ERR_SLOT_EMPTY;
    // A slot that passes its CRC but fails validation (e.g. written by newer
    // firmware) counts as empty.
    if (config_apply(blob, len, NULL, false) != STATUS_OK)
        return STATUS_ERR_SLOT_EMPTY;
    active_slot = slot;
    if (settings.boot_slot != slot) {
        settings.boot_slot = slot;
        return board_settings_write(&settings);
    }
    return STATUS_OK;
}

int config_save_slot(uint8_t slot) {
    return slot_write(slot, working, working_len);
}

void config_init(void) {
    board_settings_read(&settings);
    uint8_t boot = settings.boot_slot;
    active_slot = boot;
    const uint8_t *blob;
    uint16_t len;
    for (int i = 0; i < NUM_SLOTS; i++) {
        uint8_t s = (uint8_t)((boot + i) % NUM_SLOTS);
        if (slot_read(s, &blob, &len, NULL) && config_apply(blob, len, NULL, false) == STATUS_OK) {
            active_slot = s;
            return;
        }
    }
    len = table_build_default(working);
    config_apply(working, len, NULL, false);
}
