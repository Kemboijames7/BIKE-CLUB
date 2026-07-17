// services/notifications/newsletter-campaign.js
const { enqueue } = require('../../shared/queue');
const NewsletterSubscriber = require('../../shared/models/NewsletterSubscriber');

// POST /admin/newsletter/send (Admin only)
router.post('/admin/newsletter/send', async (req, res) => {
    const { subject, content, testEmail } = req.body;

    try {
        // Get all active subscribers
        const subscribers = await NewsletterSubscriber.find({ status: 'subscribed' });
        
        if (subscribers.length === 0) {
            return res.status(400).json({ error: 'No subscribers found' });
        }

        // Create a campaign record
        const campaignId = Date.now();
        
        // Queue emails in batches to avoid overwhelming the system
        const batchSize = 50;
        const batches = [];
        
        for (let i = 0; i < subscribers.length; i += batchSize) {
            const batch = subscribers.slice(i, i + batchSize);
            batches.push(batch);
        }
        
        // Queue each batch
        for (const batch of batches) {
            await enqueue('newsletter_campaign', {
                campaignId,
                subject,
                content,
                recipients: batch.map(s => ({
                    email: s.email,
                    name: s.name,
                    unsubscribeToken: s.unsubscribeToken
                })),
                timestamp: new Date().toISOString()
            });
        }
        
        res.json({
            message: `Newsletter campaign started! Sending to ${subscribers.length} subscribers in ${batches.length} batches.`,
            campaignId,
            subscriberCount: subscribers.length
        });

    } catch (err) {
        console.error('Campaign error:', err.message);
        res.status(500).json({ error: 'Failed to send newsletter' });
    }
});