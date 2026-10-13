// Switch and analog input scanning (spec B.4). Feeds events to the engine.
#pragma once

#include <stdint.h>

void inputs_init(void);
void inputs_poll(uint64_t now_us);
