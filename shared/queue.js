const {redis} = require('./cache');

//enqueue 
async function enqueue(queueName, job) {
    job.id = Date.now();
    job.status = 'pending';
    job.createdAt = new Date().toISOString();
    await redis.lpush(queueName, JSON.stringify(job));
    console.log(`Job enqueued on ${queueName}:`, job.id);
    return job.id
}

//Dequeue
async function dequeue(queueName) {
    const data = await redis.rpop(queueName)
    return data ? JSON.parse(data) : null;
}

//Store result
async function storeResult(jobId, data, ttl = 3600) {
    await redis.set(`result:${jobId}`, JSON.stringify(data), 'EX', ttl)
}

//Get result
async function getResult(jobId) {
    const data = await redis.get(`result:${jobId}`);
    return data ? JSON.parse(data) : null;
}

async function queueSize(queueName) {
    return await redis.llen(queueName)
}

module.exports = {enqueue, dequeue, storeResult, getResult, queueSize}