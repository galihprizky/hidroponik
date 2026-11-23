import mqtt from 'mqtt';
import { config } from '../config/index.js';
import { formatMqttError } from './errors.js';

export function createMqttClient() {
  const client = mqtt.connect(config.mqttUrl, {
    username: config.mqttUsername,
    password: config.mqttPassword,
    reconnectPeriod: 5000,
    resubscribe: false,
    queueQoSZero: false,
  });
  client.on('connect', () => {
    console.log('[MQTT] Connected');
    client.subscribe(['hydroponic/+/telemetry', 'hydroponic/+/event', 'hydroponic/+/status'], { qos: 1 }, (error, granted) => {
      if (error || granted?.some((entry) => entry.qos === 128)) {
        console.error('[MQTT] Subscription failed:', error?.message ?? 'broker rejected a subscription');
        client.stream.destroy();
        return;
      }
      console.log('[MQTT] Subscribed to device topics');
    });
  });
  client.on('reconnect', () => console.log('[MQTT] Reconnecting'));
  client.on('offline', () => console.warn('[MQTT] Offline'));
  client.on('error', (error) => console.error('[MQTT] Error:', formatMqttError(error)));
  return client;
}
