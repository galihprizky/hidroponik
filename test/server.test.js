import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function unusedPort() {
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('starts embedded broker, reports database unhealthy, and handles shutdown', { timeout: 15000 }, async (t) => {
  const port = await unusedPort();
  const mqttPort = await unusedPort();

  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "await import('./src/server.js'); process.on('message', () => { process.emit('SIGTERM'); process.disconnect(); });"], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test', MQTT_URL: `mqtt://127.0.0.1:${mqttPort}`, MQTT_USERNAME: 'test-user', MQTT_PASSWORD: 'test-password' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 8000);
    const check = () => {
      if (output.includes('[HTTP] Listening') && output.includes('[MQTT] Subscribed')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early (${code}): ${output}`));
    });
    check();
  });
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unavailable', database: 'disconnected', mqtt: 'connected' });
  child.send('shutdown');
  assert.equal(await exit, 0, output);
  assert.match(output, /Shutdown complete/);
  assert.match(output, /Gagal memeriksa koneksi dan tabel/);
});

test('shuts down broker if HTTP port is already in use', { timeout: 10000 }, async (t) => {
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const mqttPort = await unusedPort();
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(occupied.address().port), DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
      MQTT_URL: `mqtt://127.0.0.1:${mqttPort}`, MQTT_USERNAME: 'test-user', MQTT_PASSWORD: 'test-password' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 1, output);
  assert.match(output, /EADDRINUSE/);
  assert.match(output, /Shutdown complete/);
});
