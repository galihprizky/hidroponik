import test from 'node:test';
import assert from 'node:assert/strict';
import { logDatabaseDiagnostics } from '../src/db/diagnostics.js';

test('logs connection details and warns when telemetry table is outside the search path', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const details = {
    database: 'hydroponic', db_user: 'app', search_path: ['pg_catalog', 'private'],
    server_address: '127.0.0.1', server_port: 5432,
    telemetry_logs: null, public_telemetry_logs: 'public.telemetry_logs',
  };
  await logDatabaseDiagnostics({
    async query(sql) {
      assert.match(sql, /to_regclass\('telemetry_logs'\)/);
      return { rows: [details] };
    },
  });
  assert.deepEqual(log.mock.calls[0].arguments, ['[PostgreSQL] Diagnostics:', JSON.stringify(details)]);
  assert.match(error.mock.calls[0].arguments[0], /tidak ditemukan/);
});

test('reports database diagnostic failures without stopping startup', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  await logDatabaseDiagnostics({ async query() { throw new Error('connection refused'); } });
  assert.deepEqual(error.mock.calls[0].arguments, [
    '[PostgreSQL] Gagal memeriksa koneksi dan tabel:', 'connection refused',
  ]);
});
