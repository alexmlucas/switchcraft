// Switchcraft board: stock Raspberry Pi Pico. See docs/pin-map.md.
#pragma once

#include <stdint.h>

#define NUM_INPUTS 12  // switch inputs 0..9, analog channel buttons 10..11
#define NUM_ANALOG 2

// Switch inputs in panel order. Active high, internal pull-down.
static const uint8_t SWITCH_GPIO[NUM_INPUTS] = {0, 1, 2, 3, 4, 5, 6, 9, 8, 7, 21, 22};

static const uint8_t ANALOG_GPIO[NUM_ANALOG] = {26, 27};
static const uint8_t ANALOG_ADC[NUM_ANALOG] = {0, 1};
static const uint8_t ANALOG_LED_GPIO[NUM_ANALOG] = {19, 20};

#define ONBOARD_LED_GPIO 25

#define HW_REVISION 1

#define FW_VERSION_MAJOR 0
#define FW_VERSION_MINOR 3
#define FW_VERSION_PATCH 0
