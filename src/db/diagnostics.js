export async function logDatabaseDiagnostics(pool) {
  try {
    const result = await pool.query(`
      SELECT current_database() AS database,
             current_user AS db_user,
             current_schemas(true) AS search_path,
             inet_server_addr()::text AS server_address,
             inet_server_port() AS server_port,
             to_regclass('telemetry_logs')::text AS telemetry_logs,
             to_regclass('public.telemetry_logs')::text AS public_telemetry_logs
    `);
    console.log('[PostgreSQL] Diagnostics:', JSON.stringify(result.rows[0]));
    if (!result.rows[0].telemetry_logs) {
      console.error('[PostgreSQL] telemetry_logs tidak ditemukan di search_path koneksi backend');
    }
  } catch (error) {
    console.error('[PostgreSQL] Gagal memeriksa koneksi dan tabel:', error.message);
  }
}
