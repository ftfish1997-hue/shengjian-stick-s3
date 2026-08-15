#include "network_sync.h"

#include <LittleFS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

#include <esp_system.h>
#include <mbedtls/base64.h>

#include "app_config.h"
#include "supabase_ca.h"

namespace network_sync {
namespace {

constexpr char kPreferencesNamespace[] = "voice-inbox";
constexpr char kPendingDirectory[] = "/pending";
constexpr uint8_t kWifiSchemaVersion = 2;
constexpr size_t kWifiSlotCount = 3;
constexpr uint8_t kNoWifiSlot = 0xFF;
constexpr uint32_t kConnectAttemptMs = 8000;
constexpr uint32_t kConnectCyclePauseMs = 15000;
constexpr uint32_t kTimeSyncAttemptMs = 15000;
constexpr uint32_t kUploadRetryMs = 10000;
constexpr uint8_t kNetworkFailureRotateThreshold = 2;
constexpr uint32_t kHttpTimeoutMs = 20000;
constexpr size_t kResponseLimit = 2048;
// Replace this placeholder with the host of the Supabase project you own
// before provisioning or flashing a physical device.
constexpr char kUploadHost[] = "YOUR_PROJECT_REF.supabase.co";
constexpr char kUploadPath[] = "/functions/v1/upload-record";

struct WifiCredential {
  String ssid;
  String password;
};

enum class UploadOutcome {
  kSuccess,
  kNetworkFailure,
  kApplicationFailure,
};

WifiCredential wifi_slots[kWifiSlotCount];
String device_id;
String device_token;
uint32_t upload_minimum_sequence = UINT32_MAX;
uint32_t last_upload_attempt_at = 0;
uint32_t connect_attempt_started_at = 0;
uint32_t next_connect_cycle_at = 0;
uint32_t time_sync_attempt_started_at = 0;
uint8_t connecting_wifi_slot = kNoWifiSlot;
uint8_t active_wifi_slot = kNoWifiSlot;
uint8_t next_wifi_slot = 0;
uint8_t attempts_in_cycle = 0;
uint8_t consecutive_network_failures = 0;
bool time_sync_started = false;
bool provisioned = false;
bool drop_next_valid_ack = false;
bool network_paused_for_test = false;
char status_line[48] = "NET UNPROVISIONED";

constexpr char kWifiSsidKeys[kWifiSlotCount][8] = {
    "w0_ssid", "w1_ssid", "w2_ssid"};
constexpr char kWifiPasswordKeys[kWifiSlotCount][6] = {
    "w0_pw", "w1_pw", "w2_pw"};
constexpr char kWifiSlotNames[kWifiSlotCount][9] = {
    "PRIMARY", "FALLBACK", "HOTSPOT"};

void setStatus(const char* value) {
  std::snprintf(status_line, sizeof(status_line), "%s", value);
}

bool isUuid(const char* value) {
  if (value == nullptr || std::strlen(value) != 36) return false;
  for (size_t index = 0; index < 36; ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-') return false;
    } else if (!std::isxdigit(static_cast<unsigned char>(value[index]))) {
      return false;
    }
  }
  return value[14] >= '1' && value[14] <= '5' &&
         (value[19] == '8' || value[19] == '9' ||
          value[19] == 'a' || value[19] == 'b' ||
          value[19] == 'A' || value[19] == 'B');
}

uint32_t sequenceFromPath(const char* path) {
  if (path == nullptr) return 0;
  const char* name = std::strrchr(path, '/');
  name = name == nullptr ? path : name + 1;
  if (std::strlen(name) != 20 || std::strncmp(name, "recording-", 10) != 0 ||
      std::strcmp(name + 16, ".wav") != 0) return 0;
  uint32_t sequence = 0;
  for (size_t index = 10; index < 16; ++index) {
    if (!std::isdigit(static_cast<unsigned char>(name[index]))) return 0;
    sequence = sequence * 10 + static_cast<uint32_t>(name[index] - '0');
  }
  return sequence;
}

bool metadataPathForWav(const char* wav_path, char* output, size_t output_size) {
  const size_t length = wav_path == nullptr ? 0 : std::strlen(wav_path);
  if (length < 5 || length + 1 > output_size || std::strcmp(wav_path + length - 4, ".wav") != 0) {
    return false;
  }
  std::snprintf(output, output_size, "%.*s.json", static_cast<int>(length - 4), wav_path);
  return true;
}

void generateUuid(char* output, size_t output_size) {
  if (output_size < 37) return;
  uint8_t bytes[16] = {};
  esp_fill_random(bytes, sizeof(bytes));
  bytes[6] = static_cast<uint8_t>((bytes[6] & 0x0F) | 0x40);
  bytes[8] = static_cast<uint8_t>((bytes[8] & 0x3F) | 0x80);
  std::snprintf(
      output, output_size,
      "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
      bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
      bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]);
}

bool decodeBase64(const char* encoded, char* output, size_t output_size) {
  if (encoded == nullptr || output == nullptr || output_size < 2) return false;
  size_t decoded_length = 0;
  const int result = mbedtls_base64_decode(
      reinterpret_cast<unsigned char*>(output), output_size - 1, &decoded_length,
      reinterpret_cast<const unsigned char*>(encoded), std::strlen(encoded));
  if (result != 0 || decoded_length >= output_size) return false;
  output[decoded_length] = '\0';
  return true;
}

bool wifiCredentialValid(const String& ssid, const String& password) {
  return !ssid.isEmpty() && ssid.length() <= 32 &&
         password.length() >= 8 && password.length() <= 63;
}

size_t configuredWifiCountInternal() {
  size_t count = 0;
  for (const WifiCredential& slot : wifi_slots) {
    if (wifiCredentialValid(slot.ssid, slot.password)) ++count;
  }
  return count;
}

bool loadProvisioning() {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, true)) return false;
  for (WifiCredential& slot : wifi_slots) {
    slot.ssid = "";
    slot.password = "";
  }
  const uint8_t wifi_schema = preferences.getUChar("wifi_schema", 1);
  if (wifi_schema >= kWifiSchemaVersion) {
    for (size_t slot = 0; slot < kWifiSlotCount; ++slot) {
      wifi_slots[slot].ssid = preferences.getString(kWifiSsidKeys[slot], "");
      wifi_slots[slot].password =
          preferences.getString(kWifiPasswordKeys[slot], "");
    }
  } else {
    // Version 1 used one legacy pair. Keep it in RAM until the first explicit
    // multi-Wi-Fi update migrates all configured slots atomically.
    wifi_slots[0].ssid = preferences.getString("wifi_ssid", "");
    wifi_slots[0].password = preferences.getString("wifi_pw", "");
  }
  device_id = preferences.getString("device_id", "");
  device_token = preferences.getString("device_token", "");
  upload_minimum_sequence = preferences.getUInt("upload_min", UINT32_MAX);
  preferences.end();
  return configuredWifiCountInternal() > 0 &&
         device_id == app_config::kDeviceId && device_token.length() >= 32 &&
         upload_minimum_sequence != UINT32_MAX;
}

bool persistProvisioning(const char* ssid, const char* password,
                         const char* id, const char* token,
                         uint32_t minimum_sequence) {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  bool ok = preferences.putString("wifi_ssid", ssid) == std::strlen(ssid) &&
            preferences.putString("wifi_pw", password) == std::strlen(password) &&
            preferences.putString(kWifiSsidKeys[0], ssid) == std::strlen(ssid) &&
            preferences.putString(kWifiPasswordKeys[0], password) ==
                std::strlen(password) &&
            preferences.putString("device_id", id) == std::strlen(id) &&
            preferences.putString("device_token", token) == std::strlen(token) &&
            preferences.putUInt("upload_min", minimum_sequence) ==
                sizeof(uint32_t);
  preferences.remove(kWifiSsidKeys[1]);
  preferences.remove(kWifiPasswordKeys[1]);
  preferences.remove(kWifiSsidKeys[2]);
  preferences.remove(kWifiPasswordKeys[2]);
  if (ok) {
    ok = preferences.putUChar("wifi_schema", kWifiSchemaVersion) ==
         sizeof(uint8_t);
  }
  preferences.end();
  return ok;
}

bool persistWifiSlot(uint8_t target_slot, const char* ssid,
                     const char* password) {
  if (target_slot >= kWifiSlotCount || ssid == nullptr || password == nullptr) {
    return false;
  }
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;

  bool ok = true;
  // Migrate the legacy in-RAM primary together with the requested change.
  // Writing the schema marker last prevents a partial migration from hiding
  // the still-valid legacy credentials after a power loss.
  for (size_t slot = 0; slot < kWifiSlotCount; ++slot) {
    const char* slot_ssid =
        slot == target_slot ? ssid : wifi_slots[slot].ssid.c_str();
    const char* slot_password =
        slot == target_slot ? password : wifi_slots[slot].password.c_str();
    if (slot_ssid[0] == '\0') {
      preferences.remove(kWifiSsidKeys[slot]);
      preferences.remove(kWifiPasswordKeys[slot]);
    } else {
      ok = ok &&
           preferences.putString(kWifiSsidKeys[slot], slot_ssid) ==
               std::strlen(slot_ssid) &&
           preferences.putString(kWifiPasswordKeys[slot], slot_password) ==
               std::strlen(slot_password);
    }
  }
  if (ok) {
    ok = preferences.putUChar("wifi_schema", kWifiSchemaVersion) ==
         sizeof(uint8_t);
  }
  preferences.end();
  return ok;
}

bool timeReady() {
  const std::time_t now = std::time(nullptr);
  return now >= 1700000000;
}

int nextConfiguredWifiSlot(uint8_t start_slot) {
  for (size_t offset = 0; offset < kWifiSlotCount; ++offset) {
    const uint8_t slot =
        static_cast<uint8_t>((start_slot + offset) % kWifiSlotCount);
    if (wifiCredentialValid(wifi_slots[slot].ssid,
                            wifi_slots[slot].password)) {
      return slot;
    }
  }
  return -1;
}

void resetConnectionCycle(uint8_t start_slot) {
  connecting_wifi_slot = kNoWifiSlot;
  connect_attempt_started_at = 0;
  next_wifi_slot = static_cast<uint8_t>(start_slot % kWifiSlotCount);
  attempts_in_cycle = 0;
  next_connect_cycle_at = 0;
}

void startWifiAttempt(uint8_t slot, uint32_t now) {
  connecting_wifi_slot = slot;
  connect_attempt_started_at = now;
  next_wifi_slot = static_cast<uint8_t>((slot + 1) % kWifiSlotCount);
  ++attempts_in_cycle;
  WiFi.disconnect(false, false);
  WiFi.begin(wifi_slots[slot].ssid.c_str(), wifi_slots[slot].password.c_str());
  char status[48] = {};
  std::snprintf(status, sizeof(status), "NET TRY %s", kWifiSlotNames[slot]);
  setStatus(status);
  Serial.printf("wifi_connect_start slot=%u role=%s\n",
                static_cast<unsigned>(slot), kWifiSlotNames[slot]);
}

bool ensureNetworkReady() {
  if (!provisioned) return false;
  if (network_paused_for_test) {
    setStatus("NET TEST PAUSED");
    return false;
  }
  if (WiFi.status() == WL_CONNECTED) {
    if (active_wifi_slot == kNoWifiSlot) {
      active_wifi_slot = connecting_wifi_slot;
      if (active_wifi_slot == kNoWifiSlot) {
        active_wifi_slot = static_cast<uint8_t>(
            std::max(0, nextConfiguredWifiSlot(0)));
      }
      connecting_wifi_slot = kNoWifiSlot;
      attempts_in_cycle = 0;
      next_connect_cycle_at = 0;
      Serial.printf("wifi_connected slot=%u role=%s rssi=%d\n",
                    static_cast<unsigned>(active_wifi_slot),
                    kWifiSlotNames[active_wifi_slot], WiFi.RSSI());
    }
    if (!time_sync_started) {
      configTime(0, 0, "ntp.aliyun.com", "pool.ntp.org");
      time_sync_started = true;
      time_sync_attempt_started_at = millis();
      setStatus("NET TIME SYNC");
      Serial.println("time_sync_start");
    }
    if (!timeReady()) {
      if (millis() - time_sync_attempt_started_at >= kTimeSyncAttemptMs) {
        const uint8_t failed_slot = active_wifi_slot;
        Serial.printf(
            "wifi_rotate reason=time_sync_timeout from_slot=%u role=%s\n",
            static_cast<unsigned>(failed_slot), kWifiSlotNames[failed_slot]);
        active_wifi_slot = kNoWifiSlot;
        time_sync_started = false;
        time_sync_attempt_started_at = 0;
        WiFi.disconnect(false, false);
        resetConnectionCycle(
            static_cast<uint8_t>((failed_slot + 1) % kWifiSlotCount));
      }
      return false;
    }
    char status[48] = {};
    std::snprintf(status, sizeof(status), "NET ONLINE %s",
                  kWifiSlotNames[active_wifi_slot]);
    setStatus(status);
    return true;
  }

  const uint32_t now = millis();
  if (active_wifi_slot != kNoWifiSlot) {
    Serial.printf("wifi_disconnected slot=%u role=%s\n",
                  static_cast<unsigned>(active_wifi_slot),
                  kWifiSlotNames[active_wifi_slot]);
    active_wifi_slot = kNoWifiSlot;
    consecutive_network_failures = 0;
    if (!timeReady()) {
      time_sync_started = false;
      time_sync_attempt_started_at = 0;
    }
    resetConnectionCycle(0);
  }
  if (connecting_wifi_slot != kNoWifiSlot) {
    if (now - connect_attempt_started_at < kConnectAttemptMs) return false;
    Serial.printf("wifi_connect_timeout slot=%u role=%s\n",
                  static_cast<unsigned>(connecting_wifi_slot),
                  kWifiSlotNames[connecting_wifi_slot]);
    WiFi.disconnect(false, false);
    connecting_wifi_slot = kNoWifiSlot;
  }

  const size_t configured_count = configuredWifiCountInternal();
  if (attempts_in_cycle >= configured_count) {
    attempts_in_cycle = 0;
    next_wifi_slot = 0;
    next_connect_cycle_at = now + kConnectCyclePauseMs;
    setStatus("NET WAIT RETRY");
    Serial.printf("wifi_cycle_wait configured=%u delay_ms=%u\n",
                  static_cast<unsigned>(configured_count),
                  static_cast<unsigned>(kConnectCyclePauseMs));
    return false;
  }
  if (next_connect_cycle_at != 0 &&
      static_cast<int32_t>(now - next_connect_cycle_at) < 0) {
    return false;
  }
  next_connect_cycle_at = 0;
  const int slot = nextConfiguredWifiSlot(next_wifi_slot);
  if (slot < 0) {
    setStatus("NET NO WIFI");
    return false;
  }
  startWifiAttempt(static_cast<uint8_t>(slot), now);
  return false;
}

bool findUploadCandidate(char* wav_path, size_t wav_path_size,
                         char* metadata_path, size_t metadata_path_size) {
  File directory = LittleFS.open(kPendingDirectory);
  if (!directory || !directory.isDirectory()) return false;
  uint32_t selected_sequence = UINT32_MAX;
  File entry = directory.openNextFile();
  while (entry) {
    if (!entry.isDirectory()) {
      const uint32_t sequence = sequenceFromPath(entry.name());
      if (sequence >= upload_minimum_sequence && sequence < selected_sequence) {
        char candidate_wav[64] = {};
        const char* name = std::strrchr(entry.name(), '/');
        name = name == nullptr ? entry.name() : name + 1;
        std::snprintf(candidate_wav, sizeof(candidate_wav), "%s/%s", kPendingDirectory, name);
        char candidate_metadata[64] = {};
        if (metadataPathForWav(candidate_wav, candidate_metadata, sizeof(candidate_metadata)) &&
            LittleFS.exists(candidate_metadata)) {
          selected_sequence = sequence;
          std::snprintf(wav_path, wav_path_size, "%s", candidate_wav);
          std::snprintf(metadata_path, metadata_path_size, "%s", candidate_metadata);
        }
      }
    }
    entry.close();
    entry = directory.openNextFile();
  }
  directory.close();
  return selected_sequence != UINT32_MAX;
}

bool readMetadata(File& metadata, String& body, char* event_id, size_t event_id_size) {
  if (!metadata || metadata.size() == 0 || metadata.size() > 1024) return false;
  body.reserve(metadata.size() + 1);
  while (metadata.available()) body += static_cast<char>(metadata.read());
  const char marker[] = "\"event_id\":\"";
  const int start = body.indexOf(marker);
  if (start < 0) return false;
  const int value_start = start + static_cast<int>(std::strlen(marker));
  const int value_end = body.indexOf('"', value_start);
  if (value_end < 0 || static_cast<size_t>(value_end - value_start + 1) > event_id_size) return false;
  body.substring(value_start, value_end).toCharArray(event_id, event_id_size);
  return isUuid(event_id);
}

bool writeAll(WiFiClientSecure& client, const uint8_t* data, size_t length) {
  size_t written = 0;
  while (written < length) {
    const size_t result = client.write(data + written, length - written);
    if (result == 0) return false;
    written += result;
  }
  return true;
}

bool streamFile(WiFiClientSecure& client, File& file) {
  uint8_t buffer[2048] = {};
  while (file.available()) {
    const size_t read = file.read(buffer, sizeof(buffer));
    if (read == 0 || !writeAll(client, buffer, read)) return false;
    delay(1);
  }
  return true;
}

bool readLine(WiFiClientSecure& client, String& line) {
  line = "";
  const uint32_t started_at = millis();
  while (millis() - started_at < kHttpTimeoutMs) {
    while (client.available()) {
      const char value = static_cast<char>(client.read());
      if (value == '\n') return true;
      if (value != '\r') line += value;
      if (line.length() > 512) return false;
    }
    if (!client.connected()) return !line.isEmpty();
    delay(1);
  }
  return false;
}

bool readFixedBody(WiFiClientSecure& client, size_t content_length, String& body) {
  body = "";
  body.reserve(std::min(content_length, kResponseLimit));
  size_t received = 0;
  const uint32_t started_at = millis();
  while (received < content_length && millis() - started_at < kHttpTimeoutMs) {
    while (client.available() && received < content_length) {
      const char value = static_cast<char>(client.read());
      if (body.length() < kResponseLimit) body += value;
      ++received;
    }
    if (!client.connected() && !client.available()) break;
    delay(1);
  }
  return received == content_length;
}

bool readChunkedBody(WiFiClientSecure& client, String& body) {
  body = "";
  body.reserve(512);
  while (true) {
    String length_line;
    if (!readLine(client, length_line)) return false;
    const char* cursor = length_line.c_str();
    char* end = nullptr;
    const unsigned long chunk_length = std::strtoul(cursor, &end, 16);
    if (end == cursor) return false;
    if (chunk_length == 0) {
      String trailer;
      readLine(client, trailer);
      return true;
    }
    size_t received = 0;
    const uint32_t started_at = millis();
    while (received < chunk_length && millis() - started_at < kHttpTimeoutMs) {
      while (client.available() && received < chunk_length) {
        const char value = static_cast<char>(client.read());
        if (body.length() < kResponseLimit) body += value;
        ++received;
      }
      delay(1);
    }
    if (received != chunk_length) return false;
    String terminator;
    if (!readLine(client, terminator)) return false;
  }
}

bool responseAcknowledges(const String& body, const char* event_id,
                          bool& duplicate) {
  duplicate = false;
  if (body.indexOf("\"success\":true") < 0 ||
      body.indexOf("\"status\":\"accepted\"") < 0) return false;
  const bool duplicate_true = body.indexOf("\"duplicate\":true") >= 0;
  const bool duplicate_false = body.indexOf("\"duplicate\":false") >= 0;
  if (duplicate_true == duplicate_false) return false;
  duplicate = duplicate_true;
  const String expected_event = String("\"event_id\":\"") + event_id + "\"";
  if (body.indexOf(expected_event) < 0) return false;
  const char marker[] = "\"record_id\":\"";
  const int start = body.indexOf(marker);
  if (start < 0) return false;
  const int value_start = start + static_cast<int>(std::strlen(marker));
  const int value_end = body.indexOf('"', value_start);
  if (value_end < 0) return false;
  char record_id[40] = {};
  body.substring(value_start, value_end).toCharArray(record_id, sizeof(record_id));
  return isUuid(record_id);
}

UploadOutcome uploadCandidate(const char* wav_path, const char* metadata_path) {
  File audio = LittleFS.open(wav_path, FILE_READ);
  File metadata = LittleFS.open(metadata_path, FILE_READ);
  String metadata_body;
  char event_id[40] = {};
  if (!audio || !readMetadata(metadata, metadata_body, event_id, sizeof(event_id))) {
    if (audio) audio.close();
    if (metadata) metadata.close();
    Serial.println("upload_error reason=local_file_invalid");
    return UploadOutcome::kApplicationFailure;
  }
  metadata.close();

  char boundary[48] = {};
  std::snprintf(boundary, sizeof(boundary), "----sticks3-%08lx%08lx",
                static_cast<unsigned long>(esp_random()),
                static_cast<unsigned long>(esp_random()));
  const String prefix = String("--") + boundary +
      "\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"recording.wav\"\r\n"
      "Content-Type: audio/wav\r\n\r\n";
  const String middle = String("\r\n--") + boundary +
      "\r\nContent-Disposition: form-data; name=\"metadata\"\r\n"
      "Content-Type: application/json\r\n\r\n";
  const String ending = String("\r\n--") + boundary + "--\r\n";
  const size_t content_length = prefix.length() + audio.size() + middle.length() +
                                metadata_body.length() + ending.length();

  WiFiClientSecure client;
  client.setCACert(kSupabaseRootCa);
  client.setHandshakeTimeout(15);
  client.setTimeout(20);
  setStatus("NET UPLOADING");
  Serial.printf("upload_start path=%s bytes=%u\n", wav_path,
                static_cast<unsigned>(audio.size()));
  if (!client.connect(kUploadHost, 443)) {
    audio.close();
    Serial.println("upload_error reason=tls_connect_failed");
    return UploadOutcome::kNetworkFailure;
  }

  client.printf("POST %s HTTP/1.1\r\n", kUploadPath);
  client.printf("Host: %s\r\n", kUploadHost);
  client.printf("Authorization: Bearer %s\r\n", device_token.c_str());
  client.printf("X-Device-ID: %s\r\n", device_id.c_str());
  client.printf("X-Event-ID: %s\r\n", event_id);
  client.printf("Content-Type: multipart/form-data; boundary=%s\r\n", boundary);
  client.printf("Content-Length: %u\r\n", static_cast<unsigned>(content_length));
  client.print("Connection: close\r\n\r\n");

  bool sent = writeAll(client, reinterpret_cast<const uint8_t*>(prefix.c_str()), prefix.length()) &&
              streamFile(client, audio) &&
              writeAll(client, reinterpret_cast<const uint8_t*>(middle.c_str()), middle.length()) &&
              writeAll(client, reinterpret_cast<const uint8_t*>(metadata_body.c_str()), metadata_body.length()) &&
              writeAll(client, reinterpret_cast<const uint8_t*>(ending.c_str()), ending.length());
  audio.close();
  if (!sent) {
    client.stop();
    Serial.println("upload_error reason=request_write_failed");
    return UploadOutcome::kNetworkFailure;
  }

  String status;
  if (!readLine(client, status) || !status.startsWith("HTTP/1.1 ")) {
    client.stop();
    Serial.println("upload_error reason=response_status_missing");
    return UploadOutcome::kNetworkFailure;
  }
  const int http_status = status.substring(9, 12).toInt();
  size_t response_length = 0;
  bool chunked = false;
  while (true) {
    String header;
    if (!readLine(client, header)) {
      client.stop();
      Serial.println("upload_error reason=response_header_failed");
      return UploadOutcome::kNetworkFailure;
    }
    if (header.isEmpty()) break;
    String lower = header;
    lower.toLowerCase();
    if (lower.startsWith("content-length:")) {
      response_length = static_cast<size_t>(header.substring(15).toInt());
    } else if (lower.startsWith("transfer-encoding:") && lower.indexOf("chunked") >= 0) {
      chunked = true;
    }
  }

  String response_body;
  const bool body_ok = chunked ? readChunkedBody(client, response_body)
                               : readFixedBody(client, response_length, response_body);
  client.stop();
  bool duplicate = false;
  if (!body_ok) {
    Serial.printf("upload_error reason=response_body_failed http=%d\n",
                  http_status);
    return UploadOutcome::kNetworkFailure;
  }
  if (http_status != 200 ||
      !responseAcknowledges(response_body, event_id, duplicate)) {
    Serial.printf("upload_error reason=ack_invalid http=%d\n", http_status);
    return UploadOutcome::kApplicationFailure;
  }
  Serial.printf("upload_ack event_id=%s duplicate=%s\n", event_id,
                duplicate ? "true" : "false");

  if (drop_next_valid_ack) {
    drop_next_valid_ack = false;
    Serial.printf(
        "test_drop_ack_triggered event_id=%s duplicate=%s "
        "local_preserved=true\n",
        event_id, duplicate ? "true" : "false");
    return UploadOutcome::kApplicationFailure;
  }

  if (!LittleFS.remove(wav_path)) {
    Serial.println("upload_error reason=ack_received_local_delete_failed");
    return UploadOutcome::kApplicationFailure;
  }
  if (!LittleFS.remove(metadata_path)) {
    Serial.println("upload_warning reason=orphan_metadata");
  }
  Serial.printf("upload_done event_id=%s duplicate=%s local_deleted=true\n",
                event_id, duplicate ? "true" : "false");
  return UploadOutcome::kSuccess;
}

}  // namespace

void begin() {
  provisioned = loadProvisioning();
  if (provisioned) {
    setStatus("NET OFFLINE");
    WiFi.persistent(false);
    WiFi.setAutoReconnect(false);
    WiFi.mode(WIFI_STA);
    resetConnectionCycle(0);
    Serial.printf(
        "provisioned=true device_id=%s upload_min=%u wifi_slots=%u\n",
        device_id.c_str(), static_cast<unsigned>(upload_minimum_sequence),
        static_cast<unsigned>(configuredWifiCountInternal()));
  } else {
    setStatus("NET UNPROVISIONED");
    Serial.println("provisioned=false");
  }
}

bool isProvisionCommand(const char* command) {
  return command != nullptr && std::strncmp(command, "PROVISION_V1 ", 13) == 0;
}

bool isWifiConfigCommand(const char* command) {
  return command != nullptr &&
         std::strncmp(command, "WIFI_SET_V1 ", 12) == 0;
}

bool handleWifiConfigCommand(const char* command) {
  if (!isWifiConfigCommand(command)) return false;
  if (!provisioned) {
    Serial.println("wifi_config_error reason=device_not_provisioned");
    return false;
  }
  char copy[192] = {};
  std::snprintf(copy, sizeof(copy), "%s", command + 12);
  char* context = nullptr;
  const char* slot_text = strtok_r(copy, " ", &context);
  const char* encoded_ssid = strtok_r(nullptr, " ", &context);
  const char* encoded_password = strtok_r(nullptr, " ", &context);
  if (!slot_text || !encoded_ssid || !encoded_password ||
      strtok_r(nullptr, " ", &context) != nullptr) {
    Serial.println("wifi_config_error reason=invalid_fields");
    std::memset(copy, 0, sizeof(copy));
    return false;
  }

  char* slot_end = nullptr;
  const unsigned long requested_slot = std::strtoul(slot_text, &slot_end, 10);
  char ssid[33] = {};
  char password[65] = {};
  if (slot_end == slot_text || *slot_end != '\0' ||
      requested_slot >= kWifiSlotCount ||
      !decodeBase64(encoded_ssid, ssid, sizeof(ssid)) ||
      !decodeBase64(encoded_password, password, sizeof(password)) ||
      std::strlen(ssid) == 0 || std::strlen(password) < 8 ||
      std::strlen(password) > 63) {
    Serial.println("wifi_config_error reason=invalid_values");
    std::memset(password, 0, sizeof(password));
    std::memset(copy, 0, sizeof(copy));
    return false;
  }
  if (!persistWifiSlot(static_cast<uint8_t>(requested_slot), ssid, password)) {
    Serial.println("wifi_config_error reason=nvs_write_failed");
    std::memset(password, 0, sizeof(password));
    std::memset(copy, 0, sizeof(copy));
    return false;
  }
  Serial.printf(
      "wifi_config_ok slot=%u role=%s configured=true "
      "restart_required=true\n",
      static_cast<unsigned>(requested_slot),
      kWifiSlotNames[requested_slot]);
  std::memset(password, 0, sizeof(password));
  std::memset(copy, 0, sizeof(copy));
  return true;
}

bool handleProvisionCommand(const char* command, uint32_t minimum_sequence_floor) {
  if (!isProvisionCommand(command)) return false;
  char copy[384] = {};
  std::snprintf(copy, sizeof(copy), "%s", command + 13);
  char* context = nullptr;
  const char* encoded_ssid = strtok_r(copy, " ", &context);
  const char* encoded_password = strtok_r(nullptr, " ", &context);
  const char* encoded_id = strtok_r(nullptr, " ", &context);
  const char* encoded_token = strtok_r(nullptr, " ", &context);
  const char* minimum_text = strtok_r(nullptr, " ", &context);
  if (!encoded_ssid || !encoded_password || !encoded_id || !encoded_token || !minimum_text ||
      strtok_r(nullptr, " ", &context) != nullptr) {
    Serial.println("provision_error reason=invalid_fields");
    return false;
  }

  char ssid[33] = {};
  char password[65] = {};
  char id[65] = {};
  char token[129] = {};
  char* number_end = nullptr;
  const unsigned long requested_minimum = std::strtoul(minimum_text, &number_end, 10);
  if (!decodeBase64(encoded_ssid, ssid, sizeof(ssid)) ||
      !decodeBase64(encoded_password, password, sizeof(password)) ||
      !decodeBase64(encoded_id, id, sizeof(id)) ||
      !decodeBase64(encoded_token, token, sizeof(token)) ||
      number_end == minimum_text || *number_end != '\0' ||
      std::strlen(ssid) == 0 || std::strlen(password) < 8 ||
      std::strcmp(id, app_config::kDeviceId) != 0 || std::strlen(token) < 32) {
    Serial.println("provision_error reason=invalid_values");
    return false;
  }
  const uint32_t minimum = std::max(
      minimum_sequence_floor, static_cast<uint32_t>(requested_minimum));
  if (!persistProvisioning(ssid, password, id, token, minimum)) {
    Serial.println("provision_error reason=nvs_write_failed");
    return false;
  }
  Serial.printf("provision_ok device_id=%s upload_min=%u restart_required=true\n", id,
                static_cast<unsigned>(minimum));
  std::memset(password, 0, sizeof(password));
  std::memset(token, 0, sizeof(token));
  return true;
}

bool createMetadataForWav(const char* wav_path, uint32_t sequence,
                          size_t sample_count) {
  if (!provisioned || sequence < upload_minimum_sequence) return true;
  char metadata_path[64] = {};
  if (!metadataPathForWav(wav_path, metadata_path, sizeof(metadata_path))) return false;
  char temporary_path[72] = {};
  std::snprintf(temporary_path, sizeof(temporary_path), "%s.tmp", metadata_path);
  if (LittleFS.exists(metadata_path) || LittleFS.exists(temporary_path)) return false;

  char event_id[40] = {};
  generateUuid(event_id, sizeof(event_id));
  char body[512] = {};
  const int length = std::snprintf(
      body, sizeof(body),
      "{\"event_id\":\"%s\",\"device_id\":\"%s\",\"captured_at\":null,"
      "\"kind\":\"voice_record\",\"session_id\":null,\"duration_seconds\":%.3f,"
      "\"firmware_version\":\"%s\",\"schema_version\":1}",
      event_id, device_id.c_str(),
      static_cast<double>(sample_count) /
          static_cast<double>(app_config::kRecordingSampleRate),
      app_config::kVersion);
  if (length <= 0 || static_cast<size_t>(length) >= sizeof(body)) return false;

  File output = LittleFS.open(temporary_path, FILE_WRITE);
  if (!output) return false;
  const bool write_ok = output.write(reinterpret_cast<const uint8_t*>(body), length) ==
                        static_cast<size_t>(length);
  output.flush();
  output.close();
  if (!write_ok || !LittleFS.rename(temporary_path, metadata_path)) {
    LittleFS.remove(temporary_path);
    return false;
  }
  Serial.printf("metadata_saved sequence=%u event_id=%s\n",
                static_cast<unsigned>(sequence), event_id);
  return true;
}

bool loop() {
  if (!ensureNetworkReady()) return false;
  const uint32_t now = millis();
  if (last_upload_attempt_at != 0 && now - last_upload_attempt_at < kUploadRetryMs) return false;
  last_upload_attempt_at = now;
  char wav_path[64] = {};
  char metadata_path[64] = {};
  if (!findUploadCandidate(wav_path, sizeof(wav_path), metadata_path, sizeof(metadata_path))) {
    setStatus("NET ONLINE / IDLE");
    return false;
  }
  const UploadOutcome outcome = uploadCandidate(wav_path, metadata_path);
  const bool uploaded = outcome == UploadOutcome::kSuccess;
  if (outcome == UploadOutcome::kNetworkFailure) {
    ++consecutive_network_failures;
    if (consecutive_network_failures >= kNetworkFailureRotateThreshold &&
        active_wifi_slot != kNoWifiSlot) {
      const uint8_t failed_slot = active_wifi_slot;
      Serial.printf(
          "wifi_rotate reason=upload_network_failures from_slot=%u role=%s "
          "failures=%u\n",
          static_cast<unsigned>(failed_slot), kWifiSlotNames[failed_slot],
          static_cast<unsigned>(consecutive_network_failures));
      consecutive_network_failures = 0;
      active_wifi_slot = kNoWifiSlot;
      WiFi.disconnect(false, false);
      resetConnectionCycle(
          static_cast<uint8_t>((failed_slot + 1) % kWifiSlotCount));
    }
  } else {
    consecutive_network_failures = 0;
  }
  setStatus(uploaded ? "NET SYNCED" : "NET RETRYING");
  return uploaded;
}

bool isProvisioned() { return provisioned; }

uint32_t uploadMinimumSequence() { return upload_minimum_sequence; }

bool setUploadMinimumSequence(uint32_t minimum_sequence) {
  if (!provisioned || minimum_sequence == 0) return false;
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const bool ok =
      preferences.putUInt("upload_min", minimum_sequence) == sizeof(uint32_t);
  preferences.end();
  if (ok) upload_minimum_sequence = minimum_sequence;
  return ok;
}

bool armDropAckNext() {
  if (!provisioned || drop_next_valid_ack) return false;
  drop_next_valid_ack = true;
  return true;
}

bool setNetworkPausedForTest(bool paused) {
  if (!provisioned || network_paused_for_test == paused) return false;
  network_paused_for_test = paused;
  consecutive_network_failures = 0;
  active_wifi_slot = kNoWifiSlot;
  resetConnectionCycle(0);
  if (paused) {
    WiFi.disconnect(false, false);
    setStatus("NET TEST PAUSED");
  } else {
    setStatus("NET OFFLINE");
  }
  return true;
}

bool networkPausedForTest() { return network_paused_for_test; }

size_t configuredWifiCount() { return configuredWifiCountInternal(); }

int activeWifiSlot() {
  return active_wifi_slot == kNoWifiSlot ? -1 : active_wifi_slot;
}

int connectingWifiSlot() {
  return connecting_wifi_slot == kNoWifiSlot ? -1 : connecting_wifi_slot;
}

const char* wifiSlotRole(size_t slot) {
  return slot < kWifiSlotCount ? kWifiSlotNames[slot] : "UNKNOWN";
}

const char* statusLine() { return status_line; }

}  // namespace network_sync
