const connectDB = require('./db');
const { getCache, setCache } = require('./cache');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

async function test() {
    await connectDB();
    console.log('MongoDB OK');

    await setCache('test:key', {hello: 'bikeclub' }, 60);
    const val = await getCache('test:key');
    console.log('Redis OK:', val);

    process.exit(0);
}

test().catch(console.error);