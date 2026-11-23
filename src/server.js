import { config } from './config/index.js';
import { pool } from './db/index.js';
import { createMqttClient } from './mqtt/client.js';
import { createBroker } from './mqtt/broker.js';
import { startIngest } from './mqtt/ingest.js';
import { createApp } from './app.js';

const broker = await createBroker({
  port: config.mqttPort,
  username: config.mqttUsername,
  password: config.mqttPassword,
});
const mqttClient = createMqttClient();
const stopIngest = startIngest(mqttClient, pool);
const server = createApp(pool, mqttClient).listen(config.port, () => {
  console.log(`[HTTP] Listening on port ${config.port}`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[Server] ${signal}: shutting down`);
  const deadline = setTimeout(() => {
    console.error('[Server] Shutdown timed out');
    server.closeAllConnections();
    mqttClient.end(true);
    process.exitCode = 1;
  }, 10000);
  deadline.unref();
  let failed = false;
  for (const close of [
    () => new Promise((resolve, reject) => server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    })),
    () => new Promise((resolve, reject) => mqttClient.end(false, {}, (error) => error ? reject(error) : resolve())),
    stopIngest,
    () => broker.close(),
    () => pool.end(),
  ]) {
    try {
      await close();
    } catch (error) {
      failed = true;
      console.error('[Server] Shutdown step failed:', error.message);
    }
  }
  if (failed) process.exitCode = 1;
  else console.log('[Server] Shutdown complete');
  clearTimeout(deadline);
}

server.on('error', (error) => {
  console.error('[HTTP] Server error:', error.message);
  process.exitCode = 1;
  void shutdown('HTTP error');
});
broker.server.on('error', (error) => {
  console.error('[MQTT broker] Server error:', error.message);
  process.exitCode = 1;
  void shutdown('MQTT broker error');
});
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
