import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ingest, startIngest } from '../src/mqtt/ingest.js';

function fakePool() {
  const calls = [];
  const query = async (text, values) => {
    calls.push({ text, values });
    return { rowCount: 1, rows: [] };
  };
  return { calls, query, async connect() { return { query, release() {} }; } };
}
const message = (value) => Buffer.from(JSON.stringify(value));

test('telemetry saves temperature, normalizes invalid readings, and updates device atomically', async () => {
  const pool = fakePool();
  await ingest(pool, 'hydroponic/tower_1/telemetry', message({
    device_id: 'tower_1', mode: 'MANUAL', uptime_ms: 20, ph: 7,
    water_temp_c: 25.3, water_level_cm: -0.5, distance_cm: -2, relays: { pump_a: false },
  }));
  assert.equal(pool.calls[0].text, 'BEGIN');
  assert.match(pool.calls[1].text, /INSERT INTO devices/);
  assert.match(pool.calls[1].text, /ON CONFLICT \(device_id\) DO UPDATE SET is_online = true/);
  assert.deepEqual(pool.calls[1].values, ['tower_1']);
  const insert = pool.calls[2];
  assert.equal(insert.values[8], 25.3);
  assert.equal(insert.values[9], null);
  assert.equal(insert.values[10], null);
  assert.deepEqual(JSON.parse(insert.values[11]), { pump_a: false });
  assert.equal(pool.calls[3].text, 'COMMIT');
});

test('telemetry preserves zero readings and normalizes missing and invalid temperature', async () => {
  const pool = fakePool();
  const base = { mode: 'MANUAL', water_level_cm: 0, distance_cm: 0, relays: {} };
  await ingest(pool, 'hydroponic/tower_1/telemetry', message(base));
  await ingest(pool, 'hydroponic/tower_1/telemetry', message({ ...base, water_temp_c: 'NaN', water_level_cm: null, distance_cm: 'NaN' }));
  await ingest(pool, 'hydroponic/tower_1/telemetry', message({ ...base, water_temp_c: null }));
  const inserts = pool.calls.filter((call) => call.text.includes('INSERT INTO telemetry_logs'));
  assert.deepEqual(inserts[0].values.slice(8, 11), [null, 0, 0]);
  assert.deepEqual(inserts[1].values.slice(8, 11), [null, null, null]);
  assert.equal(inserts[2].values[8], null);
});

test('normalizes missing and NaN telemetry fields and uses explicit database types', async () => {
  const pool = fakePool();
  await ingest(pool, 'hydroponic/tower_1/telemetry', message({
    mode: 'MANUAL', uptime_ms: 'NaN', water_temp_c: 'NaN', relays: {},
  }));
  const insert = pool.calls[2];
  assert.equal(insert.values[2], null);
  assert.deepEqual(insert.values.slice(3, 11), Array(8).fill(null));
  assert.match(insert.text, /\$3::bigint/);
  assert.match(insert.text, /\$9::numeric/);
  await ingest(pool, 'hydroponic/tower_1/telemetry', message({
    mode: 'MANUAL', uptime_ms: 4294967295, water_temp_c: 0, relays: {},
  }));
  assert.equal(pool.calls[6].values[2], 4294967295);
  assert.equal(pool.calls[6].values[8], 0);
});

test('relay event maps references by action, including firmware water alias', async () => {
  const pool = fakePool();
  const data = { mode: 'MANUAL', channel: 1, pump: 'pump_a', ph_before: 6, ph_after: 7,
    ppm_before: 500, ppm_after: 600, water_temp_before: 24, water_temp_after: 25,
    water_before: 30, water_after: 35, water_level_after: 99 };
  await ingest(pool, 'hydroponic/tower_1/event', message({ ...data, action: 'ON', duration_ms: 123 }));
  await ingest(pool, 'hydroponic/tower_1/event', message({ ...data, action: 'OFF', duration_ms: 456 }));
  await ingest(pool, 'hydroponic/tower_1/event', message({ ...data, action: 'BLOCKED', reason: 'WATER_TOO_LOW' }));
  assert.match(pool.calls[0].text, /SELECT \$1::text,/);
  assert.match(pool.calls[0].text, /WHERE device_id = \$1::text/);
  assert.deepEqual(pool.calls[0].values.slice(9), [6, 500, 24, 30]);
  assert.deepEqual(pool.calls[1].values.slice(9), [7, 600, 25, 35]);
  assert.equal(pool.calls[0].values[5], true);
  assert.equal(pool.calls[0].values[8], null);
  assert.equal(pool.calls[1].values[5], false);
  assert.equal(pool.calls[1].values[8], 456);
  assert.equal(pool.calls[2].values[5], false);
  assert.equal(pool.calls[2].values[7], 'WATER_TOO_LOW');
  assert.deepEqual(pool.calls[2].values.slice(9), [6, 500, 24, 30]);
});

test('blocked event accepts after references if before references are absent', async () => {
  const pool = fakePool();
  await ingest(pool, 'hydroponic/tower_1/event', message({
    mode: 'MANUAL', channel: 1, pump: 'pump_a', action: 'BLOCKED',
    ph_after: 7, ppm_after: 600, water_temp_after: 25, water_after: 35,
  }));
  assert.deepEqual(pool.calls[0].values.slice(9), [7, 600, 25, 35]);
});

test('normalizes NaN and missing event fields while preserving large durations', async () => {
  const pool = fakePool();
  const base = { mode: 'MANUAL', channel: 1, pump: 'pump_a' };
  await ingest(pool, 'hydroponic/tower_1/event', message({ ...base, action: 'ON', duration_ms: 5000, water_temp_before: 'NaN' }));
  await ingest(pool, 'hydroponic/tower_1/event', message({ ...base, action: 'OFF', duration_ms: 'NaN' }));
  await ingest(pool, 'hydroponic/tower_1/event', message({ ...base, action: 'OFF', duration_ms: 4294967295 }));
  assert.deepEqual(pool.calls[0].values.slice(6), [null, null, null, null, null, null, null]);
  assert.equal(pool.calls[1].values[8], null);
  assert.equal(pool.calls[2].values[8], 4294967295);
  assert.match(pool.calls[0].text, /\$6::boolean/);
  assert.match(pool.calls[0].text, /\$9::bigint/);
  assert.match(pool.calls[0].text, /\$12::numeric/);
});

test('rejects invalid JSON, mismatched device and relay, and unknown status', async () => {
  const pool = fakePool();
  await assert.rejects(ingest(pool, 'hydroponic/tower_1/event', Buffer.from('{')), /Invalid JSON/);
  await assert.rejects(ingest(pool, 'hydroponic/tower_1/event', message({ device_id: 'other' })), /does not match/);
  await assert.rejects(ingest(pool, 'hydroponic/tower_1/event', message({ channel: 1, pump: 'pump_b' })), /same relay/);
  await assert.rejects(ingest(pool, 'hydroponic/tower_1/status', Buffer.from('maybe')), /Invalid status/);
  assert.equal(pool.calls.length, 0);
});

test('telemetry rolls back when insert fails', async () => {
  const pool = fakePool();
  const query = pool.query;
  pool.connect = async () => ({
    async query(text, values) {
      if (text.startsWith('INSERT')) throw new Error('insert failed');
      return query(text, values);
    },
    release() {},
  });
  await assert.rejects(ingest(pool, 'hydroponic/tower_1/telemetry', message({ mode: 'MANUAL', relays: {} })), /insert failed/);
  assert.equal(pool.calls.at(-1).text, 'ROLLBACK');
});

test('processes messages from a device in arrival order and drains on shutdown', async () => {
  const client = new EventEmitter();
  const pool = fakePool();
  const stop = startIngest(client, pool);
  client.emit('message', 'hydroponic/tower_1/status', Buffer.from('online'));
  client.emit('message', 'hydroponic/tower_1/status', Buffer.from('offline'));
  await stop();
  assert.deepEqual(pool.calls.map((call) => call.values[0]), [true, false]);
});
