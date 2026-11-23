import { Router } from 'express';
import { createDeviceController, validateDeviceId } from '../controllers/devices.js';

export function createRoutes(pool, mqttClient) {
  const router = Router();
  const controller = createDeviceController(pool, mqttClient);
  const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  router.get('/health', handle(controller.health));
  router.get('/api/devices', handle(controller.devices));
  router.use('/api/devices/:deviceId', validateDeviceId);
  router.get('/api/devices/:deviceId/telemetry', handle(controller.telemetry));
  router.get('/api/devices/:deviceId/relay-logs', handle(controller.relayLogs));
  router.get('/api/devices/:deviceId/relay-runs', handle(controller.relayRuns));
  router.post('/api/devices/:deviceId/cmd/relay', handle(controller.relayCommand));
  return router;
}
