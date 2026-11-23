import pg from 'pg';
import { config } from '../config/index.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000 });
pool.on('connect', () => console.log('[PostgreSQL] Connected'));
pool.on('remove', () => console.log('[PostgreSQL] Connection closed'));
pool.on('error', (error) => console.error('[PostgreSQL] Idle client error:', error.message));
