// Config SysEx protocol. See docs/sysex-rule-table-spec.md, part A.
#pragma once

#include <stdint.h>

enum {
    STATUS_OK = 0x00,
    STATUS_ERR_UNKNOWN_CMD = 0x01,
    STATUS_ERR_BAD_LENGTH = 0x02,
    STATUS_ERR_TOO_LONG = 0x03,
    STATUS_ERR_VERSION = 0x04,
    STATUS_ERR_SEQUENCE = 0x05,
    STATUS_ERR_CRC = 0x06,
    STATUS_ERR_INVALID = 0x07,
    STATUS_ERR_RANGE = 0x08,
    STATUS_ERR_SLOT_EMPTY = 0x09,
    STATUS_ERR_FLASH = 0x0A,
    STATUS_ERR_BUSY = 0x0B,
};

enum { EVENT_PRESS = 1, EVENT_RELEASE = 2, EVENT_HOLD = 3, EVENT_TAP = 4 };

// Feeds one SysEx byte received on the config cable.
void protocol_rx_byte(uint8_t b);

// Unsolicited reports (spec A.7).
void protocol_report_input(uint8_t input, uint8_t event);
void protocol_report_analog(uint8_t analog, uint16_t raw, uint8_t scaled);
void protocol_report_slot(uint8_t slot);
void protocol_report_clock(uint8_t external, uint16_t tempo_tenths);
