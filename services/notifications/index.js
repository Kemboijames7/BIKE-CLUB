const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../../.env')});
const nodemailer = require('nodemailer');
const connectDB = require('../../shared/db');
const { dequeue } = require('../../shared/queue');

//- Email transporter
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

//-Verify email connection
async function verifyEmail() {
    try {
        await transporter.verify();
        console.log('✅ Email transporter ready');
    } catch (err) {
        console.warn('⚠️ Email not configured:', err.message);
    }
}

//--Email templates
function getTemplate(job) {
    switch (job.type) {
        case 'welcome':
            return {
                to: job.to,
                subject: '🚴 Welcome to Bike Club',
                html: `
                <div style="font-family:sans-serif;max-width:600px;margin:auto">
                    <h1 style="color:#2563eb">Welcome to Bike Club, ${job.name}!</h1>
                    <p>We're excited to have you join our cycling community.</p>
                    <p>Here's what you can do:</p>
                    <ul>
                        <li>Browse upcoming rides and events</li>
                        <li>Purchase vouchers for events</li>
                        <li>Join live event chats</li>
                    </ul>
                    <a href="http://localhost:3000"
                       style="background:#2563eb;color:white;padding:12px 24px;
                              text-decoration:none;border-radius:6px;display:inline-block">
                        View Events
                    </a>
                    <p style="color:#666;margin-top:24px">Happy cycling! 🚴</p>
                </div>
                `
            };
            
        case 'voucher_confirmation':
            return {
                to: job.to,
                subject: `🎟️ Voucher Confirmed — ${job.eventTitle}`,
                html: `
                    <div style="font-family:sans-serif;max-width:600px;margin:auto">
                        <h1 style="color:#2563eb">Your Voucher is Confirmed!</h1>
                        <div style="background:#f3f4f6;padding:24px;border-radius:8px;margin:24px 0">
                            <h2 style="margin:0 0 16px">${job.eventTitle}</h2>
                            <p><strong>Voucher Code:</strong> 
                               <span style="font-size:24px;font-weight:bold;
                                            color:#2563eb;letter-spacing:4px">
                                   ${job.voucherCode}
                               </span>
                            </p>
                            <p><strong>Date:</strong> ${new Date(job.eventDate).toDateString()}</p>
                            <p><strong>Location:</strong> ${job.eventLocation}</p>
                            <p><strong>Amount Paid:</strong> ${job.currency} ${job.amount}</p>
                        </div>
                        <p>Show this voucher code at the event entrance.</p>
                        <p style="color:#666">See you on the road! 🚴</p>
                    </div>
                `
            };

        case 'payment_receipt':
            return {
                to: job.to,
                subject: '✅ Payment Receipt — Bike Club',
                html: `
                    <div style="font-family:sans-serif;max-width:600px;margin:auto">
                        <h1 style="color:#16a34a">Payment Successful!</h1>
                        <div style="background:#f3f4f6;padding:24px;border-radius:8px;margin:24px 0">
                            <p><strong>Amount:</strong> ${job.currency} ${job.amount}</p>
                            <p><strong>Method:</strong> ${job.method}</p>
                            <p><strong>Payment ID:</strong> ${job.paymentId}</p>
                            <p><strong>Date:</strong> ${new Date().toDateString()}</p>
                        </div>
                        <p style="color:#666">Thank you for your payment.</p>
                    </div>
                `
            };

        case 'event_reminder':
            return {
                to: job.to,
                subject: `⏰ Reminder — ${job.eventTitle} is tomorrow!`,
                html: `
                    <div style="font-family:sans-serif;max-width:600px;margin:auto">
                        <h1 style="color:#2563eb">Event Reminder!</h1>
                        <p>Your event is tomorrow. Don't forget your voucher!</p>
                        <div style="background:#f3f4f6;padding:24px;border-radius:8px;margin:24px 0">
                            <h2>${job.eventTitle}</h2>
                            <p><strong>Date:</strong> ${new Date(job.eventDate).toDateString()}</p>
                            <p><strong>Location:</strong> ${job.eventLocation}</p>
                            <p><strong>Voucher Code:</strong> 
                               <span style="font-size:20px;font-weight:bold;color:#2563eb">
                                   ${job.voucherCode}
                               </span>
                            </p>
                        </div>
                        <p style="color:#666">See you tomorrow! 🚴</p>
                    </div>
                `
            };

        case 'password_reset':
            return {
                to: job.to,
                subject: '🔐 Reset Your Password - Bike Club',
                html: `
                    <div style="font-family:sans-serif;max-width:600px;margin:auto;background:#f9fafb;padding:20px;border-radius:12px">
                        <div style="background:white;border-radius:8px;padding:32px;text-align:center">
                            <h1 style="color:#2563eb;margin:0 0 16px">Reset Your Password</h1>
                            <p style="color:#4b5563;margin-bottom:24px">Hello ${job.name || 'Cyclist'},</p>
                            <p style="color:#4b5563;margin-bottom:24px">We received a request to reset your password. Click the button below to create a new password:</p>
                            
                            <a href="${job.resetUrl}" 
                               style="background:#2563eb;color:white;padding:14px 28px;
                                      text-decoration:none;border-radius:6px;display:inline-block;
                                      font-weight:bold;margin:16px 0">
                                Reset Password
                            </a>
                            
                            <p style="color:#6b7280;font-size:14px;margin:24px 0">
                                Or copy this link: <br>
                                <span style="color:#2563eb;word-break:break-all">${job.resetUrl}</span>
                            </p>
                            
                            <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px;margin:24px 0;text-align:left">
                                <p style="color:#92400e;font-size:14px;margin:0">
                                    ⏰ This link will expire in <strong>1 hour</strong> for security reasons.
                                </p>
                            </div>
                            
                            <p style="color:#6b7280;font-size:14px;margin:16px 0">
                                If you didn't request this, please ignore this email.
                            </p>
                            
                            <hr style="margin:32px 0;border-color:#e5e7eb">
                            
                            <p style="color:#9ca3af;font-size:12px;margin:0">
                                Bike Club - Safe riding! 🚴
                            </p>
                        </div>
                    </div>
                `
            };
            
        case 'password_changed':
            return {
                to: job.to,
                subject: '✅ Password Changed Successfully - Bike Club',
                html: `
                    <div style="font-family:sans-serif;max-width:600px;margin:auto;background:#f9fafb;padding:20px;border-radius:12px">
                        <div style="background:white;border-radius:8px;padding:32px;text-align:center">
                            <div style="background:#16a34a;width:60px;height:60px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:24px">
                                <span style="font-size:32px">✓</span>
                            </div>
                            
                            <h1 style="color:#16a34a;margin:0 0 16px">Password Changed!</h1>
                            <p style="color:#4b5563;margin-bottom:24px">Hello ${job.name || 'Cyclist'},</p>
                            <p style="color:#4b5563;margin-bottom:24px">Your password has been successfully changed.</p>
                            
                            <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px;margin:24px 0;text-align:left">
                                <p style="color:#92400e;font-size:14px;margin:0">
                                    🔒 If you didn't make this change, please <a href="mailto:support@bikeclub.com" style="color:#2563eb">contact support</a> immediately.
                                </p>
                            </div>
                            
                            <p style="color:#6b7280;font-size:14px;margin:16px 0">
                                You can now log in with your new password.
                            </p>
                            
                            <a href="http://localhost:3000/login" 
                               style="background:#2563eb;color:white;padding:12px 24px;
                                      text-decoration:none;border-radius:6px;display:inline-block;
                                      margin-top:16px">
                                Log In Now
                            </a>
                            
                            <hr style="margin:32px 0;border-color:#e5e7eb">
                            
                            <p style="color:#9ca3af;font-size:12px;margin:0">
                                Bike Club - Keep your account secure 🚴
                            </p>
                        </div>
                    </div>
                `
            };
            // Add to services/notifications/index.js - getTemplate() function
case 'newsletter_welcome':
    return {
        to: job.to,
        subject: 'Welcome to Bike Club Newsletter! 🚴',
        html: `
            <div style="font-family:sans-serif;max-width:600px;margin:auto">
                <h1 style="color:#2563eb">Welcome to the Bike Club Community!</h1>
                <p>Hi ${job.name},</p>
                <p>Thank you for subscribing to our newsletter. You'll now receive:</p>
                <ul>
                    <li>Upcoming cycling events and rides</li>
                    <li>Exclusive member discounts and offers</li>
                    <li>Cycling tips and safety guides</li>
                    <li>Community stories and highlights</li>
                </ul>
                <p>You can unsubscribe at any time by clicking the link below:</p>
                <a href="${job.unsubscribeUrl}" style="color:#666">Unsubscribe</a>
                <p style="margin-top:24px">Happy cycling! 🚴</p>
            </div>
        `
    };

case 'newsletter_campaign':
    const unsubscribeUrl = `${process.env.FRONTEND_URL}/newsletter/unsubscribe/${job.unsubscribeToken}`;
    return {
        to: job.to,
        subject: job.subject,
        html: `
            <div style="font-family:sans-serif;max-width:600px;margin:auto">
                ${job.content}
                <hr style="margin:32px 0">
                <p style="font-size:12px;color:#666">
                    You're receiving this because you subscribed to the Bike Club newsletter.
                    <br>
                    <a href="${unsubscribeUrl}">Unsubscribe</a> | 
                    <a href="${process.env.FRONTEND_URL}">Visit our website</a>
                </p>
            </div>
        `
    };

        default: 
            console.warn(`Unknown notification type: ${job.type}`);
            return null;
    }  
}

//-- Send email (removed the rate limiting code that was causing the error)
async function sendEmail(job) {
    const template = getTemplate(job);

    if (!template) {
        console.warn(`No template found for type: ${job.type}`);
        return;
    }

    try {
        const info = await transporter.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
            to: template.to,
            subject: template.subject,
            html: template.html
        });

        console.log(`✅ Email sent [${job.type}] to ${template.to} | ID: ${info.messageId}`);      
    } catch (err) {
        console.error(`❌ Email failed [${job.type}] to ${template.to}:`, err.message);
        throw err;
    }
}

// - Worker
async function startWorker() {
    console.log('🚀 Notification worker started, waiting for jobs...');
    
    setInterval(async () => {
        try {
            const job = await dequeue('notifications');

            if (job) {
                console.log(`\n📨 Processing notification: ${job.type} → ${job.to}`);
                await sendEmail(job);
            }
        } catch (err) {
            console.error('❌ Notification worker error:', err.message);
        }
    }, 1000);
}

//--Start
connectDB().then(async () => {
    console.log('📦 Database connected');
    await verifyEmail();
    startWorker();
}).catch(err => {
    console.error('❌ Failed to connect to database:', err.message);
    process.exit(1);
});