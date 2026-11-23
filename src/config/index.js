import 'dotenv/config';

const portText = process.env.PORT ?? '3030';
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.env.MQTT_URL) throw new Error('MQTT_URL is required');
if (!process.env.MQTT_USERNAME?.trim() || !process.env.MQTT_PASSWORD?.trim()) {
  throw new Error('MQTT_USERNAME and MQTT_PASSWORD are required for the embedded broker');
}
let mqttUrl;
try {
  mqttUrl = new URL(process.env.MQTT_URL);
} catch {
  throw new Error('MQTT_URL must be a valid local mqtt:// URL');
}
if (mqttUrl.protocol !== 'mqtt:' || !['localhost', '127.0.0.1'].includes(mqttUrl.hostname) ||
    mqttUrl.username || mqttUrl.password || !['', '/'].includes(mqttUrl.pathname) || mqttUrl.search || mqttUrl.hash) {
  throw new Error('MQTT_URL must be mqtt://localhost:port or mqtt://127.0.0.1:port without credentials');
}
const mqttPort = Number(mqttUrl.port || 1883);
if (!Number.isInteger(mqttPort) || mqttPort < 1 || mqttPort > 65535) throw new Error('Invalid MQTT port');

export const config = {
  port: Number(portText),
  databaseUrl: process.env.DATABASE_URL,
  mqttUrl: `mqtt://127.0.0.1:${mqttPort}`,
  mqttPort,
  mqttUsername: process.env.MQTT_USERNAME,
  mqttPassword: process.env.MQTT_PASSWORD,
};
