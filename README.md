# CloudRover — Node.js + MQTT local dashboard

This is a local-first starter project for the current rover. It includes a responsive browser dashboard, an Express server, MQTT command/status topics, persistent timestamped frame storage, and starter ESP32 MQTT firmware.

## What works now vs. later

**Included now**
- Node.js/Express dashboard and Socket.IO live UI updates.
- MQTT publishing for forward/reverse/left/right/stop/speed.
- Rover status subscriber and honest “not connected” states.
- Local timestamped image storage (`data/frames/`) and metadata (`data/frames.json`).
- Optional same-origin camera stream proxy for later ESP32-CAM integration.
- Starter ESP32 firmware with a 500 ms movement command timeout.

**Not connected in your current hardware**
- The current ESP32 code uses Bluetooth SPP; this starter firmware uses Wi-Fi + MQTT instead. You must upload the new firmware to control the rover from the dashboard.
- The ESP32-CAM is not present yet, so camera preview and capture stay unavailable until a compatible camera stream is configured.
- The HC-SR04 is not wired yet; the dashboard must not show a distance reading until the sensor is wired and firmware support is enabled.
- YOLO/object detection is not implemented in this starter.

## Requirements

- Node.js 20+ (Node 22 is fine)
- Mosquitto MQTT broker on the same laptop/PC
- Arduino IDE or PlatformIO for the ESP32 firmware
- Laptop and ESP32 connected to the same trusted Wi-Fi network

## 1. Install and run Mosquitto

Install Mosquitto for your OS. On Windows, the installer normally provides `mosquitto.exe` and `mosquitto.conf`. For a quick local-only test, run the broker on the laptop:

```powershell
mosquitto -v
```

The default broker listens on port `1883`. Keep it on a trusted network and do not port-forward it to the internet. The example file in `mosquitto/mosquitto.conf.example` is development-only and binds to localhost, which is suitable for Node-only testing but not for an ESP32 on Wi-Fi. For the rover, configure Mosquitto to listen on the laptop's LAN interface, restrict access, and use username/password authentication before connecting hardware.

## 2. Start the dashboard

Open PowerShell in this project folder:

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Open `http://localhost:3000`.

To access it from a phone on the same Wi-Fi, open `http://YOUR-LAPTOP-LAN-IP:3000`. Find the laptop IP with `ipconfig`. Windows Firewall may ask whether Node.js can accept local-network connections.

## 3. Test the dashboard without the rover

With Mosquitto running, start the Node server. Use a second terminal to publish a sample status packet:

```powershell
mosquitto_pub -h 127.0.0.1 -t cloudrover/rover1/status -m "{\"ultrasonicConnected\":false,\"distanceCm\":null,\"speed\":180}"
```

The MQTT status indicator should connect and the rover status should update after a status message. Since the dashboard uses live status packets to infer rover presence, publish again if you want to refresh it.

You can inspect commands with:

```powershell
mosquitto_sub -h 127.0.0.1 -t cloudrover/rover1/cmd -v
```

Click a dashboard control; the JSON command should appear in the subscriber terminal.

## 4. Connect the ESP32 rover (after desktop MQTT test)

1. Keep the ESP32 and laptop on the same Wi-Fi network.
2. Copy `firmware/esp32_rover_mqtt/esp32_rover_mqtt.ino` into Arduino IDE.
3. Install the `PubSubClient` library.
4. Update `WIFI_SSID`, `WIFI_PASSWORD`, and `MQTT_HOST`. `MQTT_HOST` must be the laptop's LAN IP, such as `192.168.1.10`; do not use `127.0.0.1` on the ESP32.
5. Ensure Mosquitto listens on the laptop's LAN interface and firewall permits port 1883 from the trusted local network. Do not expose it publicly.
6. Verify the motor pin mapping and battery/motor ratings before testing. Raise the chassis so wheels are off the floor for the first test.
7. Upload the firmware. This replaces your existing Bluetooth control program; your Bluetooth controller app will no longer control the rover unless you restore the old firmware or implement both transports.

The firmware uses the user's stated motor pins: ENA=GPIO14, IN1=GPIO27, IN2=GPIO26, IN3=GPIO25, IN4=GPIO33, ENB=GPIO32. Remove the L298N ENA/ENB jumpers if using PWM on those enable pins. Motor-side mapping in code assumes OUT1/OUT2 are the right side and OUT3/OUT4 are the left side. Reverse a side's direction in code if your physical wiring differs.

## 5. ESP32-CAM stream (future, when the camera is acquired)

1. Put the ESP32-CAM on the same Wi-Fi network and run a camera web-server sketch.
2. Verify the stream URL from the laptop browser first (commonly a URL ending in `/stream`; the exact path depends on the sketch).
3. Set `CAMERA_STREAM_URL` in `.env`, for example `http://192.168.1.55:81/stream`.
4. Set `CAMERA_PROXY_ENABLED=true` and restart Node.
5. Confirm the dashboard shows a camera image. Then click **Capture frame**; the browser captures a frame from the same-origin proxy and the server stores the image plus timestamp/session metadata locally.

If capture fails, inspect the browser console and verify the stream is MJPEG and reachable. Some ESP32-CAM sketches use a different stream port/path.

## Topics and payloads

- `cloudrover/rover1/cmd`: dashboard publishes commands, e.g. `{"command":"forward","ts":"2026-10-30T12:00:00.000Z"}`.
- `cloudrover/rover1/status`: rover publishes status. Current firmware reports speed and explicitly reports the ultrasonic sensor as disconnected.
- `cloudrover/rover1/event`: optional event log published by firmware.

## Safety and limitations

- The 500 ms timeout is implemented in rover firmware; it is not a substitute for a physical power switch or safe test procedure.
- Keep the wheels raised during first tests. Test STOP and disconnect behavior before normal use.
- Three 18650 cells in series can reach 12.6 V fully charged. Confirm the motor and driver voltage/current ratings; do not assume the motors tolerate the full battery voltage.
- ESP32 GPIOs are 3.3 V logic. If you later connect an HC-SR04, its ECHO output may be 5 V and must be level-shifted/divided before reaching the ESP32 GPIO.
- Do not claim live video, ultrasonic measurements, YOLO detections, or measured latency until each is implemented and tested.
- This starter has no authentication layer. Keep it on a trusted LAN only; add authentication and broker credentials before using it beyond a controlled prototype.

## Storage

Captured images are stored under `data/frames/`; metadata is in `data/frames.json`. Back up this directory if evidence must be retained. The delete button removes the selected image and its metadata.
