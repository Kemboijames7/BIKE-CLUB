// services/notifications/newsletter.js
const express = require('express');
const crypto = require('crypto');
const NewsletterSubscriber = require('../../shared/models/NewsletterSubscriber');
const { enqueue } = require('../../shared/queue');

const router = express.Router();

// Generate unique token for unsubscribe links
function generateUnsubscribeToken() {
    return crypto.randomBytes(32).toString('hex');
}

// POST /newsletter/subscribe - Subscribe to newsletter
router.post('/subscribe', async (req, res) => {
    const { email, name } = req.body;

    try {
        // Validate email
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        // Check if already subscribed
        const existing = await NewsletterSubscriber.findOne({ email });
        
        if (existing && existing.status === 'subscribed') {
            return res.status(409).json({ 
                error: 'This email is already subscribed to our newsletter' 
            });
        }

        // Reactivate if previously unsubscribed
        if (existing && existing.status === 'unsubscribed') {
            existing.status = 'subscribed';
            existing.subscribedAt = Date.now();
            existing.unsubscribeToken = generateUnsubscribeToken();
            await existing.save();
            
            return res.json({ 
                message: 'Welcome back! You have been re-subscribed to our newsletter.' 
            });
        }

        // Create new subscriber
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
            unsubscribeUrl: `${process.env.FRONTEND_URL}/newsletter/unsubscribe/${subscriber.unsubscribeToken}`
        });

        console.log(`New newsletter subscriber: ${email}`);
        res.status(201).json({ 
            message: 'Successfully subscribed to our newsletter!' 
        });

    } catch (err) {
        console.error('Newsletter subscription error:', err.message);
        res.status(500).json({ error: 'Failed to subscribe. Please try again.' });
    }
});

// GET /newsletter/unsubscribe/:token - Unsubscribe from newsletter
router.get('/unsubscribe/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const subscriber = await NewsletterSubscriber.findOne({ 
            unsubscribeToken: token,
            status: 'subscribed'
        });

        if (!subscriber) {
            return res.status(404).json({ 
                error: 'Invalid unsubscribe link or already unsubscribed' 
            });
        }

        subscriber.status = 'unsubscribed';
        await subscriber.save();

        res.json({ 
            message: 'You have been successfully unsubscribed from our newsletter.' 
        });

    } catch (err) {
        console.error('Unsubscribe error:', err.message);
        res.status(500).json({ error: 'Failed to unsubscribe' });
    }
});

// GET /newsletter/subscribers (Admin only - list all subscribers)
router.get('/subscribers', async (req, res) => {
    try {
        const subscribers = await NewsletterSubscriber.find({ status: 'subscribed' })
            .select('email name subscribedAt')
            .sort({ subscribedAt: -1 });

        res.json({ 
            count: subscribers.length,
            subscribers 
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch subscribers' });
    }
});

module.exports = router;