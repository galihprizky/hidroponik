import { actions, deviceIdPattern, InputError, object, optionalText, optionalUnsignedInteger, pumps, relayIdentity, sensor } from '../validation.js';

function parseJson(payload) {
  try {
    return object(JSON.parse(payload.toString('utf8')), 'payload');
  } catch (error) {
    if (error instanceof SyntaxError) throw new InputError('Invalid JSON');
    throw error;
  }
}

function checkDevice(payload, deviceId) {
  if (payload.device_id !== undefined && payload.device_id !== deviceId) {
    throw new InputError('device_id does not match MQTT topic');
  }
}

function mode(payload) {
  const value = optionalText(payload.mode, 'mode');
  if (!value) throw new InputError('mode is required');
  return value;
}

async function updateDevice(db, deviceId, online) {
  const result = await db.query(
    'UPDATE devices SET is_online = $1, last_seen_at = NOW() WHERE device_id = $2 RETURNING device_id',
    [online, deviceId],
  );
  if (result.rowCount !== 1) throw new InputError(`Device ${deviceId} is not registered`);
}

async function upsertOnlineDevice(db, deviceId) {
  await db.query(
    `INSERT INTO devices (device_id, is_online, last_seen_at)
     VALUES ($1, true, NOW())
     ON CONFLICT (device_id) DO UPDATE SET is_online = true, last_seen_at = NOW()`,
    [deviceId],
  );
}

async function telemetry(pool, deviceId, payload) {
  const data = parseJson(payload);
  checkDevice(data, deviceId);
  const relays = object(data.relays, 'relays');
  if (Object.entries(relays).some(([key, value]) => !pumps.includes(key) || typeof value !== 'boolean')) {
    throw new InputError('relays must contain only known pumps with boolean values');
  }
  const fields = ['ph', 'ph_mv', 'ppm', 'ec', 'ec_mv', 'water_temp_c', 'water_level_cm', 'distance_cm'];
  const values = fields.map((field) => {
    const value = sensor(data[field], field);
    if ((field === 'water_level_cm' || field === 'distance_cm') && value !== null && value < 0) return null;
    return value;
  });
  const uptime = optionalUnsignedInteger(data.uptime_ms, 'uptime_ms');
  const deviceMode = mode(data);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await upsertOnlineDevice(client, deviceId);
    await client.query(
      `INSERT INTO telemetry_logs
       (device_id, mode, uptime_ms, ph, ph_mv, ppm, ec, ec_mv, water_temp_c, water_level_cm, distance_cm, relays, recorded_at)
       VALUES ($1::text, $2::text, $3::bigint, $4::numeric, $5::numeric, $6::numeric,
               $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11::numeric, $12::jsonb, NOW())`,
      [deviceId, deviceMode, uptime, ...values, JSON.stringify(relays)],
    );
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('[PostgreSQL] Rollback failed:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function event(pool, deviceId, payload) {
  const data = parseJson(payload);
  checkDevice(data, deviceId);
  relayIdentity(data.channel, data.pump);
  if (!actions.includes(data.action)) throw new InputError('Invalid relay action');
  const suffix = data.action === 'OFF' ? 'after' : 'before';
  const duration = data.action === 'OFF' ? optionalUnsignedInteger(data.duration_ms, 'duration_ms') : null;
  const isActive = data.action === 'ON';
  const reference = (field) => {
    if (data.action === 'BLOCKED') return data[`${field}_before`] ?? data[`${field}_after`];
    return data[`${field}_${suffix}`];
  };
  const water = reference('water') ?? reference('water_level');
  const result = await pool.query(
    `INSERT INTO relay_state_logs
     (device_id, mode, channel, pump, action, is_active, source, reason, duration_ms, ph_ref, ppm_ref, water_temp_ref, water_level_ref, recorded_at)
     SELECT $1::text, $2::text, $3::integer, $4::text, $5::text, $6::boolean,
            $7::text, $8::text, $9::bigint, $10::numeric, $11::numeric, $12::numeric, $13::numeric, NOW()
     WHERE EXISTS (SELECT 1 FROM devices WHERE device_id = $1::text)`,
    [deviceId, mode(data), data.channel, data.pump, data.action, isActive,
      optionalText(data.source, 'source'), optionalText(data.reason, 'reason'), duration,
      sensor(reference('ph'), 'ph_ref'),
      sensor(reference('ppm'), 'ppm_ref'),
      sensor(reference('water_temp'), 'water_temp_ref'),
      sensor(water, 'water_level_ref')],
  );
  if (result.rowCount !== 1) throw new InputError(`Device ${deviceId} is not registered`);
}

export async function ingest(pool, topic, payload) {
  const parts = topic.split('/');
  if (parts.length !== 3 || parts[0] !== 'hydroponic' || !deviceIdPattern.test(parts[1])) {
    throw new InputError('Invalid MQTT topic');
  }
  const [, deviceId, kind] = parts;
  if (kind === 'telemetry') return telemetry(pool, deviceId, payload);
  if (kind === 'event') return event(pool, deviceId, payload);
  if (kind === 'status') {
    const status = payload.toString('utf8').trim();
    if (status !== 'online' && status !== 'offline') throw new InputError('Invalid status');
    return updateDevice(pool, deviceId, status === 'online');
  }
  throw new InputError('Unknown MQTT topic');
}

export function startIngest(client, pool) {
  const pending = new Map();
  const onMessage = (topic, payload) => {
    const device = topic.split('/')[1];
    const previous = pending.get(device) ?? Promise.resolve();
    const task = previous.then(() => ingest(pool, topic, payload)).catch((error) => {
      console.error(`[MQTT] Failed to ingest ${topic}:`, error.message);
    });
    pending.set(device, task);
    task.then(() => {
      if (pending.get(device) === task) pending.delete(device);
    });
  };
  client.on('message', onMessage);
  return async () => {
    client.removeListener('message', onMessage);
    await Promise.all(pending.values());
  };
}
