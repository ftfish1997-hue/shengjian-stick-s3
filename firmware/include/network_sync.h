#pragma once

#include <cstddef>
#include <cstdint>

namespace network_sync {

void begin();
bool isProvisionCommand(const char* command);
bool handleProvisionCommand(const char* command, uint32_t minimum_sequence_floor);
bool isWifiConfigCommand(const char* command);
bool handleWifiConfigCommand(const char* command);
bool createMetadataForWav(const char* wav_path, uint32_t sequence,
                          size_t sample_count);
bool loop();
bool isProvisioned();
uint32_t uploadMinimumSequence();
bool setUploadMinimumSequence(uint32_t minimum_sequence);
bool armDropAckNext();
bool setNetworkPausedForTest(bool paused);
bool networkPausedForTest();
size_t configuredWifiCount();
int activeWifiSlot();
int connectingWifiSlot();
const char* wifiSlotRole(size_t slot);
const char* statusLine();

}  // namespace network_sync
