/*
  CloudRover MQTT motor-control starter
  Board: classic ESP32 DevKit V1 / ESP32-WROOM + L298N
  Requires Arduino libraries: PubSubClient (Nick O'Leary)

  IMPORTANT:
  - Update WIFI_SSID, WIFI_PASSWORD, and MQTT_HOST.
  - MQTT_HOST is the laptop's LAN IPv4 address, NOT 127.0.0.1.
  - This sketch replaces the existing Bluetooth control firmware.
  - Confirm motor pin mapping and motor voltage before powering wheels.
  - The hardware watchdog stops motors after 500 ms without a valid motion command.
  - HC-SR04 is intentionally marked disconnected until you wire it and enable the code.
*/
#include <WiFi.h>
#include <PubSubClient.h>

const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* MQTT_HOST = "192.168.1.10"; // laptop LAN IP
const uint16_t MQTT_PORT = 1883;
const char* ROVER_ID = "rover1";

const int ENA = 14;
const int IN1 = 27;
const int IN2 = 26;
const int IN3 = 25;
const int IN4 = 33;
const int ENB = 32;

// HC-SR04 pins reserved for later; do not report sensor values until wired.
const int TRIG_PIN = 18;
const int ECHO_PIN = 19;
const bool ULTRASONIC_CONNECTED = false;

const unsigned long FAILSAFE_MS = 500;
const unsigned long STATUS_INTERVAL_MS = 1000;

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
String commandTopic;
String statusTopic;
String eventTopic;
unsigned long lastValidCommandMs = 0;
unsigned long lastStatusMs = 0;
int speedValue = 180;
bool motorsMoving = false;

void stopMotors() {
  digitalWrite(IN1, LOW); digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW); digitalWrite(IN4, LOW);
  ledcWrite(ENA, 0);
  ledcWrite(ENB, 0);
  motorsMoving = false;
}
void setMotorSide(int enPin, int inA, int inB, int pwm) {
  digitalWrite(inA, pwm > 0 ? HIGH : LOW);
  digitalWrite(inB, pwm < 0 ? HIGH : LOW);
  ledcWrite(enPin, abs(pwm));
}
void drive(const String& command) {
  int left = 0, right = 0;
  if (command == "forward") { left = speedValue; right = speedValue; }
  else if (command == "reverse") { left = -speedValue; right = -speedValue; }
  else if (command == "left") { left = -speedValue; right = speedValue; }
  else if (command == "right") { left = speedValue; right = -speedValue; }
  else { stopMotors(); return; }

  // Wiring assumption follows the user's current mapping:
  // OUT1/OUT2 = right-side motors; OUT3/OUT4 = left-side motors.
  setMotorSide(ENA, IN1, IN2, right);
  setMotorSide(ENB, IN3, IN4, left);
  motorsMoving = true;
}
void publishEvent(const char* type, const String& message) {
  if (!mqtt.connected()) return;
  String payload = "{\"type\":\"" + String(type) + "\",\"message\":\"" + message + "\"}";
  mqtt.publish(eventTopic.c_str(), payload.c_str(), false);
}
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (String(topic) != commandTopic) return;
  String body;
  for (unsigned int i = 0; i < length; i++) body += (char)payload[i];

  // Small parser suitable for the dashboard's flat JSON messages.
  if (body.indexOf("\"command\":\"stop\"") >= 0) {
    stopMotors();
    lastValidCommandMs = millis();
    publishEvent("safety", "Stop command received");
  } else if (body.indexOf("\"command\":\"speed\"") >= 0) {
    int key = body.indexOf("\"value\":");
    if (key >= 0) {
      int v = body.substring(key + 8).toInt();
      if (v >= 0 && v <= 255) {
        speedValue = v;
        lastValidCommandMs = millis();
        publishEvent("control", "Speed updated");
      }
    }
  } else if (body.indexOf("\"command\":\"forward\"") >= 0) {
    drive("forward"); lastValidCommandMs = millis();
  } else if (body.indexOf("\"command\":\"reverse\"") >= 0) {
    drive("reverse"); lastValidCommandMs = millis();
  } else if (body.indexOf("\"command\":\"left\"") >= 0) {
    drive("left"); lastValidCommandMs = millis();
  } else if (body.indexOf("\"command\":\"right\"") >= 0) {
    drive("right"); lastValidCommandMs = millis();
  }
}
void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(400);
}
void connectMqtt() {
  while (!mqtt.connected()) {
    String clientId = "CloudRover-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    if (mqtt.connect(clientId.c_str())) {
      mqtt.subscribe(commandTopic.c_str(), 0);
      publishEvent("system", "Rover connected to MQTT");
    } else delay(1500);
  }
}
void setup() {
  Serial.begin(115200);
  pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  // Arduino-ESP32 core 3.x LEDC API uses pin-based ledcAttach/ledcWrite.
  ledcAttach(ENA, 1000, 8);
  ledcAttach(ENB, 1000, 8);
  stopMotors();

  commandTopic = String("cloudrover/") + ROVER_ID + "/cmd";
  statusTopic = String("cloudrover/") + ROVER_ID + "/status";
  eventTopic = String("cloudrover/") + ROVER_ID + "/event";

  connectWifi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(512);
  lastValidCommandMs = millis();
  Serial.print("Wi-Fi IP: "); Serial.println(WiFi.localIP());
}
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    stopMotors();
    connectWifi();
  }
  if (!mqtt.connected()) {
    stopMotors();
    connectMqtt();
  }
  mqtt.loop();

  if (motorsMoving && millis() - lastValidCommandMs > FAILSAFE_MS) {
    stopMotors();
    publishEvent("safety", "500 ms command timeout; motors stopped");
  }
  if (millis() - lastStatusMs >= STATUS_INTERVAL_MS) {
    lastStatusMs = millis();
    // Only report fields that are real. Distance remains null/disconnected until wired.
    String payload = "{\"ultrasonicConnected\":false,\"distanceCm\":null,\"speed\":" + String(speedValue) + "}";
    mqtt.publish(statusTopic.c_str(), payload.c_str(), false);
  }
}
