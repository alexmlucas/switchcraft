// USB descriptors: one MIDI interface with two virtual cables.
//   Cable 0 = "Switchcraft"        music for a DAW
//   Cable 1 = "Switchcraft Config" config SysEx + copy of all musical output
//
// Windows caches descriptors per VID/PID/bcdDevice: bump USB_BCD_DEVICE on
// every change to anything in this file.

#include <string.h>

#include "pico/unique_id.h"
#include "tusb.h"

// Placeholder IDs (TinyUSB's test VID). Get a real PID (e.g. pid.codes)
// before boards are handed out.
#define USB_VID 0xCAFE
#define USB_PID 0x4D53
#define USB_BCD_DEVICE 0x0100

#define NUM_CABLES 2

enum { STR_LANG, STR_MANUFACTURER, STR_PRODUCT, STR_SERIAL, STR_CABLE_MUSIC, STR_CABLE_CONFIG };

static const tusb_desc_device_t desc_device = {
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
    .bcdUSB = 0x0200,
    .bDeviceClass = 0x00,
    .bDeviceSubClass = 0x00,
    .bDeviceProtocol = 0x00,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor = USB_VID,
    .idProduct = USB_PID,
    .bcdDevice = USB_BCD_DEVICE,
    .iManufacturer = STR_MANUFACTURER,
    .iProduct = STR_PRODUCT,
    .iSerialNumber = STR_SERIAL,
    .bNumConfigurations = 1,
};

const uint8_t *tud_descriptor_device_cb(void) {
    return (const uint8_t *)&desc_device;
}

#define EPNUM_MIDI_OUT 0x01
#define EPNUM_MIDI_IN 0x81

#define MIDI_DESC_LEN                                                          \
    (TUD_MIDI_DESC_HEAD_LEN + NUM_CABLES * TUD_MIDI_DESC_JACK_LEN +            \
     2 * TUD_MIDI_DESC_EP_LEN(NUM_CABLES))
#define CONFIG_TOTAL_LEN (TUD_CONFIG_DESC_LEN + MIDI_DESC_LEN)

static const uint8_t desc_configuration[] = {
    TUD_CONFIG_DESCRIPTOR(1, 2, 0, CONFIG_TOTAL_LEN, 0x00, 100),
    TUD_MIDI_DESC_HEAD(0, 0, NUM_CABLES),
    TUD_MIDI_DESC_JACK_DESC(1, STR_CABLE_MUSIC),
    TUD_MIDI_DESC_JACK_DESC(2, STR_CABLE_CONFIG),
    TUD_MIDI_DESC_EP(EPNUM_MIDI_OUT, 64, NUM_CABLES),
    TUD_MIDI_JACKID_IN_EMB(1),
    TUD_MIDI_JACKID_IN_EMB(2),
    TUD_MIDI_DESC_EP(EPNUM_MIDI_IN, 64, NUM_CABLES),
    TUD_MIDI_JACKID_OUT_EMB(1),
    TUD_MIDI_JACKID_OUT_EMB(2),
};

_Static_assert(sizeof(desc_configuration) == CONFIG_TOTAL_LEN, "descriptor length");

const uint8_t *tud_descriptor_configuration_cb(uint8_t index) {
    (void)index;
    return desc_configuration;
}

static const char *const strings[] = {
    [STR_MANUFACTURER] = "Switchcraft",
    [STR_PRODUCT] = "Switchcraft",
    [STR_CABLE_MUSIC] = "Switchcraft",
    [STR_CABLE_CONFIG] = "Switchcraft Config",
};

static uint16_t desc_str[32 + 1];

const uint16_t *tud_descriptor_string_cb(uint8_t index, uint16_t langid) {
    (void)langid;
    char serial[2 * PICO_UNIQUE_BOARD_ID_SIZE_BYTES + 1];
    const char *str;
    size_t len;

    if (index == STR_LANG) {
        desc_str[1] = 0x0409;
        len = 1;
    } else {
        if (index == STR_SERIAL) {
            pico_get_unique_board_id_string(serial, sizeof(serial));
            str = serial;
        } else if (index < sizeof(strings) / sizeof(strings[0]) && strings[index]) {
            str = strings[index];
        } else {
            return NULL;
        }
        len = strlen(str);
        if (len > 32)
            len = 32;
        for (size_t i = 0; i < len; i++)
            desc_str[1 + i] = (uint8_t)str[i];
    }
    desc_str[0] = (uint16_t)((TUSB_DESC_STRING << 8) | (2 * len + 2));
    return desc_str;
}
