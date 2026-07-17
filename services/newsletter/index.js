const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const express = require('express');
const crypto = require('crypto');
const connectDB = require('../../shared/db');
const { enqueue } = require('../../shared/queue');
const { getCache, setCache, deleteCache } = require('../../shared/cache');
const NewsletterSubscriber = require('../../services/newsletter/models/NewsletterSubscriber');

const app = express();
const PORT = process.env.NEWSLETTER_PORT || 4009;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Helper ────────────────────────────────────────────────
function getUser(req) {
    return {
        id: req.headers['x-user-id'],
        role: req.headers['x-user-role'],
        email: req.headers['x-user-email']
    };
}

function generateUnsubscribeToken() {
    return crypto.randomBytes(32).toString('hex');
}

// ── Subscribe ─────────────────────────────────────────────
app.post('/newsletter/subscribe', async (req, res) => {
    const { email, name } = req.body;

    try {
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        const existing = await NewsletterSubscriber.findOne({ email });

        // Already subscribed
        if (existing && existing.status === 'subscribed') {
            return res.status(409).json({
                error: 'This email is already subscribed to our newsletter'
            });
        }

        // Re-subscribe
        if (existing && existing.status === 'unsubscribed') {
            existing.status = 'subscribed';
            existing.subscribedAt = Date.now();
            existing.unsubscribeToken = generateUnsubscribeToken();
            await existing.save();

            await enqueue('notifications', {
                type: 'newsletter_welcome',
                to: email,
                name: name || 'Cyclist',
                unsubscribeUrl: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/newsletter/unsubscribe/${existing.unsubscribeToken}`
            });

            await deleteCache('newsletter:subscribers');

            return res.json({
                message: 'Welcome back! You have been re-subscribed to our newsletter.'
            });
        }

        // New subscriber
        const subscriber = await NewsletterSubscriber.create({
            email,
            name: name || null,
            unsubscribeToken: generateUnsubscribeToken(),
            ipAddress: req.ip,
            source: 'website_form'
        });

        // Queue welcome email
        await enqueue('notifications', {
            type: 'newsletter_welcome',
            to: email,
            name: name || 'Cyclist',
            unsubscribeUrl: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/newsletter/unsubscribe/${subscriber.unsubscribeToken}`
        });

        await deleteCache('newsletter:subscribers');

        console.log('New newsletter subscriber:', email);

        res.status(201).json({
            message: 'Successfully subscribed to our newsletter!'
        });

    } catch (err) {
        console.error('Subscribe error:', err.message);
        res.status(500).json({ error: 'Failed to subscribe. Please try again.' });
    }
});

// ── Unsubscribe ───────────────────────────────────────────
app.get('/newsletter/unsubscribe/:token', async (req, res) => {
    try {
        const subscriber = await NewsletterSubscriber.findOne({
            unsubscribeToken: req.params.token,
            status: 'subscribed'
        });

        if (!subscriber) {
            return res.status(404).json({
                error: 'Invalid unsubscribe link or already unsubscribed'
            });
        }

        subscriber.status = 'unsubscribed';
        await subscriber.save();
        await deleteCache('newsletter:subscribers');

        console.log('Unsubscribed:', subscriber.email);
        res.json({ message: 'You have been successfully unsubscribed.' });

    } catch (err) {
        console.error('Unsubscribe error:', err.message);
        res.status(500).json({ error: 'Failed to unsubscribe' });
    }
});

// ── Get all subscribers — admin only ──────────────────────
app.get('/newsletter/subscribers', async (req, res) => {
    const user = getUser(req);

    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try {
        const cached = await getCache('newsletter:subscribers');
        if (cached) return res.json(cached);

        const subscribers = await NewsletterSubscriber.find({ status: 'subscribed' })
            .select('email name subscribedAt source')
            .sort({ subscribedAt: -1 });

        const result = { count: subscribers.length, subscribers };
        await setCache('newsletter:subscribers', result, 300);

        res.json(result);

    } catch (err) {
        console.error('Get subscribers error:', err.message);
        res.status(500).json({ error: 'Failed to fetch subscribers' });
    }
});

// ── Send campaign — admin only ────────────────────────────
app.post('/newsletter/send', async (req, res) => {
    const user = getUser(req);

    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    const { subject, content } = req.body;

    try {
        if (!subject || !content) {
            return res.status(400).json({ error: 'Subject and content required' });
        }

        const subscribers = await NewsletterSubscriber.find({ status: 'subscribed' });

        if (subscribers.length === 0) {
            return res.status(400).json({ error: 'No subscribers found' });
        }

        const campaignId = Date.now();
        const batchSize = 50;

        for (let i = 0; i < subscribers.length; i += batchSize) {
            const batch = subscribers.slice(i, i + batchSize);
            await enqueue('newsletter_campaign', {
                campaignId,
                subject,
                content,
                recipients: batch.map(s => ({
                    email: s.email,
                    name: s.name || 'Cyclist',
                    unsubscribeToken: s.unsubscribeToken
                }))
            });
        }

        console.log(`Campaign ${campaignId} queued for ${subscribers.length} subscribers`);

        res.json({
            message: `Campaign started! Sending to ${subscribers.length} subscribers.`,
            campaignId,
            subscriberCount: subscribers.length
        });

    } catch (err) {
        console.error('Send campaign error:', err.message);
        res.status(500).json({ error: 'Failed to send campaign' });
    }
});

// ── Stats — admin only ────────────────────────────────────
app.get('/newsletter/stats', async (req, res) => {
    const user = getUser(req);

    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try {
        const [subscribed, unsubscribed, total] = await Promise.all([
            NewsletterSubscriber.countDocuments({ status: 'subscribed' }),
            NewsletterSubscriber.countDocuments({ status: 'unsubscribed' }),
            NewsletterSubscriber.countDocuments()
        ]);

        res.json({ subscribed, unsubscribed, total });

    } catch (err) {
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// ── Health check ──────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'newsletter', port: PORT });
});

// ── Start ─────────────────────────────────────────────────
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Newsletter service running on port ${PORT}`);
    });
});