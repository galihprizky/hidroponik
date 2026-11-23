import { createHash, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { Aedes } from 'aedes';

function hash(value) {
  return createHash('sha256').update(value).digest();
}

export async function createBroker({ port, username, password, host = '0.0.0.0' }) {
  if (!username?.trim() || !password?.trim()) throw new Error('MQTT broker credentials are required');
  const expectedUsername = hash(username);
  const expectedPassword = hash(password);
  const broker = await Aedes.createBroker({
    authenticate(client, suppliedUsername, suppliedPassword, callback) {
      const usernameMatches = timingSafeEqual(expectedUsername, hash(suppliedUsername ?? ''));
      const passwordMatches = timingSafeEqual(expectedPassword, hash(suppliedPassword ?? ''));
      callback(null, usernameMatches && passwordMatches);
    },
  });
  broker.on('clientError', (client, error) => console.warn('[MQTT broker] Client error:', error.message));
  broker.on('connectionError', (client, error) => console.warn('[MQTT broker] Connection error:', error.message));
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    broker.handle(socket);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await new Promise((resolve) => broker.close(resolve));
    throw error;
  }
  console.log(`[MQTT broker] Listening on ${host}:${server.address().port}`);
  return {
    server,
    close: async () => {
      const serverClosed = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await new Promise((resolve, reject) => broker.close((error) => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await serverClosed;
    },
  };
}
