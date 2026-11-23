import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import mqtt from 'mqtt';
import { createBroker } from '../src/mqtt/broker.js';
import { startIngest } from '../src/mqtt/ingest.js';
import { createApp } from '../src/app.js';

const credentials = { username: 'test-user', password: 'test-password' };

function connect(url, options = {}) {
  const client = mqtt.connect(url, { reconnectPeriod: 0, ...options });
  return client;
}

test('broker requires authentication, routes telemetry, retains status, and publishes last will', { timeout: 10000 }, async (t) => {
  const broker = await createBroker({ port: 0, host: '127.0.0.1', ...credentials });
  const url = `mqtt://127.0.0.1:${broker.server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const client of clients) await new Promise((resolve) => client.end(true, resolve));
    await broker.close();
  });
  const rejected = connect(url, { username: credentials.username, password: 'wrong-password' });
  clients.push(rejected);
  const [error] = await once(rejected, 'error');
  assert.match(error.message, /not authorized|bad username or password/i);
  const anonymous = connect(url);
  clients.push(anonymous);
  const [anonymousError] = await once(anonymous, 'error');
  assert.match(anonymousError.message, /not authorized|bad username or password/i);

  const worker = connect(url, credentials);
  clients.push(worker);
  await once(worker, 'connect');
  const queries = [];
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      return { rowCount: 1 };
    },
    async connect() {
      return { query: this.query, release() {} };
    },
  };
  const stop = startIngest(worker, pool);
  await new Promise((resolve, reject) => worker.subscribe('hydroponic/+/telemetry', (err) => err ? reject(err) : resolve()));
  const device = connect(url, { ...credentials, will: { topic: 'hydroponic/tower/status', payload: 'offline', qos: 0, retain: true } });
  clients.push(device);
  await once(device, 'connect');
  const received = once(worker, 'message');
  device.publish('hydroponic/tower/telemetry', JSON.stringify({ mode: 'MANUAL', ph: 7, relays: {} }));
  await received;
  await stop();
  assert.ok(queries.some((query) => query.text.includes('INSERT INTO telemetry_logs') && query.values[0] === 'tower'));

  await new Promise((resolve, reject) => device.publish('hydroponic/tower/status', 'online', { retain: true }, (err) => err ? reject(err) : resolve()));
  const observer = connect(url, credentials);
  clients.push(observer);
  await once(observer, 'connect');
  const retained = once(observer, 'message');
  await new Promise((resolve, reject) => observer.subscribe('hydroponic/tower/status', (err) => err ? reject(err) : resolve()));
  const [, online] = await retained;
  assert.equal(online.toString(), 'online');
  const will = once(observer, 'message');
  device.stream.destroy();
  const [, offline] = await will;
  assert.equal(offline.toString(), 'offline');
});

test('broker refuses blank credentials', async () => {
  await assert.rejects(createBroker({ port: 0, username: '', password: '' }), /credentials are required/);
});

test('HTTP relay command reaches subscribed MQTT device through broker', { timeout: 10000 }, async (t) => {
  const broker = await createBroker({ port: 0, host: '127.0.0.1', ...credentials });
  const url = `mqtt://127.0.0.1:${broker.server.address().port}`;
  const backend = connect(url, credentials);
  const device = connect(url, credentials);
  t.after(async () => {
    await Promise.all([backend, device].map((client) => new Promise((resolve) => client.end(true, resolve))));
    await broker.close();
  });
  await Promise.all([once(backend, 'connect'), once(device, 'connect')]);
  await new Promise((resolve, reject) => device.subscribe('hydroponic/tower/cmd/relay', (error) => error ? reject(error) : resolve()));
  const server = createApp({ query: async () => ({ rowCount: 1, rows: [] }) }, backend).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const message = once(device, 'message');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/devices/tower/cmd/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pump: 'pump_a', state: true, duration_ms: 5000 }),
  });
  assert.equal(response.status, 202);
  const [topic, payload] = await message;
  assert.equal(topic, 'hydroponic/tower/cmd/relay');
  assert.deepEqual(JSON.parse(payload.toString()), { pump: 'pump_a', state: true, duration_ms: 5000 });
});

test('documented publisher sends each example through broker to ingest', { timeout: 10000 }, async (t) => {
  const broker = await createBroker({ port: 0, host: '127.0.0.1', ...credentials });
  const url = `mqtt://127.0.0.1:${broker.server.address().port}`;
  const worker = connect(url, credentials);
  t.after(async () => {
    await new Promise((resolve) => worker.end(true, resolve));
    await broker.close();
  });
  await once(worker, 'connect');
  const queries = [];
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      return { rowCount: 1 };
    },
    async connect() {
      return { query: this.query, release() {} };
    },
  };
  const stop = startIngest(worker, pool);
  await new Promise((resolve, reject) => worker.subscribe('hydroponic/+/+', (error) => error ? reject(error) : resolve()));
  const received = new Promise((resolve) => {
    let count = 0;
    worker.on('message', () => { if (++count === 6) resolve(); });
  });
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const script = readme.match(/```powershell\r?\n@'\r?\n([\s\S]*?)\r?\n'@ \| node --input-type=module -/);
  assert.ok(script, 'README publisher script not found');
  const child = spawn(process.execPath, ['--input-type=module', '-'], {
    env: { ...process.env, MQTT_URL: url, MQTT_USERNAME: credentials.username, MQTT_PASSWORD: credentials.password },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  child.stdin.end(script[1]);
  assert.equal(await exit, 0, output);
  await received;
  await stop();
  assert.equal(queries.filter((query) => query.text.includes('INSERT INTO telemetry_logs')).length, 1);
  const events = queries.filter((query) => query.text.includes('INSERT INTO relay_state_logs'));
  assert.deepEqual(events.map((query) => query.values[4]), ['ON', 'OFF', 'BLOCKED']);
  assert.deepEqual(events.map((query) => query.values[5]), [true, false, false]);
  assert.deepEqual(queries.filter((query) => query.text.startsWith('UPDATE devices')).map((query) => query.values[0]), [true, false]);
});
