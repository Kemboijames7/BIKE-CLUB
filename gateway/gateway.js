const express = require ('express');
const httpProxy = require('http-proxy');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { error } = require('console');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const proxy = httpProxy.createProxyServer({});

const GATEWAY_PORT = process.env.GATEWAY_PORT || PORT

// -- Backend services

 const services = {
    auth:      process.env.AUTH_SERVICE_URL,
    members:   process.env.MEMBER_SERVICE_URL,
    events:    process.env.EVENT_SERVICE_URL,
    vouchers:  process.env.VOUCHER_SERVICE_URL,
    payments:  process.env.PAYMENT_SERVICE_URL,
    chat:      process.env.CHAT_SERVICE_URL,
    newsletter: process.env.NEWSLETTER_SERVICE_URL, 
 };
// -- Load balancer pool for main app

const appServers = [
    { url: process.env.MEMBER_SERVICE_URL, healthy: true, requests: 0 },
    { url: process.env.EVENT_SERVICE_URL,  healthy: true, requests: 0 }
];

let currentIndex = 0;

function getNextServer(pool) {
    const healthy = pool.filter(s => s.healthy);
    if (healthy.length === 0) return null;
    const server = healthy[currentIndex % healthy.length];
    currentIndex++;
    server.requests++;
    return server;
}

//--Logging

const logStream = fs.createWriteStream(
    path.join(__dirname, 'gateway.log'),
{ flags: 'a'}
);

app.use(morgan('dev'));
app.use(morgan(
    ':date[iso] :method :url :status :response-time ms :remote-addr',
    { stream: logStream}
));

//Rate limiting
const paymentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    handler: (req, res) => {
        console.log(`Rate limit exceeded: ${req.ip}`);
        res.status(429).json({
            error: 'Too many requests',
            message: 'Max 5 requests per minute',
            retryAfter: '60 seconds'
        });  
    }
});


const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 10,                    // 10 login attempts
    message: { error: 'Too many login attempts', retryAfter: '15 minutes' }
});

const resetPasswordLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,  // 1 hour
    max: 3,                     // Only 3 reset attempts per hour
    message: { error: 'Too many password reset attempts' }
})


app.use('/payments/mpesa', paymentLimiter);
app.use('/payments/stripe', paymentLimiter);
app.use('/auth/login', authLimiter);
app.use('/auth/register', authLimiter);
app.use('/forgot-password', resetPasswordLimiter);
app.use('/reset-password', resetPasswordLimiter);
//Auth middleware

const publicRoutes = [
    {path: '/auth/register', method: 'POST' },
    {path: '/auth/login', method: 'POST' },
    {path: '/health', method: 'GET' },
    {Path: '/gateway/stats', method: 'GET' },
    {path:'/events', method: 'GET' },
    {path: '/payments/webhook/stripe', method: 'POST' }, 
    {path: '/payments/webhook/mpesa', method: 'POST' }, 
    { path: '/newsletter/subscribe', method: 'POST' },
    { path: '/newsletter/unsubscribe', method: 'GET' },
];

// ── Must be defined BEFORE authMiddleware ─────────────────
function isPublicRoute(req) {
    return publicRoutes.some(route =>
        req.path === route.path && req.method === route.method
    );
}

async function authMiddleware(req, res, next) {
console.log('Path:', req.path, '| Method:', req.method);
    console.log('Is public:', isPublicRoute(req));

    if (isPublicRoute(req)) return next();

    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({error: 'Authentication required' });
    }
    
    try {
        const { data } = await axios.get(`${services.auth}/auth/validate`, {
            headers: { authorization: `Bearer ${token}` }
        });

        if (!data.valid) {
            return res.status(401).json({ error: 'Invalid token'});
        }

        //Forward user info to downstream services
        req.headers['x-user-id'] = data.user.id;
        req.headers['x-user-role'] = data.user.role;
        req.headers['x-user-email'] = data.user.email;

        next();

    } catch (err) {
        return res.status(401).json({ error: 'Authentication failed'});
    }
}

app.use(authMiddleware);

//Health check

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'gateway', port: GATEWAY_PORT });
})


//Gateway stats
app.get('/gateway/stats', (req, res) => {
    res.json({
        services,
        loadBalancer: appServers.map(s => ({
            url: s.url,
            healthy: s.healthy,
            requests: s.requests
        })),
        healthyServers: appServers.filter(s => s.healthy).length
    });
});

//proxy error handler

proxy.on('error', (err, req, res) => {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Service unavailable' });
    
});

//Route requests to correct service
app.use((req, res) => {
    let target;

    if (req.path.startsWith('/auth'))     target = services.auth;
    else if (req.path.startsWith('/members'))  target = services.members;
    else if (req.path.startsWith('/events'))   target = services.events;
    else if (req.path.startsWith('/vouchers')) target = services.vouchers;
    else if (req.path.startsWith('/payments')) target = services.payments;
    else if (req.path.startsWith('/chat'))     target = services.chat;
    else if (req.path.startsWith('/newsletter')) target = services.newsletter;
    else {
return res.status(404).json({ error: 'Route not found' });

}

console.log(`→ ${req.method} ${req.path} → ${target}`);
proxy.web(req, res, { target });
});


// --Health check all services every 30 secs
async function checkHealth() {
    for  (const [name, url] of Object.entries(services)) {
        try {
            await axios.get(`${url}/health`, { timeout: 3000 });
            console.log(`✅ ${name} service healthy`);
        } catch {
            console.warn(`❌ ${name} service unreachable`);
        }
    }
}

setInterval(checkHealth, 30000)
//Start gateway

app.listen(GATEWAY_PORT, () => {
    console.log(`API Gateway running on port ${GATEWAY_PORT}`);
    console.log(`Routing to: ${Object.keys(services).join(', ')}`);
    checkHealth()
})