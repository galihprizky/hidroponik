import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMqttError } from '../src/mqtt/errors.js';

test('reports individual connection failures from an AggregateError with an empty message', () => {
  const ipv6 = Object.assign(new Error('connect ECONNREFUSED ::1:1883'), { code: 'ECONNREFUSED' });
  const ipv4 = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1883'), { code: 'ECONNREFUSED' });
  const error = Object.assign(new AggregateError([ipv6, ipv4]), { code: 'ECONNREFUSED' });
  assert.match(formatMqttError(error), /ECONNREFUSED.*::1:1883.*127\.0\.0\.1:1883/);
});

test('reports ordinary errors and errors without messages', () => {
  assert.equal(formatMqttError(new Error('Connection refused: Not authorized')), 'Connection refused: Not authorized');
  assert.equal(formatMqttError(Object.assign(new Error(), { code: 'ECONNRESET' })), 'ECONNRESET');
});
