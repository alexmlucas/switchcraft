// USB MIDI I/O on the two virtual cables.
#pragma once

#include <stddef.h>
#include <stdint.h>

#define CABLE_MUSIC 0
#define CABLE_CONFIG 1

// Musical output goes to both cables (spec A.7).
void midi_note_on(uint8_t ch, uint8_t note, uint8_t vel);
void midi_note_off(uint8_t ch, uint8_t note);
void midi_cc(uint8_t ch, uint8_t cc, uint8_t value);
void midi_pitch_bend(uint8_t ch, uint16_t value);  // 0..16383, 8192 = centre
void midi_channel_pressure(uint8_t ch, uint8_t value);

// Sends a complete SysEx message (F0 ... F7) on one cable.
void midi_send_sysex(uint8_t cable, const uint8_t *msg, size_t len);

// Reads incoming packets and passes config SysEx bytes to the protocol.
void midi_poll(void);
