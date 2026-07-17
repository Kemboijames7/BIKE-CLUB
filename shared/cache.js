const Redis = require('ioredis');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379
});

redis.on('connect', () => console.log('Redis connected'));
redis.on('error', (err) => console.log('Redis error:', err.message));

//GET
async function getCache(key) {
    const data = await redis.get(key);
   return data ? JSON.parse(data) : null;
}

//SET
async function setCache(key, value, ttl = 3600) {
    await redis.set(key, JSON.stringify(value), 'EX', ttl);
}

// ── Delete ────────────────────────────────────────────────
async function deleteCache(key) {
    await redis.del(key);
}

// ── Flush pattern ─────────────────────────────────────────
async function flushPattern(pattern) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
    console.log(`Flushed ${keys.length} keys matching: ${pattern}`);
}

module.exports = { redis, getCache, setCache, deleteCache, flushPattern };
