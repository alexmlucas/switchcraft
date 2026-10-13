#include "slots.h"

#include <string.h>

#include "crc32.h"
#include "hardware/flash.h"
#include "pico/flash.h"
#include "protocol.h"
#include "table.h"

#define SLOT_MAGIC 0x31464353u  // "SCF1"
#define BOOT_MAGIC 0x42435353u  // "SSCB"
#define SLOT_HEADER_LEN 16

#define BOOT_OFFSET (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE)
#define SLOT_OFFSET(n) (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE * (9u - (n)))

_Static_assert(SLOT_HEADER_LEN + TABLE_MAX_LEN == FLASH_SECTOR_SIZE, "slot size");

static uint8_t sector_buf[FLASH_SECTOR_SIZE];

static const uint8_t *flash_ptr(uint32_t offset) {
    return (const uint8_t *)(XIP_BASE + offset);
}

typedef struct {
    uint32_t offset;
    uint32_t program_len;  // 0 = erase only
} flash_job_t;

static void do_flash_job(void *param) {
    const flash_job_t *job = param;
    flash_range_erase(job->offset, FLASH_SECTOR_SIZE);
    if (job->program_len)
        flash_range_program(job->offset, sector_buf, job->program_len);
}

// Erases the sector and programs the first `len` bytes of sector_buf.
static int flash_write_sector(uint32_t offset, uint32_t len) {
    flash_job_t job = {
        .offset = offset,
        .program_len = (len + FLASH_PAGE_SIZE - 1) & ~(uint32_t)(FLASH_PAGE_SIZE - 1),
    };
    if (job.program_len)
        memset(sector_buf + len, 0xFF, job.program_len - len);
    if (flash_safe_execute(do_flash_job, &job, 100) != PICO_OK)
        return STATUS_ERR_FLASH;
    if (job.program_len && memcmp(flash_ptr(offset), sector_buf, job.program_len) != 0)
        return STATUS_ERR_FLASH;
    return STATUS_OK;
}

bool slot_read(uint8_t slot, const uint8_t **blob, uint16_t *len, uint32_t *crc) {
    if (slot >= NUM_SLOTS)
        return false;
    const uint8_t *p = flash_ptr(SLOT_OFFSET(slot));
    uint16_t l = rd16(p + 6);
    if (rd32(p) != SLOT_MAGIC || rd16(p + 4) != TABLE_FORMAT_VERSION || l < TABLE_HEADER_LEN ||
        l > TABLE_MAX_LEN)
        return false;
    uint32_t c = rd32(p + 8);
    if (crc32(p + SLOT_HEADER_LEN, l) != c)
        return false;
    *blob = p + SLOT_HEADER_LEN;
    *len = l;
    if (crc)
        *crc = c;
    return true;
}

int slot_write(uint8_t slot, const uint8_t *blob, uint16_t len) {
    if (slot >= NUM_SLOTS || len > TABLE_MAX_LEN)
        return STATUS_ERR_RANGE;
    wr32(sector_buf, SLOT_MAGIC);
    wr16(sector_buf + 4, TABLE_FORMAT_VERSION);
    wr16(sector_buf + 6, len);
    wr32(sector_buf + 8, crc32(blob, len));
    wr32(sector_buf + 12, 0);
    memcpy(sector_buf + SLOT_HEADER_LEN, blob, len);
    return flash_write_sector(SLOT_OFFSET(slot), SLOT_HEADER_LEN + len);
}

int slot_erase(uint8_t slot) {
    if (slot >= NUM_SLOTS)
        return STATUS_ERR_RANGE;
    return flash_write_sector(SLOT_OFFSET(slot), 0);
}

uint8_t boot_slot_get(void) {
    const uint8_t *p = flash_ptr(BOOT_OFFSET);
    if (rd32(p) != BOOT_MAGIC || crc32(p, 8) != rd32(p + 8) || p[4] >= NUM_SLOTS)
        return 0;
    return p[4];
}

int boot_slot_set(uint8_t slot) {
    if (slot >= NUM_SLOTS)
        return STATUS_ERR_RANGE;
    memset(sector_buf, 0, 12);
    wr32(sector_buf, BOOT_MAGIC);
    sector_buf[4] = slot;
    wr32(sector_buf + 8, crc32(sector_buf, 8));
    return flash_write_sector(BOOT_OFFSET, 12);
}

bool slots_overlap_firmware(void) {
    extern char __flash_binary_end;
    return (uintptr_t)&__flash_binary_end > XIP_BASE + SLOT_OFFSET(0);
}
