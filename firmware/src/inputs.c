#include "inputs.h"

#include <stdbool.h>

#include "board.h"
#include "engine.h"
#include "hardware/adc.h"
#include "hardware/gpio.h"
#include "hardware/pwm.h"
#include "protocol.h"

#define SCAN_INTERVAL_US 1000
#define ANALOG_INTERVAL_US 2000
#define ANALOG_REPORT_INTERVAL_US 20000  // at most 50 updates/s per input
#define LED_PWM_WRAP (127 * 127)

typedef struct {
    bool raw;
    bool stable;
    uint64_t raw_since;
    bool suppressed;  // press dropped by lockout; drop its release too
} switch_state_t;

typedef struct {
    int32_t smooth_x16;  // IIR-filtered reading, 4 fractional bits
    uint8_t scaled;
    uint64_t last_report;
} analog_state_t;

static switch_state_t sw[NUM_INPUTS];
static analog_state_t an[NUM_ANALOG];
static uint64_t next_scan, next_analog;
static uint64_t last_press[NUM_INPUTS];
static uint8_t analog_turn;

void inputs_init(void) {
    for (int i = 0; i < NUM_INPUTS; i++) {
        gpio_init(SWITCH_GPIO[i]);
        gpio_set_dir(SWITCH_GPIO[i], GPIO_IN);
        gpio_pull_down(SWITCH_GPIO[i]);
    }
    adc_init();
    for (int i = 0; i < NUM_ANALOG; i++) {
        adc_gpio_init(ANALOG_GPIO[i]);
        // The LEDs have 62 R resistors: give them all the drive the pad has.
        uint gpio = ANALOG_LED_GPIO[i];
        gpio_set_function(gpio, GPIO_FUNC_PWM);
        gpio_set_drive_strength(gpio, GPIO_DRIVE_STRENGTH_12MA);
        uint slice = pwm_gpio_to_slice_num(gpio);
        pwm_set_wrap(slice, LED_PWM_WRAP);
        pwm_set_gpio_level(gpio, 0);
        pwm_set_enabled(slice, true);
    }
}

static void scan_switches(uint64_t now) {
    const globals_t *g = engine_globals();
    uint64_t debounce = (uint64_t)g->debounce_ms * 1000;
    uint64_t lockout = (uint64_t)g->lockout_ms * 1000;
    uint32_t all = gpio_get_all();

    for (int i = 0; i < NUM_INPUTS; i++) {
        switch_state_t *s = &sw[i];
        bool raw = (all >> SWITCH_GPIO[i]) & 1;
        if (raw != s->raw) {
            s->raw = raw;
            s->raw_since = now;
        }
        if (s->raw == s->stable || now - s->raw_since < debounce)
            continue;
        s->stable = s->raw;
        if (s->stable) {
            if (lockout && last_press[i] && now - last_press[i] < lockout) {
                s->suppressed = true;
                continue;
            }
            last_press[i] = now;
            engine_input((uint8_t)i, true, now);
        } else if (s->suppressed) {
            s->suppressed = false;
        } else {
            engine_input((uint8_t)i, false, now);
        }
    }
}

static void scan_analog(int i, uint64_t now) {
    const globals_t *g = engine_globals();
    analog_state_t *a = &an[i];
    adc_select_input(ANALOG_ADC[i]);
    int32_t raw = adc_read();
    a->smooth_x16 += ((raw << 4) - a->smooth_x16) / 8;
    int32_t smooth = a->smooth_x16 >> 4;

    // Position in quarter steps (0..511), with about half a step of
    // hysteresis so a reading on a boundary doesn't flicker.
    // hi < lo inverts the input (spec B.3); the division handles both.
    int32_t lo = g->analog_min[i], hi = g->analog_max[i];
    int32_t v = (smooth - lo) * 511 / (hi - lo);
    if (v < 0)
        v = 0;
    if (v > 511)
        v = 511;
    int32_t last = a->scaled;
    if (v > last * 4 - 2 && v < last * 4 + 6)
        return;
    if (now - a->last_report < ANALOG_REPORT_INTERVAL_US)
        return;
    a->scaled = (uint8_t)(v / 4);
    a->last_report = now;
    pwm_set_gpio_level(ANALOG_LED_GPIO[i], (uint16_t)(a->scaled * a->scaled));
    protocol_report_analog((uint8_t)i, (uint16_t)smooth, a->scaled);
    engine_analog((uint8_t)i, a->scaled);
}

void inputs_poll(uint64_t now) {
    if (now >= next_scan) {
        next_scan = now + SCAN_INTERVAL_US;
        scan_switches(now);
    }
    if (now >= next_analog) {
        next_analog = now + ANALOG_INTERVAL_US;
        scan_analog(analog_turn, now);
        analog_turn = (uint8_t)((analog_turn + 1) % NUM_ANALOG);
    }
}
