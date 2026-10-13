// Switchcraft firmware: access switches -> USB MIDI, configured over SysEx.
// Design: docs/config-interface-plan.md. Protocol and table format:
// docs/sysex-rule-table-spec.md.

#include "board.h"
#include "config.h"
#include "engine.h"
#include "hardware/gpio.h"
#include "inputs.h"
#include "midi.h"
#include "pico/stdlib.h"
#include "slots.h"
#include "tusb.h"

int main(void) {
    gpio_init(ONBOARD_LED_GPIO);
    gpio_set_dir(ONBOARD_LED_GPIO, GPIO_OUT);

    // Preset slots live at the end of flash; a firmware image that reaches
    // them would be overwritten by the first save. Blink fast and stop.
    if (slots_overlap_firmware()) {
        for (;;) {
            gpio_xor_mask(1u << ONBOARD_LED_GPIO);
            sleep_ms(100);
        }
    }

    inputs_init();
    config_init();

    const tusb_rhport_init_t usb_init = {.role = TUSB_ROLE_DEVICE, .speed = TUSB_SPEED_AUTO};
    tusb_init(BOARD_TUD_RHPORT, &usb_init);

    for (;;) {
        tud_task();
        midi_poll();
        uint64_t now = time_us_64();
        inputs_poll(now);
        engine_task(now);
        gpio_put(ONBOARD_LED_GPIO, tud_mounted());
    }
}
