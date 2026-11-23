import { actions, command, deviceIdPattern, InputError, pumps } from '../validation.js';

function queryOptions(query, allowed) {
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.includes(key) || typeof value !== 'string') throw new InputError(`Invalid query parameter: ${key}`);
  }
  const limit = query.limit ?? '100';
  if (!/^[1-9]\d*$/.test(limit) || Number(limit) > 1000) throw new InputError('limit must be an integer between 1 and 1000');
  if (query.pump !== undefined && !pumps.includes(query.pump)) throw new InputError('Invalid pump');
  if (query.action !== undefined && !actions.includes(query.action)) throw new InputError('Invalid action');
  for (const key of ['from', 'to']) {
    if (query[key] !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(query[key]) || !Number.isFinite(Date.parse(query[key])))) {
      throw new InputError(`${key} must be an ISO 8601 timestamp with timezone`);
    }
  }
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) throw new InputError('from must be earlier than or equal to to');
  return { ...query, limit: Number(limit) };
}

function filterQuery(table, deviceId, options, ordered) {
  const values = [deviceId];
  const conditions = ['device_id = $1'];
  for (const [key, column, operator] of [
    ['pump', 'pump', '='], ['action', 'action', '='], ['from', 'recorded_at', '>='], ['to', 'recorded_at', '<='],
  ]) {
    if (options[key] !== undefined) {
      values.push(options[key]);
      conditions.push(`${column} ${operator} $${values.length}`);
    }
  }
  values.push(options.limit);
  return {
    text: `SELECT * FROM ${table} WHERE ${conditions.join(' AND ')}${ordered ? ' ORDER BY recorded_at DESC' : ''} LIMIT $${values.length}`,
    values,
  };
}

export function createDeviceController(pool, mqttClient) {
  return {
    async health(req, res) {
      let database = 'connected';
      try {
        await pool.query('SELECT 1');
      } catch (error) {
        database = 'disconnected';
        console.error('[PostgreSQL] Health check failed:', error.message);
      }
      const mqtt = mqttClient.connected ? 'connected' : 'disconnected';
      const healthy = database === 'connected' && mqtt === 'connected';
      res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'unavailable', database, mqtt });
    },
    async devices(req, res) {
      const result = await pool.query('SELECT id, device_id, name, tank_height_cm, is_online, last_seen_at, created_at FROM devices ORDER BY device_id');
      res.json(result.rows);
    },
    async telemetry(req, res) {
      const options = queryOptions(req.query, ['limit', 'from', 'to']);
      const result = await pool.query(filterQuery('telemetry_logs', req.params.deviceId, options, true));
      res.json(result.rows);
    },
    async relayLogs(req, res) {
      const options = queryOptions(req.query, ['limit', 'pump', 'action', 'from', 'to']);
      const result = await pool.query(filterQuery('relay_state_logs', req.params.deviceId, options, true));
      res.json(result.rows);
    },
    async relayRuns(req, res) {
      const options = queryOptions(req.query, ['limit', 'pump']);
      const result = await pool.query(filterQuery('v_relay_run_history', req.params.deviceId, options, false));
      res.json(result.rows);
    },
    async relayCommand(req, res) {
      const data = command(req.body);
      const result = await pool.query('SELECT 1 FROM devices WHERE device_id = $1', [req.params.deviceId]);
      if (result.rowCount !== 1) return res.status(404).json({ error: 'Device not found' });
      if (!mqttClient.connected) return res.status(503).json({ error: 'MQTT broker is not connected' });
      await new Promise((resolve, reject) => {
        mqttClient.publish(`hydroponic/${req.params.deviceId}/cmd/relay`, JSON.stringify(data), { qos: 0, retain: false }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      res.status(202).json({ status: 'published' });
    },
  };
}

export function validateDeviceId(req, res, next) {
  if (!deviceIdPattern.test(req.params.deviceId)) return next(new InputError('Invalid deviceId'));
  next();
}
