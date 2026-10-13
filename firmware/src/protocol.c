#include "protocol.h"

#include <stdbool.h>
#include <string.h>

#include "board.h"
#include "config.h"
#include "crc32.h"
#include "engine.h"
#include "midi.h"
#include "pico/unique_id.h"
#include "slots.h"
#include "table.h"

#define PROTOCOL_VERSION 1
#define MAX_SYSEX 256
#define MAX_PAYLOAD 120
#define MAX_CHUNK 64
#define SOURCE_WORKING 0xFF

enum {
    CMD_IDENTIFY = 0x01,
    CMD_TABLE_INFO = 0x02,
    CMD_TABLE_READ = 0x03,
    CMD_WRITE_BEGIN = 0x04,
    CMD_WRITE_DATA = 0x05,
    CMD_WRITE_COMMIT = 0x06,
    CMD_SLOT_SAVE = 0x07,
    CMD_SLOT_LOAD = 0x08,
    CMD_SLOT_ERASE = 0x09,
    CMD_ALL_NOTES_OFF = 0x0A,
    REPLY_BIT = 0x40,
    REPORT_INPUT_EVENT = 0x60,
    REPORT_ANALOG_VALUE = 0x61,
    REPORT_SLOT_CHANGED = 0x62,
};

static const uint8_t HEADER[] = {0xF0, 0x7D, 0x53, 0x43};

// Incoming message assembly.
static uint8_t rx[MAX_SYSEX];
static uint16_t rx_len;
static bool rx_active;
static bool rx_overflow;

// Table write in progress.
static uint8_t staging[TABLE_MAX_LEN];
static bool write_active;
static uint16_t write_len;
static uint32_t write_crc;
static uint16_t write_next;

static void send(uint8_t cmd, uint8_t seq, const uint8_t *payload, uint16_t n) {
    uint8_t msg[MAX_SYSEX];
    uint16_t len = 0;
    memcpy(msg, HEADER, sizeof(HEADER));
    len = sizeof(HEADER);
    msg[len++] = PROTOCOL_VERSION;
    msg[len++] = cmd;
    msg[len++] = seq;
    for (uint16_t i = 0; i < n && len + 3 <= MAX_SYSEX; i++) {
        msg[len++] = payload[i] >> 4;
        msg[len++] = payload[i] & 0x0F;
    }
    msg[len++] = 0xF7;
    midi_send_sysex(CABLE_CONFIG, msg, len);
}

static void reply(uint8_t cmd, uint8_t seq, uint8_t status, const uint8_t *data, uint16_t n) {
    uint8_t payload[1 + MAX_PAYLOAD];
    payload[0] = status;
    if (n > MAX_PAYLOAD)
        n = MAX_PAYLOAD;
    if (n)
        memcpy(payload + 1, data, n);
    send(cmd | REPLY_BIT, seq, payload, (uint16_t)(1 + n));
}

static void reply_status(uint8_t cmd, uint8_t seq, uint8_t status) {
    reply(cmd, seq, status, NULL, 0);
}

static bool get_source(uint8_t source, const uint8_t **blob, uint16_t *len, uint32_t *crc,
                       uint8_t *status) {
    if (source == SOURCE_WORKING) {
        *blob = config_blob(len, crc);
        return true;
    }
    if (source >= NUM_SLOTS) {
        *status = STATUS_ERR_RANGE;
        return false;
    }
    if (!slot_read(source, blob, len, crc)) {
        *status = STATUS_ERR_SLOT_EMPTY;
        return false;
    }
    return true;
}

static void cmd_identify(uint8_t seq) {
    uint8_t d[23];
    pico_unique_board_id_t id;
    pico_get_unique_board_id(&id);
    d[0] = PROTOCOL_VERSION;
    d[1] = FW_VERSION_MAJOR;
    d[2] = FW_VERSION_MINOR;
    d[3] = FW_VERSION_PATCH;
    d[4] = HW_REVISION;
    memcpy(d + 5, id.id, 8);
    wr16(d + 13, TABLE_FORMAT_VERSION);
    d[15] = NUM_INPUTS;
    d[16] = NUM_ANALOG;
    d[17] = NUM_SLOTS;
    d[18] = config_active_slot();
    wr16(d + 19, TABLE_MAX_LEN);
    d[21] = MAX_RULES;
    d[22] = MAX_SEQS;
    reply(CMD_IDENTIFY, seq, STATUS_OK, d, sizeof(d));
}

static void cmd_table_info(uint8_t seq, const uint8_t *p, uint16_t n) {
    const uint8_t *blob;
    uint16_t len;
    uint32_t crc;
    uint8_t status;
    if (n != 1)
        return reply_status(CMD_TABLE_INFO, seq, STATUS_ERR_BAD_LENGTH);
    if (!get_source(p[0], &blob, &len, &crc, &status))
        return reply_status(CMD_TABLE_INFO, seq, status);
    uint8_t d[8];
    wr16(d, len);
    wr32(d + 2, crc);
    wr16(d + 6, rd16(blob));
    reply(CMD_TABLE_INFO, seq, STATUS_OK, d, sizeof(d));
}

static void cmd_table_read(uint8_t seq, const uint8_t *p, uint16_t n) {
    const uint8_t *blob;
    uint16_t len;
    uint32_t crc;
    uint8_t status;
    if (n != 4)
        return reply_status(CMD_TABLE_READ, seq, STATUS_ERR_BAD_LENGTH);
    if (!get_source(p[0], &blob, &len, &crc, &status))
        return reply_status(CMD_TABLE_READ, seq, status);
    uint16_t off = rd16(p + 1);
    uint8_t count = p[3];
    if (count < 1 || count > MAX_CHUNK || off + count > len)
        return reply_status(CMD_TABLE_READ, seq, STATUS_ERR_RANGE);
    uint8_t d[2 + MAX_CHUNK];
    wr16(d, off);
    memcpy(d + 2, blob + off, count);
    reply(CMD_TABLE_READ, seq, STATUS_OK, d, (uint16_t)(2 + count));
}

static void cmd_write_begin(uint8_t seq, const uint8_t *p, uint16_t n) {
    if (n != 6)
        return reply_status(CMD_WRITE_BEGIN, seq, STATUS_ERR_BAD_LENGTH);
    uint16_t len = rd16(p);
    write_active = false;
    if (len < TABLE_HEADER_LEN || len > TABLE_MAX_LEN)
        return reply_status(CMD_WRITE_BEGIN, seq, STATUS_ERR_RANGE);
    write_active = true;
    write_len = len;
    write_crc = rd32(p + 2);
    write_next = 0;
    reply_status(CMD_WRITE_BEGIN, seq, STATUS_OK);
}

static void cmd_write_data(uint8_t seq, const uint8_t *p, uint16_t n) {
    if (n < 3 || n > 2 + MAX_CHUNK)
        return reply_status(CMD_WRITE_DATA, seq, STATUS_ERR_BAD_LENGTH);
    uint16_t off = rd16(p);
    uint16_t count = (uint16_t)(n - 2);
    if (!write_active || off != write_next)
        return reply_status(CMD_WRITE_DATA, seq, STATUS_ERR_SEQUENCE);
    if (off + count > write_len)
        return reply_status(CMD_WRITE_DATA, seq, STATUS_ERR_RANGE);
    memcpy(staging + off, p + 2, count);
    write_next = (uint16_t)(off + count);
    uint8_t d[2];
    wr16(d, write_next);
    reply(CMD_WRITE_DATA, seq, STATUS_OK, d, 2);
}

static void cmd_write_commit(uint8_t seq, const uint8_t *p, uint16_t n) {
    if (n != 1)
        return reply_status(CMD_WRITE_COMMIT, seq, STATUS_ERR_BAD_LENGTH);
    uint8_t flags = p[0];
    if (flags & 0xFE)
        return reply_status(CMD_WRITE_COMMIT, seq, STATUS_ERR_RANGE);
    if (!write_active || write_next != write_len)
        return reply_status(CMD_WRITE_COMMIT, seq, STATUS_ERR_SEQUENCE);
    write_active = false;
    if (crc32(staging, write_len) != write_crc)
        return reply_status(CMD_WRITE_COMMIT, seq, STATUS_ERR_CRC);
    table_error_t err;
    int status = config_apply(staging, write_len, &err);
    if (status == STATUS_ERR_INVALID) {
        uint8_t d[3];
        wr16(d, err.offset);
        d[2] = err.reason;
        return reply(CMD_WRITE_COMMIT, seq, (uint8_t)status, d, 3);
    }
    if (status == STATUS_OK && (flags & 1))
        status = config_save_slot(config_active_slot());
    reply_status(CMD_WRITE_COMMIT, seq, (uint8_t)status);
}

static void cmd_slot(uint8_t cmd, uint8_t seq, const uint8_t *p, uint16_t n) {
    if (n != 1)
        return reply_status(cmd, seq, STATUS_ERR_BAD_LENGTH);
    uint8_t slot = p[0];
    if (slot >= NUM_SLOTS)
        return reply_status(cmd, seq, STATUS_ERR_RANGE);
    int status;
    if (cmd == CMD_SLOT_SAVE)
        status = config_save_slot(slot);
    else if (cmd == CMD_SLOT_LOAD)
        status = config_load_slot(slot);
    else
        status = slot_erase(slot);
    reply_status(cmd, seq, (uint8_t)status);
}

static void handle_message(void) {
    // rx holds F0 7D 53 43 ver cmd seq <nibbles> F7
    if (rx_len < 8 || memcmp(rx, HEADER, sizeof(HEADER)) != 0)
        return;
    uint8_t ver = rx[4], cmd = rx[5], seq = rx[6];
    if (cmd >= REPLY_BIT)
        return;  // replies and reports are device -> host only
    if (rx_overflow)
        return reply_status(cmd, seq, STATUS_ERR_TOO_LONG);
    if (ver != PROTOCOL_VERSION)
        return reply_status(cmd, seq, STATUS_ERR_VERSION);

    uint16_t nibbles = (uint16_t)(rx_len - 8);
    if (nibbles & 1)
        return reply_status(cmd, seq, STATUS_ERR_BAD_LENGTH);
    uint8_t payload[MAX_PAYLOAD];
    uint16_t n = nibbles / 2;
    for (uint16_t i = 0; i < n; i++) {
        uint8_t hi = rx[7 + 2 * i], lo = rx[8 + 2 * i];
        if (hi > 0x0F || lo > 0x0F)
            return reply_status(cmd, seq, STATUS_ERR_BAD_LENGTH);
        payload[i] = (uint8_t)((hi << 4) | lo);
    }

    switch (cmd) {
    case CMD_IDENTIFY:
        return cmd_identify(seq);
    case CMD_TABLE_INFO:
        return cmd_table_info(seq, payload, n);
    case CMD_TABLE_READ:
        return cmd_table_read(seq, payload, n);
    case CMD_WRITE_BEGIN:
        return cmd_write_begin(seq, payload, n);
    case CMD_WRITE_DATA:
        return cmd_write_data(seq, payload, n);
    case CMD_WRITE_COMMIT:
        return cmd_write_commit(seq, payload, n);
    case CMD_SLOT_SAVE:
    case CMD_SLOT_LOAD:
    case CMD_SLOT_ERASE:
        return cmd_slot(cmd, seq, payload, n);
    case CMD_ALL_NOTES_OFF:
        if (n != 0)
            return reply_status(cmd, seq, STATUS_ERR_BAD_LENGTH);
        engine_all_notes_off();
        return reply_status(cmd, seq, STATUS_OK);
    default:
        return reply_status(cmd, seq, STATUS_ERR_UNKNOWN_CMD);
    }
}

void protocol_rx_byte(uint8_t b) {
    if (b == 0xF0) {
        rx_active = true;
        rx_overflow = false;
        rx_len = 0;
    } else if (!rx_active) {
        return;
    } else if (b & 0x80 && b != 0xF7) {
        rx_active = false;  // a status byte other than F7 aborts the message
        return;
    }
    if (rx_len < MAX_SYSEX)
        rx[rx_len++] = b;
    else
        rx_overflow = true;
    if (b == 0xF7) {
        rx_active = false;
        if (rx_overflow) {
            // Keep the header so the error reply can echo cmd and seq.
            rx_len = 8;
        }
        handle_message();
    }
}

void protocol_report_input(uint8_t input, uint8_t event) {
    uint8_t d[2] = {input, event};
    send(REPORT_INPUT_EVENT, 0, d, 2);
}

void protocol_report_analog(uint8_t analog, uint16_t raw, uint8_t scaled) {
    uint8_t d[4];
    d[0] = analog;
    wr16(d + 1, raw);
    d[3] = scaled;
    send(REPORT_ANALOG_VALUE, 0, d, 4);
}

void protocol_report_slot(uint8_t slot) {
    send(REPORT_SLOT_CHANGED, 0, &slot, 1);
}
