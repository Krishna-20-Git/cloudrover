const socket = io();
const $ = id => document.getElementById(id);
let currentState = null;
let events = [];
let toastTimer;

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function formatTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
function setText(id, value) { $(id).textContent = value; }

socket.on("connect", () => toast("Dashboard connected to local server"));
socket.on("connect_error", () => toast("Cannot connect to dashboard server"));
socket.on("state", renderState);
socket.on("event", item => { events.unshift(item); events = events.slice(0, 100); renderEvents(); });

function renderState(s) {
  currentState = s;
  $("mqttDot").classList.toggle("good", s.mqttConnected);
  setText("mqttText", s.mqttConnected ? "MQTT connected" : "MQTT offline");
  setText("roverStatus", s.roverConnected ? "Online" : "Waiting");
  setText("lastSeen", s.lastSeen ? `Last packet: ${formatTime(s.lastSeen)}` : "No status packet received");
  setText("cameraStatus", s.cameraStreamUrl ? "Configured" : "Not connected");
  setText("cameraHint", s.cameraStreamUrl ? "Stream endpoint configured" : "Connect ESP32-CAM later");
  setText("cameraTag", s.cameraStreamUrl ? "CONFIGURED" : "OFFLINE");
  setText("distance", s.telemetry?.ultrasonicConnected && s.telemetry.distanceCm !== null ? `${s.telemetry.distanceCm.toFixed(1)} cm` : "Not connected");
  setText("sensorHint", s.telemetry?.ultrasonicConnected ? "Live sensor packet received" : "No live distance reading");
  setText("frameCount", `${(s.frames || []).length} frames`);
  setText("libraryCount", String((s.frames || []).length));
  const connected = Boolean(s.mqttConnected);
  document.querySelectorAll("[data-command]").forEach(b => b.disabled = !connected);
  $("setSpeed").disabled = !connected;
  $("controlWarning").textContent = connected ? "Commands publish to the local MQTT broker. Confirm rover firmware is subscribed before testing." : "Commands are disabled until the local MQTT broker connects.";
  if (s.cameraStreamUrl) {
    if ($("cameraImage").src !== new URL(s.cameraStreamUrl, location.href).href) $("cameraImage").src = s.cameraStreamUrl;
    $("cameraImage").hidden = false;
    $("cameraPlaceholder").hidden = true;
    $("captureBtn").disabled = false;
    $("captureHint").textContent = "Capture saves a timestamped frame and metadata on this computer.";
    $("cameraImage").onerror = () => {
      $("cameraImage").hidden = true;
      $("cameraPlaceholder").hidden = false;
      $("cameraPlaceholder").querySelector("h4").textContent = "Camera stream unavailable";
      $("cameraPlaceholder").querySelector("p").textContent = "Check the camera IP, stream URL, Wi-Fi network, and proxy configuration.";
      $("captureBtn").disabled = true;
    };
    $("cameraImage").onload = () => {
      $("cameraImage").hidden = false;
      $("cameraPlaceholder").hidden = true;
    };
  } else {
    $("cameraImage").hidden = true;
    $("cameraPlaceholder").hidden = false;
    $("captureBtn").disabled = true;
  }
  renderGallery(s.frames || []);
  if (s.events) { events = s.events; renderEvents(); }
}
function renderGallery(frames) {
  const gallery = $("gallery");
  if (!frames.length) { gallery.innerHTML = '<div class="empty">No frames saved yet. Captured images will appear here with timestamps.</div>'; return; }
  gallery.innerHTML = frames.map(f => `<article class="frame-card"><img src="${f.url}" alt="Saved frame" loading="lazy"><div class="frame-info"><strong>${escapeHtml(f.label || "Frame")}</strong><small>${escapeHtml(formatTime(f.timestamp))}</small><small>Session: ${escapeHtml(f.session || "default")}</small><div class="frame-actions"><a href="${f.url}" target="_blank" rel="noreferrer">Open image ↗</a><button data-delete="${f.id}">Delete</button></div></div></article>`).join("");
  gallery.querySelectorAll("[data-delete]").forEach(b => b.addEventListener("click", async () => {
    const r = await fetch(`/api/frames/${encodeURIComponent(b.dataset.delete)}`, { method: "DELETE" });
    const data = await r.json();
    if (!r.ok) return toast(data.error || "Delete failed");
    toast("Frame deleted");
    refreshState();
  }));
}
function renderEvents() {
  const el = $("timeline");
  if (!events.length) { el.innerHTML = '<div class="empty">Waiting for MQTT, rover status, and capture events.</div>'; return; }
  el.innerHTML = events.slice(0, 50).map(e => `<div class="event"><span class="event-dot"></span><div><strong>${escapeHtml(String(e.type || "event").toUpperCase())} · ${escapeHtml(formatTime(e.time))}</strong><p>${escapeHtml(e.message || "")}</p></div></div>`).join("");
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
async function command(command, value) {
  try {
    const r = await fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command, value }) });
    const data = await r.json();
    if (!r.ok) return toast(data.error || "Command failed");
    toast(command === "speed" ? `Speed set to ${value}` : `Sent ${command}`);
  } catch { toast("Dashboard server unavailable"); }
}
document.querySelectorAll("[data-command]").forEach(b => b.addEventListener("click", () => command(b.dataset.command)));
$("speed").addEventListener("input", e => setText("speedValue", `${e.target.value} / 255`));
$("setSpeed").addEventListener("click", () => command("speed", Number($("speed").value)));
$("captureBtn").addEventListener("click", async () => {
  const img = $("cameraImage");
  if (!img || img.hidden || !img.naturalWidth) return toast("Camera frame is not available");
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    const imageData = canvas.toDataURL("image/jpeg", 0.88);
    const r = await fetch("/api/frames", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      imageData,
      label: $("frameLabel").value.trim() || "manual capture",
      session: $("sessionName").value.trim() || "default",
      source: "rover camera"
    }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Could not save frame");
    $("frameLabel").value = "";
    toast("Frame saved with timestamp");
    refreshState();
  } catch (e) {
    toast(e.name === "SecurityError" ? "Browser blocked capture. Use the same-origin camera proxy and try again." : (e.message || "Capture failed"));
  }
});
$("clearEvents").addEventListener("click", () => { events = []; renderEvents(); });
async function refreshState() {
  try { const r = await fetch("/api/status"); if (r.ok) renderState(await r.json()); } catch {}
}
setInterval(() => setText("clock", new Date().toLocaleTimeString()), 1000);
refreshState();
