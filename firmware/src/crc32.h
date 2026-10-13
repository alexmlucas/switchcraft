#pragma once

#include <stddef.h>
#include <stdint.h>

// IEEE/zlib CRC-32 (spec B.1).
uint32_t crc32(const uint8_t *data, size_t len);
