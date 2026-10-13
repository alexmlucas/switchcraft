#include "midi.h"

#include "pico/time.h"
#include "engine.h"
#include "protocol.h"
#include "tusb.h"

// Raw USB-MIDI packets are used in both directions: TinyUSB's stream read
// ignores the cable number, and its stream writer keeps one SysEx state per
// interface, which would mix the two cables.

static void write_packet(uint8_t cable, uint8_t cin, uint8_t b0, uint8_t b1, uint8_t b2) {
    if (!tud_midi_mounted())
        return;
    const uint8_t packet[4] = {(uint8_t)((cable << 4) | cin), b0, b1, b2};
    absolute_time_t deadline = make_timeout_time_ms(20);
    while (!tud_midi_packet_write(packet)) {
        // FIFO full: let TinyUSB send, but don't hang if the host stops reading.
        tud_task();
        if (time_reached(deadline))
            return;
    }
}

static void send_channel_msg(uint8_t status, uint8_t d1, uint8_t d2) {
    write_packet(CABLE_MUSIC, status >> 4, status, d1, d2);
    write_packet(CABLE_CONFIG, status >> 4, status, d1, d2);
}

void midi_note_on(uint8_t ch, uint8_t note, uint8_t vel) {
    send_channel_msg(0x90 | (ch & 0x0F), note & 0x7F, vel & 0x7F);
}

void midi_note_off(uint8_t ch, uint8_t note) {
    send_channel_msg(0x80 | (ch & 0x0F), note & 0x7F, 0);
}

void midi_cc(uint8_t ch, uint8_t cc, uint8_t value) {
    send_channel_msg(0xB0 | (ch & 0x0F), cc & 0x7F, value & 0x7F);
}

void midi_pitch_bend(uint8_t ch, uint16_t value) {
    send_channel_msg(0xE0 | (ch & 0x0F), value & 0x7F, (value >> 7) & 0x7F);
}

void midi_channel_pressure(uint8_t ch, uint8_t value) {
    send_channel_msg(0xD0 | (ch & 0x0F), value & 0x7F, 0);
}

void midi_send_sysex(uint8_t cable, const uint8_t *msg, size_t len) {
    size_t i = 0;
    while (i < len) {
        size_t n = len - i;
        if (n > 3) {
            write_packet(cable, MIDI_CIN_SYSEX_START, msg[i], msg[i + 1], msg[i + 2]);
            i += 3;
        } else {
            // Last 1-3 bytes, ending with F7: CIN 5, 6 or 7.
            write_packet(cable, (uint8_t)(MIDI_CIN_SYSEX_END_1BYTE + n - 1), msg[i],
                         n > 1 ? msg[i + 1] : 0, n > 2 ? msg[i + 2] : 0);
            i += n;
        }
    }
}

void midi_poll(void) {
    uint8_t p[4];
    while (tud_midi_available() && tud_midi_packet_read(p)) {
        uint8_t cable = p[0] >> 4;
        uint8_t cin = p[0] & 0x0F;
        if (cable == CABLE_MUSIC) {
            // MIDI clock from a DAW (spec B.11). Realtime bytes come as CIN 0xF
            // (some hosts use the 1-byte system CIN 5).
            if ((cin == 0x0F || cin == MIDI_CIN_SYSEX_END_1BYTE) && p[1] >= 0xF8)
                engine_clock(p[1], time_us_64());
            continue;
        }
        if (cable != CABLE_CONFIG)
            continue;
        int n;
        switch (cin) {
        case MIDI_CIN_SYSEX_START:
        case MIDI_CIN_SYSEX_END_3BYTE:
            n = 3;
            break;
        case MIDI_CIN_SYSEX_END_2BYTE:
            n = 2;
            break;
        case MIDI_CIN_SYSEX_END_1BYTE:
            n = 1;
            break;
        default:
            continue;
        }
        for (int i = 0; i < n; i++)
            protocol_rx_byte(p[1 + i]);
    }
}
