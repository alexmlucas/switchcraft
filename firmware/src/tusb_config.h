#pragma once

#define CFG_TUSB_OS           OPT_OS_PICO
#define CFG_TUD_ENABLED       1
#define BOARD_TUD_RHPORT      0
#define CFG_TUD_ENDPOINT0_SIZE 64

#define CFG_TUD_CDC    0
#define CFG_TUD_MSC    0
#define CFG_TUD_HID    0
#define CFG_TUD_VENDOR 0
#define CFG_TUD_MIDI   1

// Larger than the 64-byte endpoint so a whole SysEx reply (up to 256 bytes,
// 86 packets) can be queued without waiting.
#define CFG_TUD_MIDI_RX_BUFSIZE 512
#define CFG_TUD_MIDI_TX_BUFSIZE 512
