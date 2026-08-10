import { RedisMemoryServer } from 'redis-memory-server';

const redisServer = new RedisMemoryServer({ instance: { port: 6399 } });
const host = await redisServer.getHost();
const port = await redisServer.getPort();
console.log(`REDIS_READY redis://${host}:${port}`);

process.on('SIGTERM', async () => {
  await redisServer.stop();
  process.exit(0);
});
