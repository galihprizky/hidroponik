export const pumps = ['pump_a', 'pump_b', 'ph_up', 'ph_down', 'pump_water'];
export const actions = ['ON', 'OFF', 'BLOCKED'];
export const deviceIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

export function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError(`${name} must be an object`);
  }
  return value;
}

export function sensor(value, name) {
  if (value == null || value === -1 || value === 'NaN') return null;
  if (typeof value !== 'number') throw new InputError(`${name} must be a number or null`);
  return Number.isFinite(value) ? value : null;
}

export function optionalText(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > 255) {
    throw new InputError(`${name} must be a string of at most 255 characters`);
  }
  return value;
}

export function unsignedInteger(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
    throw new InputError(`${name} must be an integer between 0 and 4294967295`);
  }
  return value;
}

export function optionalUnsignedInteger(value, name) {
  if (value == null || value === 'NaN' || (typeof value === 'number' && !Number.isFinite(value))) return null;
  return unsignedInteger(value, name);
}

export function relayIdentity(channel, pump) {
  if (!Number.isInteger(channel) || channel < 1 || channel > pumps.length || pumps[channel - 1] !== pump) {
    throw new InputError('channel and pump must identify the same relay');
  }
}

export function command(body) {
  object(body, 'body');
  const allowed = ['all_off', 'pump', 'channel', 'state', 'duration_ms'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new InputError('Unknown command field');
  if (body.all_off === true) {
    if (Object.keys(body).length !== 1) throw new InputError('all_off cannot be combined with other fields');
    return { all_off: true };
  }
  if ('all_off' in body) throw new InputError('all_off must be true when provided');
  const hasPump = 'pump' in body;
  const hasChannel = 'channel' in body;
  if (hasPump === hasChannel) throw new InputError('Provide exactly one of pump or channel');
  if (hasPump && !pumps.includes(body.pump)) throw new InputError('Invalid pump');
  if (hasChannel && (!Number.isInteger(body.channel) || body.channel < 1 || body.channel > 5)) {
    throw new InputError('channel must be an integer between 1 and 5');
  }
  if (typeof body.state !== 'boolean') throw new InputError('state must be a boolean');
  if ('duration_ms' in body) {
    if (!body.state) throw new InputError('duration_ms is only valid when state is true');
    if ((typeof body.duration_ms !== 'number' && typeof body.duration_ms !== 'string')
      || (typeof body.duration_ms === 'string' && !body.duration_ms.trim())) {
      throw new InputError('duration_ms must be an integer between 0 and 4294967295');
    }
    return { ...body, duration_ms: unsignedInteger(Number(body.duration_ms), 'duration_ms') };
  }
  return body;
}
