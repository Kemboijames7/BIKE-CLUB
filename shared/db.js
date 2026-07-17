const mongoose = require('mongoose');
const dns = require('dns');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '8.8.4.4']);

let isConnected = false;

async function connectDB() {
    if (isConnected) return;

    try {
        await mongoose.connect(process.env.MONGO_URI);
        isConnected = true;
        console.log('MongoDB connected');
    } catch (err) {
        console.error('MongoDB connection failed:', err.message);
        process.exit(1);
    }
}

module.exports = connectDB;