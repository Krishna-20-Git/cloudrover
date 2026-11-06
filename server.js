require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const mqtt = require("mqtt");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const MQTT_URL = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";
const ROVER_ID = process.env.ROVER_ID || "rover1";
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const FRAME_DIR = path.join(DATA_DIR, "frames");
const META_FILE = path.join(DATA_DIR, "frames.json");

fs.mkdirSync(FRAME_DIR, { recursive: true });
if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, "[]", "utf8");

const topics = {
  cmd: `cloudrover/${ROVER_ID}/cmd`,
  status: `cloudrover/${ROVER_ID}/status`,
  event: `cloudrover/${ROVER_ID}/event`
};

const state = {
  roverConnected: false,
  mqttConnected: false,
  cameraConfigured: Boolean(process.env.CAMERA_STREAM_URL),
  cameraProxyEnabled: process.env.CAMERA_PROXY_ENABLED === "true",
  mode: "LOCAL",
  lastSeen: null,
  lastCommand: null,
  telemetry: { distanceCm: null, ultrasonicConnected: false, batteryV: null, speed: null },
  events: []
};

function readFrames() {
  try { return JSON.parse(fs.readFileSync(META_FILE, "utf8")); }
  catch { return []; }
}
function writeFrames(frames) {
  fs.writeFileSync(META_FILE, JSON.stringify(frames, null, 2), "utf8");
}
function safeName(name) {
  return String(name || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "inspection";
}

app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use("/frames", express.static(FRAME_DIR));

const mqttOptions = {
  clientId: `cloudrover-dashboard-${Math.random().toString(16).slice(2, 10)}`,
  clean: true,
  reconnectPeriod: 2000,
  connectTimeout: 5000
};
if (process.env.MQTT_USERNAME) mqttOptions.username = process.env.MQTT_USERNAME;
if (process.env.MQTT_PASSWORD) mqttOptions.password = process.env.MQTT_PASSWORD;

const mqttClient = mqtt.connect(MQTT_URL, mqttOptions);

mqttClient.on("connect", () => {
  state.mqttConnected = true;
  mqttClient.subscribe([topics.status, topics.event], { qos: 0 }, (err) => {
    if (err) console.error("MQTT subscribe error:", err.message);
  });
  emitState();
  addEvent("system", "Connected to local MQTT broker");
});
mqttClient.on("reconnect", () => { state.mqttConnected = false; emitState(); });
mqttClient.on("close", () => { state.mqttConnected = false; emitState(); });
mqttClient.on("error", (err) => console.error("MQTT:", err.message));

mqttClient.on("message", (topic, buffer) => {
  let payload;
  try { payload = JSON.parse(buffer.toString()); }
  catch { payload = { raw: buffer.toString() }; }

  if (topic === topics.status) {
    state.roverConnected = true;
    state.lastSeen = new Date().toISOString();
    state.telemetry = {
      distanceCm: Number.isFinite(Number(payload.distanceCm)) ? Number(payload.distanceCm) : null,
      ultrasonicConnected: payload.ultrasonicConnected === true,
      batteryV: Number.isFinite(Number(payload.batteryV)) ? Number(payload.batteryV) : null,
      speed: Number.isFinite(Number(payload.speed)) ? Number(payload.speed) : null
    };
    state.roverStatus = payload;
    emitState();
  } else if (topic === topics.event) {
    addEvent(payload.type || "rover", payload.message || "Rover event received", payload);
  }
});

function emitState() { io.emit("state", getPublicState()); }
function getPublicState() {
  return {
    ...state,
    topics,
    frames: readFrames().slice(0, 100),
    cameraStreamUrl: state.cameraConfigured && state.cameraProxyEnabled ? "/camera/stream" : null
  };
}
function addEvent(type, message, extra = {}) {
  const item = { id: `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, time: new Date().toISOString(), type, message, ...extra };
  state.events.unshift(item);
  state.events = state.events.slice(0, 100);
  io.emit("event", item);
  emitState();
}

app.get("/api/status", (_req, res) => res.json(getPublicState()));
app.get("/api/frames", (_req, res) => res.json(readFrames()));

app.post("/api/command", (req, res) => {
  const allowed = new Set(["forward", "reverse", "left", "right", "stop", "speed"]);
  const { command, value } = req.body || {};
  if (!allowed.has(command)) return res.status(400).json({ error: "Unsupported command" });
  if (!state.mqttConnected) return res.status(503).json({ error: "MQTT broker is not connected" });

  const payload = { command, ts: new Date().toISOString() };
  if (command === "speed") {
    const speed = Number(value);
    if (!Number.isInteger(speed) || speed < 0 || speed > 255) return res.status(400).json({ error: "Speed must be an integer from 0 to 255" });
    payload.value = speed;
  }
  mqttClient.publish(topics.cmd, JSON.stringify(payload), { qos: 0, retain: false }, (err) => {
    if (err) return res.status(502).json({ error: "MQTT publish failed" });
    state.lastCommand = payload;
    addEvent("command", command === "speed" ? `Speed set to ${payload.value}` : `Command sent: ${command}`, { command: payload });
    res.json({ ok: true, sent: payload });
  });
});

app.post("/api/frames", (req, res) => {
  const { imageData, label = "manual capture", session = "default", source = "rover camera" } = req.body || {};
  if (typeof imageData !== "string" || !imageData.startsWith("data:image/")) {
    return res.status(400).json({ error: "imageData must be a base64 data URL" });
  }
  const match = imageData.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return res.status(400).json({ error: "Only JPEG, PNG, and WebP images are supported" });
  const ext = match[1] === "jpg" ? "jpg" : match[1];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${stamp}_${safeName(session)}.${ext}`;
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 8 * 1024 * 1024) return res.status(413).json({ error: "Frame exceeds 8 MB" });
  fs.writeFileSync(path.join(FRAME_DIR, filename), buffer);
  const frames = readFrames();
  const frame = { id: `${Date.now()}`, filename, url: `/frames/${filename}`, timestamp: new Date().toISOString(), label: String(label).slice(0, 120), session: safeName(session), source: String(source).slice(0, 80), bytes: buffer.length };
  frames.unshift(frame);
  writeFrames(frames);
  addEvent("frame", `Frame saved: ${frame.label}`, { frameId: frame.id, filename });
  res.status(201).json({ ok: true, frame });
});

app.delete("/api/frames/:id", (req, res) => {
  const frames = readFrames();
  const frame = frames.find(f => f.id === req.params.id);
  if (!frame) return res.status(404).json({ error: "Frame not found" });
  try { fs.unlinkSync(path.join(FRAME_DIR, path.basename(frame.filename))); } catch {}
  writeFrames(frames.filter(f => f.id !== frame.id));
  addEvent("frame", `Frame deleted: ${frame.filename}`);
  res.json({ ok: true });
});

// Optional same-origin MJPEG proxy for browser preview/capture. Disabled until configured.
app.get("/camera/stream", async (_req, res) => {
  const url = process.env.CAMERA_STREAM_URL;
  if (process.env.CAMERA_PROXY_ENABLED !== "true" || !url) {
    return res.status(503).send("Camera proxy is disabled. Configure CAMERA_STREAM_URL and CAMERA_PROXY_ENABLED=true in .env.");
  }
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!upstream.ok || !upstream.body) return res.status(502).send(`Camera returned HTTP ${upstream.status}`);
    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type") || "multipart/x-mixed-replace";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    const reader = upstream.body.getReader();
    reqLoop();
    async function reqLoop() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (res.destroyed) break;
          if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
        }
      } catch {}
      if (!res.destroyed) res.end();
    }
    res.on("close", () => { try { reader.cancel(); } catch {} });
  } catch (err) {
    if (!res.headersSent) res.status(502).send(`Unable to reach camera: ${err.message}`);
  }
});

io.on("connection", socket => socket.emit("state", getPublicState()));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CloudRover dashboard: http://localhost:${PORT}`);
  console.log(`MQTT broker: ${MQTT_URL}`);
  console.log(`Command topic: ${topics.cmd}`);
});
process.on("SIGINT", () => { mqttClient.end(true); server.close(() => process.exit(0)); });
