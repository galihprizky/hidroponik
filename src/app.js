import express from 'express';
import { fileURLToPath } from 'node:url';
import { createRoutes } from './routes/index.js';
import { InputError } from './validation.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

export function createApp(pool, mqttClient) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(createRoutes(pool, mqttClient));
  app.use(express.static(publicDir));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, req, res, next) => {
    if (error instanceof InputError) return res.status(400).json({ error: error.message });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'JSON body is too large' });
    console.error('[HTTP] Request failed:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
