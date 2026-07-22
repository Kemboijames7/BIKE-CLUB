const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const connectDB = require('../../shared/db');
const { redis } = require('../../shared/cache');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const ContactMessage = require('../../shared/models/Message');
// ── Validate required env vars on startup ─────────────────
const REQUIRED_ENV = [
    'MONGO_URI',
    'JWT_SECRET',
    'AUTH_SERVICE_URL',
    'MEMBER_SERVICE_URL',
    'EVENT_SERVICE_URL',
    'VOUCHER_SERVICE_URL',
    'PAYMENT_SERVICE_URL',
    'CHAT_SERVICE_URL',
    'NOTIFICATION_SERVICE_URL'
];

const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length > 0) {
    console.error('Missing required environment variables:', missing.join(', '));
    process.exit(1);
}

// ── Service URLs ──────────────────────────────────────────
const SERVICES = {
    auth:          process.env.AUTH_SERVICE_URL,
    members:       process.env.MEMBER_SERVICE_URL,
    events:        process.env.EVENT_SERVICE_URL,
    vouchers:      process.env.VOUCHER_SERVICE_URL,
    payments:      process.env.PAYMENT_SERVICE_URL,
    chat:          process.env.CHAT_SERVICE_URL,
    notifications: process.env.NOTIFICATION_SERVICE_URL,
    message:       process.env.MESSAGE_SERVICE_URL,
    newsletter:    process.env.NEWSLETTER_SERVICE_URL
};

const app = express();
const PORT = process.env.ADMIN_PORT || 4008;

// ── Middleware — order matters ────────────────────────────
app.use(cookieParser());                        // must be before any route reads cookies
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth middleware ───────────────────────────────────────
async function adminAuth(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1] ||
                  req.cookies?.token;           // cookie only — no query token needed anymore

    if (!token) return res.redirect('/admin/login');

    try {
        const { data } = await axios.get(
            `${SERVICES.auth}/auth/validate`,
            { headers: { authorization: `Bearer ${token}` } }
        );

        if (!data.valid || data.user.role !== 'admin') {
            return res.redirect('/admin/login');
        }

        req.user  = data.user;
        req.token = token;
        next();
    } catch (err) {
        console.error('adminAuth error:', err.message);
        res.redirect('/admin/login');
    }
}

// ── callService — GET ─────────────────────────────────────
async function callService(url, token) {
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const { data } = await axios.get(url, {
            headers: {
                authorization:  `Bearer ${token}`,
                'x-user-id':    decoded.id,
                'x-user-role':  decoded.role,
                'x-user-email': decoded.email
            }
        });
        return data;
    } catch (err) {
        console.error('Service call failed:', url, err.message);
        return null;
    }
}

// ── callServiceMutate — POST / PATCH / DELETE ─────────────
async function callServiceMutate(method, url, token, user, body = {}) {
    try {
        const headers = {
            authorization:  `Bearer ${token}`,
            'x-user-id':    user.id,
            'x-user-role':  user.role,
            'x-user-email': user.email
        };
        if (method === 'delete') {
            await axios.delete(url, { headers });
        } else if (method === 'patch') {
            await axios.patch(url, body, { headers });
        } else {
            await axios.post(url, body, { headers });
        }
        return { error: null };
    } catch (err) {
        console.error(`${method.toUpperCase()} failed:`, url, err.message);
        return { error: err.response?.data?.error || err.message };
    }
}

// ── Health check helper ───────────────────────────────────
async function isHealthy(url) {
    try {
        await axios.get(`${url}/health`, { timeout: 2000 });
        return true;
    } catch {
        return false;
    }
}

// ── Login ─────────────────────────────────────────────────
app.get('/admin/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/admin/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data } = await axios.post(
            `${SERVICES.auth}/auth/login`,
            { email, password }
        );

        if (data.user.role !== 'admin') {
            return res.render('login', { error: 'Admin access required' });
        }

        res.cookie('token', data.token, {
            httpOnly: true,
            maxAge: 7 * 24 * 60 * 60 * 1000    // 7 days
        });
        res.redirect('/admin/dashboard');        // clean URL, no token exposed
    } catch (err) {
        console.error('Login error:', err.message);
        res.render('login', { error: 'Invalid credentials' });
    }
});

// ── Logout ────────────────────────────────────────────────
app.get('/admin/logout', (req, res) => {
    res.clearCookie('token');
    res.redirect('/admin/login');
});

// ── Dashboard ─────────────────────────────────────────────
app.get('/admin/dashboard', adminAuth, async (req, res) => {
    try {
        const token = req.token;

        const [membersData, eventsData, vouchersData, paymentsData] = await Promise.all([
            callService(`${SERVICES.members}/members`, token),
            callService(`${SERVICES.events}/events`, token),
            callService(`${SERVICES.vouchers}/vouchers`, token),
            callService(`${SERVICES.payments}/payments`, token)
        ]);

        const redisInfo  = await redis.info('memory');
        const usedMemory = redisInfo.match(/used_memory_human:(\S+)/)?.[1] || 'N/A';
        const queueSize  = await redis.llen('notifications');

        const stats = {
            members: {
                total:     membersData?.members?.length || 0,
                active:    membersData?.members?.filter(m => m.membershipStatus === 'active').length || 0,
                suspended: membersData?.members?.filter(m => m.membershipStatus === 'suspended').length || 0
            },
            events: {
                total:    eventsData?.pagination?.total || 0,
                upcoming: eventsData?.events?.filter(e => e.status === 'upcoming').length || 0,
                ongoing:  eventsData?.events?.filter(e => e.status === 'ongoing').length || 0
            },
            vouchers: {
                total:   vouchersData?.pagination?.total || 0,
                active:  vouchersData?.vouchers?.filter(v => v.status === 'active').length || 0,
                used:    vouchersData?.vouchers?.filter(v => v.status === 'used').length || 0,
                revoked: vouchersData?.vouchers?.filter(v => v.status === 'revoked').length || 0
            },
            payments: {
                total:     paymentsData?.pagination?.total || 0,
                completed: paymentsData?.payments?.filter(p => p.status === 'completed').length || 0,
                pending:   paymentsData?.payments?.filter(p => p.status === 'pending').length || 0,
                revenue:   paymentsData?.payments
                    ?.filter(p => p.status === 'completed')
                    ?.reduce((sum, p) => sum + p.amount, 0) || 0
            },
            system: {
                redisMemory:       usedMemory,
                notificationQueue: queueSize,
                services: {
                    auth:          await isHealthy(SERVICES.auth),
                    members:       await isHealthy(SERVICES.members),
                    events:        await isHealthy(SERVICES.events),
                    vouchers:      await isHealthy(SERVICES.vouchers),
                    payments:      await isHealthy(SERVICES.payments),
                    chat:          await isHealthy(SERVICES.chat),
                    notifications: await isHealthy(SERVICES.notifications)
                }
            }
        };
const unreadMessages = await ContactMessage.countDocuments({ read: false });
        res.render('dashboard', {
            user:     req.user,
            token,
            stats,
            members:  membersData?.members   || [],
            events:   eventsData?.events     || [],
            vouchers: vouchersData?.vouchers || [],
            payments: paymentsData?.payments || [],
            unreadMessages
        });

    } catch (err) {
        console.error('Dashboard error:', err.message);
        res.status(500).send('Dashboard failed');
    }
});

// ── Members ───────────────────────────────────────────────
app.get('/admin/members', adminAuth, async (req, res) => {
    const data = await callService(`${SERVICES.members}/members`, req.token);
    res.render('members', {
        user:    req.user,
        token:   req.token,
        members: data?.members || []
    });
});

app.post('/admin/members/:id/suspend', adminAuth, async (req, res) => {
    await callServiceMutate('patch',
        `${SERVICES.members}/members/${req.params.id}/suspend`,
        req.token, req.user
    );
    res.redirect('/admin/members');
});

app.post('/admin/members/:id/activate', adminAuth, async (req, res) => {
    await callServiceMutate('patch',
        `${SERVICES.members}/members/${req.params.id}/activate`,
        req.token, req.user
    );
    res.redirect('/admin/members');
});

// ── Events ────────────────────────────────────────────────
app.get('/admin/events', adminAuth, async (req, res) => {
    const data = await callService(`${SERVICES.events}/events`, req.token);
    res.render('events', {
        user:   req.user,
        token:  req.token,
        events: data?.events || [],
        error:  req.query.error || null
    });
});

app.post('/admin/events', adminAuth, async (req, res) => {    // duplicate removed — one route only
    const { error } = await callServiceMutate('post',
        `${SERVICES.events}/events`,
        req.token, req.user, req.body
    );
    if (error) {
        return res.redirect(`/admin/events?error=${encodeURIComponent(error)}`);
    }
    res.redirect('/admin/events');
});

app.post('/admin/events/:id/cancel', adminAuth, async (req, res) => {
    await callServiceMutate('delete',
        `${SERVICES.events}/events/${req.params.id}`,
        req.token, req.user
    );
    res.redirect('/admin/events');
});

// ── Vouchers ──────────────────────────────────────────────
app.get('/admin/vouchers', adminAuth, async (req, res) => {
    const data = await callService(`${SERVICES.vouchers}/vouchers`, req.token);
    res.render('vouchers', {
        user:       req.user,
        token:      req.token,
        vouchers:   data?.vouchers   || [],
        pagination: data?.pagination || {},
        success:    req.query.success || null,
        error:      req.query.error   || null,
        query:      req.query.status  || 'all'
    });
});

app.post('/admin/vouchers/:code/revoke', adminAuth, async (req, res) => {
    await callServiceMutate('delete',
        `${SERVICES.vouchers}/vouchers/${req.params.code}`,
        req.token, req.user
    );
    res.redirect('/admin/vouchers');
});

app.post('/admin/vouchers/:code/reinstate', adminAuth, async (req, res) => {
    await callServiceMutate('patch',
        `${SERVICES.vouchers}/vouchers/${req.params.code}/reinstate`,
        req.token, req.user
    );
    res.redirect('/admin/vouchers');
});

app.post('/admin/vouchers/:code/expire', adminAuth, async (req, res) => {
    await callServiceMutate('patch',
        `${SERVICES.vouchers}/vouchers/${req.params.code}/expire`,
        req.token, req.user
    );
    res.redirect('/admin/vouchers?success=Voucher expired');
});

// ── Payments ──────────────────────────────────────────────
app.get('/admin/payments', adminAuth, async (req, res) => {
    const data = await callService(`${SERVICES.payments}/payments`, req.token);
    res.render('payments', {
        user:       req.user,
        token:      req.token,
        payments:   data?.payments   || [],
        pagination: data?.pagination || {}
    });
});

// ── Newsletter management ─────────────────────────────────
app.get('/admin/newsletter', adminAuth, async (req, res) => {
    const [subsData, statsData] = await Promise.all([
        callService('http://localhost:4009/newsletter/subscribers', req.token),
        callService('http://localhost:4009/newsletter/stats', req.token)
    ]);

    res.render('newsletter', {
        user: req.user,
        token: req.token,
        subscribers: subsData?.subscribers || [],
        stats: statsData || { subscribed: 0, unsubscribed: 0, total: 0 }
    });
});

app.post('/admin/newsletter/send', adminAuth, async (req, res) => {
    try {
        const { data } = await axios.post(
            'http://localhost:4009/newsletter/send',
            req.body,
            { headers: {
                authorization: `Bearer ${req.token}`,
                'x-user-role': 'admin',
                'x-user-id': req.user.id,
                'x-user-email': req.user.email
            }}
        );
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to send campaign' });
    }
});



// ── Inbox — all messages ──────────────────────────────────
app.get('/admin/inbox', adminAuth, async (req, res) => {
    try {
        const messages = await ContactMessage.find().sort({ createdAt: -1 });
        console.log('Inbox messages count:', messages.length); // ← add
        res.render('inbox', {
            user: req.user,
            token: req.token,
            messages,
            success: req.query.success || null
        });
    } catch (err) {
        console.error('Inbox error:', err.message); // ← already there
        res.status(500).send('Inbox failed');
    }
});

app.post('/admin/messages/:id/read', adminAuth, async (req, res) => {
    try {
        await ContactMessage.findByIdAndUpdate(req.params.id, { $set: { read: true } });
    } catch (err) {
        console.error('Mark read error:', err.message);
    }
    res.redirect('/admin/inbox');
});

app.post('/admin/messages/:id/delete', adminAuth, async (req, res) => {
    try {
        await ContactMessage.findByIdAndDelete(req.params.id);
    } catch (err) {
        console.error('Delete message error:', err.message);
    }
    res.redirect('/admin/inbox');
});

app.post('/admin/messages/read-all', adminAuth, async (req, res) => {
    try {
        await ContactMessage.updateMany({ read: false }, { $set: { read: true } });
    } catch (err) {
        console.error('Mark all read error:', err.message);
    }
    res.redirect('/admin/inbox?success=All messages marked as read');
});

// ── Health ────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'admin', port: PORT });
});

// ── Start ─────────────────────────────────────────────────
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Admin dashboard running on port ${PORT}`);
        console.log(`Open http://localhost:${PORT}/admin/login`);
    });
});