import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createApp } from '../src/app.js';

async function setup(t) {
  const queries = [];
  const publications = [];
  const pool = {
    async query(text, values) {
      queries.push(typeof text === 'string' ? { text, values } : text);
      return { rows: [], rowCount: 1 };
    },
  };
  const mqtt = {
    connected: true,
    publish(topic, payload, options, callback) {
      publications.push({ topic, payload: JSON.parse(payload), options });
      callback();
    },
  };
  const server = createApp(pool, mqtt).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, queries, publications, mqtt, pool };
}

test('parameterizes filters and rejects invalid query parameters', async (t) => {
  const { base, queries } = await setup(t);
  let response = await fetch(`${base}/api/devices/tower_1/relay-logs?pump=pump_a&action=ON&limit=5&from=2026-01-01T00%3A00%3A00Z`);
  assert.equal(response.status, 200);
  assert.deepEqual(queries[0].values, ['tower_1', 'pump_a', 'ON', '2026-01-01T00:00:00Z', 5]);
  assert.match(queries[0].text, /pump = \$2/);
  response = await fetch(`${base}/api/devices/tower_1/relay-logs?pump=pump_a%27%20OR%201%3D1`);
  assert.equal(response.status, 400);
  response = await fetch(`${base}/api/devices/tower_1/telemetry?limit=0`);
  assert.equal(response.status, 400);
  response = await fetch(`${base}/api/devices/tower_1/telemetry?from=2026-01-01`);
  assert.equal(response.status, 400);
  assert.equal(queries.length, 1);
});

test('publishes valid commands and rejects ambiguous and malformed commands', async (t) => {
  const { base, publications, mqtt } = await setup(t);
  const url = `${base}/api/devices/tower_1/cmd/relay`;
  const post = (body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  let response = await post(JSON.stringify({ pump: 'pump_a', state: true, duration_ms: 1000 }));
  assert.equal(response.status, 202);
  assert.deepEqual(publications[0], {
    topic: 'hydroponic/tower_1/cmd/relay',
    payload: { pump: 'pump_a', state: true, duration_ms: 1000 },
    options: { qos: 0, retain: false },
  });
  response = await post(JSON.stringify({ all_off: true }));
  assert.equal(response.status, 202);
  response = await post(JSON.stringify({ channel: 1, pump: 'pump_b', state: true }));
  assert.equal(response.status, 400);
  response = await post('{');
  assert.equal(response.status, 400);
  mqtt.connected = false;
  response = await post(JSON.stringify({ all_off: true }));
  assert.equal(response.status, 503);
  assert.equal(publications.length, 2);
});

test('preserves relay durations as numbers without adding a default', async (t) => {
  const { base, publications } = await setup(t);
  const post = (body) => fetch(`${base}/api/devices/hydro_tower_01/cmd/relay`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const duration of [5000, '10000', 0, '4294967295']) {
    assert.equal((await post({ pump: 'pump_a', state: true, duration_ms: duration })).status, 202);
  }
  assert.equal((await post({ pump: 'pump_water', state: true })).status, 202);
  assert.deepEqual(publications.map(({ topic, payload }) => [topic, payload.duration_ms]), [
    ['hydroponic/hydro_tower_01/cmd/relay', 5000],
    ['hydroponic/hydro_tower_01/cmd/relay', 10000],
    ['hydroponic/hydro_tower_01/cmd/relay', 0],
    ['hydroponic/hydro_tower_01/cmd/relay', 4294967295],
    ['hydroponic/hydro_tower_01/cmd/relay', undefined],
  ]);
  for (const duration of [null, '', '  ', 'NaN', 'Infinity', true, [], -1, 1.5, 4294967296]) {
    assert.equal((await post({ pump: 'pump_a', state: true, duration_ms: duration })).status, 400);
  }
  assert.equal((await post({ pump: 'pump_a', state: false, duration_ms: 5000 })).status, 400);
  assert.equal(publications.length, 5);
});

test('health reports MQTT disconnection', async (t) => {
  const { base, mqtt, pool } = await setup(t);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  mqtt.connected = false;
  assert.equal((await fetch(`${base}/health`)).status, 503);
  pool.query = async () => { throw new Error('database offline'); };
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).database, 'disconnected');
});

test('serves dashboard assets without intercepting API routes', async (t) => {
  const { base } = await setup(t);
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(await index.text(), /Kontrol pompa/);
  for (const asset of ['styles.css', 'app.js']) {
    assert.equal((await fetch(`${base}/${asset}`)).status, 200);
  }
  const missing = await fetch(`${base}/api/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Not found' });
});

test('dashboard resolves assets and API requests within its deployment path', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const stylesheet = html.match(/<link[^>]+href="([^"]+)"/)[1];
  const scriptPath = html.match(/<script[^>]+src="([^"]+)"/)[1];
  const home = html.match(/<a class="brand" href="([^"]+)"/)[1];

  for (const prefix of ['/', '/monitoring-tower/']) {
    const page = `https://example.com${prefix}`;
    assert.equal(new URL(stylesheet, page).pathname, `${prefix}styles.css`);
    assert.equal(new URL(scriptPath, page).pathname, `${prefix}app.js`);
    assert.equal(new URL(home, page).pathname, prefix);

    const calls = [];
    function element() {
      return {
        value: 'hydro_tower_01', options: [{ value: 'hydro_tower_01' }],
        addEventListener() {}, setAttribute() {}, replaceChildren() {}, append() {},
        querySelector() { return element(); },
        querySelectorAll() { return [element(), element()]; },
      };
    }
    const elements = new Map();
    const document = {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
      },
      querySelectorAll() { return []; },
      createElement: element,
      createTextNode(text) { return text; },
    };
    const context = {
      document, AbortController, setTimeout, clearTimeout,
      setInterval() {}, clearInterval() {},
      fetch: async (path, options = {}) => {
        calls.push({ url: new URL(path, page), method: options.method ?? 'GET' });
        return { ok: true, status: options.method === 'POST' ? 202 : 200, json: async () => [] };
      },
    };
    runInNewContext(script, context);
    await new Promise((resolve) => setImmediate(resolve));
    await runInNewContext("sendCommand({ all_off: true }, {})", context);
    assert.deepEqual(calls.slice(0, 4).map(({ url, method }) => [method, url.pathname + url.search]), [
      ['GET', `${prefix}api/devices`],
      ['GET', `${prefix}api/devices/hydro_tower_01/telemetry?limit=1`],
      ['GET', `${prefix}api/devices/hydro_tower_01/relay-logs?limit=10`],
      ['POST', `${prefix}api/devices/hydro_tower_01/cmd/relay`],
    ]);
  }
});
