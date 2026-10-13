cmake_minimum_required(VERSION 3.13)

set(PICO_BOARD pico CACHE STRING "Board type")

include(pico_sdk_import.cmake)

project(switchcraft C CXX ASM)
set(CMAKE_C_STANDARD 11)

pico_sdk_init()

add_executable(switchcraft
    src/main.c
    src/config.c
    src/crc32.c
    src/engine.c
    src/inputs.c
    src/midi.c
    src/protocol.c
    src/slots.c
    src/table.c
    src/usb_descriptors.c
)

target_include_directories(switchcraft PRIVATE src)
target_compile_options(switchcraft PRIVATE -Wall -Wextra -Wno-unused-parameter)

target_link_libraries(switchcraft PRIVATE
    pico_stdlib
    pico_unique_id
    pico_flash
    hardware_adc
    hardware_flash
    hardware_pwm
    tinyusb_device
)

# GP0/GP1 are switch inputs and USB is MIDI only: no stdio on either.
pico_enable_stdio_uart(switchcraft 0)
pico_enable_stdio_usb(switchcraft 0)

pico_add_extra_outputs(switchcraft)
