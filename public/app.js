'use strict';

const pumps = [
  { key: 'pump_a', name: 'Pompa Nutrisi A', channel: 1 },
  { key: 'pump_b', name: 'Pompa Nutrisi B', channel: 2 },
  { key: 'ph_up', name: 'Pompa pH Up', channel: 3 },
  { key: 'ph_down', name: 'Pompa pH Down', channel: 4 },
  { key: 'pump_water', name: 'Pompa Air', channel: 5 },
];
const deviceSelect = document.querySelector('#device-select');
const deviceStatus = document.querySelector('#device-status');
const lastSeen = document.querySelector('#last-seen');
const telemetryTime = document.querySelector('#telemetry-time');
const logBody = document.querySelector('#log-body');
const feedback = document.querySelector('#command-feedback');
const apiStatus = document.querySelector('#api-status');
const apiDot = document.querySelector('#api-dot');
const pollStatus = document.querySelector('#poll-status');
const pollDot = document.querySelector('#poll-dot');
const togglePolling = document.querySelector('#toggle-polling');
const pumpGrid = document.querySelector('#pump-grid');
const relayStatuses = new Map();
let interval;
let request;
let generation = 0;
let paused = false;

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
}

function formatSensor(value) {
  if (value === null || value === undefined || value === '' ||
      (typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(Number(value))) return '-';
  return String(value);
}

function setApiStatus(state, text) {
  apiDot.className = `status-dot ${state}`;
  apiStatus.textContent = text;
}

function setDeviceStatus(state) {
  const labels = { online: 'ONLINE', offline: 'OFFLINE', neutral: 'TIDAK DIKETAHUI' };
  deviceStatus.className = `badge badge-${state}`;
  const dot = document.createElement('span');
  dot.className = `status-dot ${state}`;
  deviceStatus.replaceChildren(dot, document.createTextNode(` ${labels[state]}`));
}

function showFeedback(message, state = '') {
  feedback.className = `feedback ${state}`;
  feedback.textContent = message;
}

function renderDevices(devices, selectedId) {
  const ids = new Set();
  for (const device of devices) {
    if (typeof device.device_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(device.device_id)) ids.add(device.device_id);
  }
  ids.add(selectedId);
  const options = Array.from(ids).sort();
  const existing = Array.from(deviceSelect.options, (option) => option.value);
  if (options.length !== existing.length || options.some((id, index) => id !== existing[index])) {
    deviceSelect.replaceChildren(...options.map((id) => new Option(id, id, false, id === selectedId)));
  }
  const current = devices.find((device) => device.device_id === selectedId);
  setDeviceStatus(current?.is_online === true ? 'online' : current?.is_online === false ? 'offline' : 'neutral');
  lastSeen.textContent = formatTime(current?.last_seen_at);
}

function renderTelemetry(telemetry) {
  document.querySelectorAll('[data-sensor]').forEach((element) => {
    element.textContent = formatSensor(telemetry?.[element.dataset.sensor]);
  });
  telemetryTime.textContent = telemetry ? formatTime(telemetry.recorded_at) : 'Belum ada data';
  for (const pump of pumps) {
    const active = telemetry?.relays?.[pump.key];
    const indicator = relayStatuses.get(pump.key);
    indicator.className = `relay-status ${active === true ? 'active' : active === false ? 'inactive' : ''}`;
    const dot = document.createElement('span');
    dot.className = `status-dot ${active === true ? 'online' : ''}`;
    indicator.replaceChildren(dot, document.createTextNode(active === true ? 'AKTIF' : active === false ? 'NONAKTIF' : 'TIDAK DIKETAHUI'));
  }
}

function emptyLogs(message) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 5;
  cell.className = 'table-empty';
  cell.textContent = message;
  row.append(cell);
  logBody.replaceChildren(row);
}

function renderLogs(logs) {
  if (!logs.length) return emptyLogs('Belum ada aktivitas relay.');
  const rows = logs.slice(0, 10).map((log) => {
    const row = document.createElement('tr');
    const values = [formatTime(log.recorded_at), log.pump ?? '-', log.action ?? '-', log.source ?? '-', log.reason || '-'];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      if (index === 2) {
        const label = document.createElement('span');
        label.className = `log-action ${value === 'ON' ? 'on' : value === 'BLOCKED' ? 'blocked' : ''}`;
        label.textContent = value;
        cell.append(label);
      } else {
        cell.textContent = value;
      }
      row.append(cell);
    });
    return row;
  });
  logBody.replaceChildren(...rows);
}

async function getList(path, signal) {
  const response = await fetch(path, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Respons API tidak valid');
  return data;
}

async function refresh() {
  if (request) return;
  const id = deviceSelect.value;
  const currentGeneration = generation;
  const controller = new AbortController();
  request = controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  const prefix = `/api/devices/${encodeURIComponent(id)}`;
  const results = await Promise.allSettled([
    getList('/api/devices', controller.signal),
    getList(`${prefix}/telemetry?limit=1`, controller.signal),
    getList(`${prefix}/relay-logs?limit=10`, controller.signal),
  ]);
  clearTimeout(timeout);
  if (request === controller) request = null;
  if (currentGeneration !== generation) return;
  const [devices, telemetry, logs] = results;
  if (devices.status === 'fulfilled') renderDevices(devices.value, id);
  else { setDeviceStatus('neutral'); lastSeen.textContent = '-'; }
  if (telemetry.status === 'fulfilled') renderTelemetry(telemetry.value[0] ?? null);
  else { renderTelemetry(null); telemetryTime.textContent = 'Gagal memuat data'; }
  if (logs.status === 'fulfilled') renderLogs(logs.value);
  else emptyLogs('Gagal memuat aktivitas relay.');
  const failures = results.filter((result) => result.status === 'rejected').length;
  if (!failures) setApiStatus('online', 'API terhubung');
  else if (failures === results.length) setApiStatus('offline', 'API tidak tersedia');
  else setApiStatus('partial', 'Sebagian data gagal dimuat');
}

function cancelRefresh() {
  generation++;
  if (request) request.abort();
  request = null;
}

function startPolling() {
  void refresh();
  interval = setInterval(() => void refresh(), 3000);
}

function updatePollingLabel() {
  togglePolling.textContent = paused ? 'Lanjutkan' : 'Jeda';
  togglePolling.setAttribute('aria-pressed', String(paused));
  pollStatus.textContent = paused ? 'Pembaruan dijeda' : 'Pembaruan setiap 3 detik';
  pollDot.className = `pulse-dot ${paused ? '' : 'active'}`;
}

async function sendCommand(command, button) {
  const id = deviceSelect.value;
  button.disabled = true;
  showFeedback(`Mengirim perintah ke ${id}...`);
  try {
    const response = await fetch(`/api/devices/${encodeURIComponent(id)}/cmd/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (response.status !== 202) throw new Error(`HTTP ${response.status}${data?.error ? `: ${data.error}` : ''}`);
    showFeedback(`Perintah ke ${id} dikirim (202). Tunggu telemetri atau log untuk konfirmasi perangkat.`, 'success');
    if (!paused && deviceSelect.value === id) void refresh();
  } catch (error) {
    showFeedback(`Perintah ke ${id} gagal: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

function createPumpCards() {
  for (const pump of pumps) {
    const card = document.createElement('article');
    card.className = 'pump-card';
    card.innerHTML = `
      <div class="pump-top"><span class="pump-symbol" aria-hidden="true">◈</span><span class="pump-channel">CH 0${pump.channel}</span></div>
      <h3 class="pump-name">${pump.name}</h3>
      <div class="pump-key">${pump.key}</div>
      <div class="relay-status"><span class="status-dot"></span> TIDAK DIKETAHUI</div>
      <label class="duration-label" for="duration-${pump.key}">Durasi berjalan</label>
      <div class="duration-wrap"><input id="duration-${pump.key}" type="number" inputmode="numeric" min="0" max="4294967295" step="1" ${pump.channel < 5 ? 'value="5000"' : 'placeholder="0"'}><span>ms</span></div>
      <div class="pump-actions"><button class="button button-on" type="button">ON</button><button class="button button-off" type="button">OFF</button></div>`;
    const input = card.querySelector('input');
    const [on, off] = card.querySelectorAll('button');
    relayStatuses.set(pump.key, card.querySelector('.relay-status'));
    on.addEventListener('click', () => {
      const text = input.value.trim();
      const duration = Number(text);
      if (text && (!Number.isInteger(duration) || duration < 0 || duration > 4294967295 || !/^\d+$/.test(text))) {
        showFeedback('Durasi harus berupa bilangan bulat antara 0 dan 4294967295 ms.', 'error');
        input.focus();
        return;
      }
      const command = { pump: pump.key, state: true };
      if (text) command.duration_ms = duration;
      void sendCommand(command, on);
    });
    off.addEventListener('click', () => void sendCommand({ pump: pump.key, state: false }, off));
    pumpGrid.append(card);
  }
}

createPumpCards();
document.querySelector('#all-off').addEventListener('click', (event) => void sendCommand({ all_off: true }, event.currentTarget));
togglePolling.addEventListener('click', () => {
  paused = !paused;
  if (paused) { clearInterval(interval); cancelRefresh(); }
  else startPolling();
  updatePollingLabel();
});
deviceSelect.addEventListener('change', () => {
  cancelRefresh();
  setDeviceStatus('neutral');
  lastSeen.textContent = '-';
  renderTelemetry(null);
  emptyLogs('Menunggu data aktivitas...');
  showFeedback('Belum ada perintah dikirim.');
  void refresh();
});
updatePollingLabel();
startPolling();
