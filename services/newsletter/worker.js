const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const nodemailer = require('nodemailer');
const connectDB = require('../../shared/db');
const { dequeue } = require('../../shared/queue');

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

async function sendNewsletterEmail(recipient, subject, content) {
    const unsubscribeUrl = `${process.env.FRONTEND_URL || 'http://localhost:3001'}/newsletter/unsubscribe/${recipient.unsubscribeToken}`;

    await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to: recipient.email,
        subject,
        html: `
            <div style="font-family:sans-serif;max-width:600px;margin:auto">
                <div style="background:#1a1a2e;padding:20px;text-align:center">
                    <h1 style="color:white;margin:0">🚴 Bike Club Nairobi</h1>
                </div>
                <div style="padding:30px">
                    ${content}
                </div>
                <div style="border-top:1px solid #eee;padding:20px;text-align:center">
                    <p style="font-size:12px;color:#666">
                        You are receiving this because you subscribed to Bike Club newsletter.
                        <br>
                        <a href="${unsubscribeUrl}" style="color:#666">Unsubscribe</a>
                    </p>
                </div>
            </div>
        `
    });
}

async function startWorker() {
    console.log('📧 Newsletter campaign worker started...');

    setInterval(async () => {
        try {
            const job = await dequeue('newsletter_campaign');

            if (job) {
                console.log(`\n📨 Processing campaign: ${job.campaignId}`);
                console.log(`   Recipients: ${job.recipients.length}`);

                for (let i = 0; i < job.recipients.length; i++) {
                    const recipient = job.recipients[i];

                    try {
                        await sendNewsletterEmail(recipient, job.subject, job.content);
                        console.log(`   ✅ ${i + 1}/${job.recipients.length} → ${recipient.email}`);

                        // Delay to avoid spam filters
                        if (i < job.recipients.length - 1) {
                            await new Promise(r => setTimeout(r, 1000));
                        }

                    } catch (err) {
                        console.error(`   ❌ Failed → ${recipient.email}:`, err.message);
                    }
                }

                console.log(`✅ Campaign ${job.campaignId} complete!`);
            }

        } catch (err) {
            console.error('Newsletter worker error:', err.message);
        }
    }, 5000);
}

connectDB().then(startWorker);