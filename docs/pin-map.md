# Switchcraft pin map

Extracted from `electronics/switchcraft/switchcraft.kicad_pcb` (pad → net
assignments on the Pico footprint `A1`) and cross-checked against the sheet
instances in `switchcraft.kicad_sch`. PCB last changed in git on 2025-12-11.

The board carries a **stock Raspberry Pi Pico** (2 MB flash) as module `A1`.
Ignore `switchcraft.xml` and `switchcraft.csv` in the same folder: they are
a netlist and BOM exported from an unrelated bare-RP2040 reference design
(`KiCAD_Board_3_Minimal_Full_RP2040`, 2023) and don't describe this board.

## Logical input numbering

Inputs are numbered in **panel order** (PCB placement): left column top to
bottom, then right column top to bottom. The firmware and the SysEx/rule-table
spec use these 0-based indices; the page shows them 1-based.

The right-hand column is **not** in GPIO order (GP5, GP6, GP9, GP8, GP7), so
the firmware needs a lookup table, not `gpio = index`.

### Switch inputs (digital)

| Input | Panel | GPIO | Pico pin | Sheet | Jack | Button | LED | Driver |
|---|---|---|---|---|---|---|---|---|
| 0 | Left 1 | GP0 | 1 | `discrete_input` | CN4 | SW4 | D4 | Q4 |
| 1 | Left 2 | GP1 | 2 | `discrete_input1` | CN5 | SW5 | D5 | Q5 |
| 2 | Left 3 | GP2 | 4 | `discrete_input2` | CN6 | SW6 | D6 | Q6 |
| 3 | Left 4 | GP3 | 5 | `discrete_input3` | CN7 | SW7 | D7 | Q7 |
| 4 | Left 5 | GP4 | 6 | `discrete_input4` | CN8 | SW8 | D8 | Q8 |
| 5 | Right 1 | GP5 | 7 | `discrete_input5` | CN9 | SW9 | D12 | Q9 |
| 6 | Right 2 | GP6 | 9 | `discrete_input6` | CN10 | SW10 | D13 | Q10 |
| 7 | Right 3 | GP9 | 12 | `discrete_input9` | CN13 | SW13 | D9 | Q13 |
| 8 | Right 4 | GP8 | 11 | `discrete_input8` | CN12 | SW12 | D10 | Q12 |
| 9 | Right 5 | GP7 | 10 | `discrete_input7` | CN11 | SW11 | D11 | Q11 |
| 10 | Left 6 (analog channel button) | GP21 | 27 | `new_continuous1` | — | SW2 | — | — |
| 11 | Right 6 (analog channel button) | GP22 | 29 | `new_continuous` | — | SW3 | — | — |

### Analog inputs

| Analog | Panel | GPIO / ADC | Pico pin | Sheet | Jack | Pull-down | Status LED (firmware) |
|---|---|---|---|---|---|---|---|
| 0 | Left 6 | GP26 / ADC0 | 31 | `new_continuous1` | CN2 | R2 10 kΩ to AGND | GP19 (pin 25) → D2, R5 62 Ω |
| 1 | Right 6 | GP27 / ADC1 | 32 | `new_continuous` | CN3 | R3 10 kΩ to AGND | GP20 (pin 26) → D19, R6 62 Ω |

## Circuit behaviour the firmware must match

**Switch inputs (0–9): active high, no external pull-down.**
The jack (pad 4) and the on-board button both connect the GPIO to +3V3. The
same net drives the base of a BC548 emitter follower that lights the
channel LED, so these LEDs are **pure hardware** and show the raw switch
state; firmware can't control them. Firmware must:
- enable the internal **pull-down** (`gpio_pull_down`), otherwise the input
  floats when nothing is plugged in;
- treat high as pressed;
- debounce in software (no RC filter on the board).

**Analog channel buttons (10, 11): active high, no external pull-down.**
SW2/SW3 connect GP21/GP22 to +3V3. Same handling as above. There's no
hardware LED on these.

**Analog inputs (A0, A1): voltage divider.**
Jack pad 2 carries +3V3 out; pads 4 and 5 both go to the ADC pin, which has
a 10 kΩ pull-down to AGND. A resistive sensor or expression pedal forms the
top half of the divider. With nothing plugged in the ADC reads about 0. The
response is non-linear and depends on the sensor, so per-input min/max
calibration is worth having (see the rule-table spec, globals section).

**Firmware-driven LEDs (GP19, GP20).**
Driven straight from the GPIO through 62 Ω. At 3.3 V with a ~2 V LED this
asks for ~20 mA, more than the RP2040 pad can supply (default drive 4 mA,
maximum 12 mA). It works, because the pad current-limits, but the pin will
sag. Set `gpio_set_drive_strength(..., GPIO_DRIVE_STRENGTH_12MA)` if the
LEDs are too dim, and consider a larger resistor on the next board revision.

## Unused pins

Free on the Pico header: GP10–GP18, GP28/ADC2, plus RUN, 3V3_EN, VSYS,
VBUS and ADC_VREF (all unconnected on this board). The jack pads 2 and 3 on
the switch-input jacks are unconnected (presumably the switched contacts),
so the board can't detect whether a switch is plugged in.

## For the firmware

```c
// Switch inputs 0..11, in panel order. Active high, internal pull-down.
static const uint8_t SWITCH_GPIO[12] = {0, 1, 2, 3, 4, 5, 6, 9, 8, 7, 21, 22};

// Analog inputs 0..1.
static const uint8_t ANALOG_GPIO[2] = {26, 27};   // ADC0, ADC1
static const uint8_t ANALOG_ADC[2]  = {0, 1};
static const uint8_t ANALOG_LED_GPIO[2] = {19, 20};
```
