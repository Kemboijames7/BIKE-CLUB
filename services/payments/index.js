const path = require('path');
require('dotenv').config({ path:path.resolve(__dirname, '../../.env') });

// Validate required env vars on startup
const REQUIRED_ENV = [
    'MONGO_URI',
    'JWT_SECRET',
    'VOUCHER_SERVICE_URL',  // adjust per service
    'EVENT_SERVICE_URL'
];

const SAFARICOM_IPS = [
    '196.201.214.200',
    '196.201.214.206',
    '196.201.214.207',
    '196.201.214.208',
    '196.201.214.209',
    '196.201.214.210',
    '196.201.214.211',
    '196.201.214.212',
    '196.201.214.213',
    '196.201.214.214',
    '196.201.214.215',
    '196.201.214.216',
    '196.201.214.217',
    '196.201.214.218',
    '196.201.214.219',
    '196.201.214.220',
    '192.168.201.214',
    '196.201.214.132'
];

const Joi = require('joi');
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length > 0) {
    console.error('Missing required environment variables:', missing.join(', '));
    process.exit(1);
}
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const connectDB = require('../../shared/db');
const { enqueue } = require('../../shared/queue');
const Payment = require('./models/Payment')
const axios = require('axios');
const { getCache, setCache, deleteCache } = require('../../shared/cache');
const { error, warn } = require('console');
const express = require('express');
const app = express();
const PORT = process.env.PAYMENT_PORT || 4005;

//--Raw body needed for stripe webhooks
app.use('/payments/webhook/mpesa', express.json());
app.use('/payments/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true}));

// Helper 
function getUser(req) {
    return {
        id: req.headers['x-user-id'],
        role: req.headers['x-user-role'],
        email: req.headers['x-user-email']
    };
}

// ── Joi schemas ───────────────────────────────────────────
const schemas = {
    mpesa: Joi.object({
        eventId: Joi.string().required(),
        amount:  Joi.number().positive().required(),
        phone:   Joi.string().pattern(/^[0-9+\s]+$/).min(9).max(15).required()
    }),
 
    stripe: Joi.object({
        eventId:         Joi.string().required(),
        amount:          Joi.number().positive().required(),
        paymentMethodId: Joi.string().required(),
        currency:        Joi.string().length(3).default('usd')
    })
};
 
// ── Validation middleware factory ─────────────────────────
function validate(schema) {
    return (req, res, next) => {
        const { error } = schema.validate(req.body, { abortEarly: false });
        if (error) {
            const messages = error.details.map(d => d.message).join(', ');
            return res.status(400).json({ error: messages });
        }
        next();
    };
}

//--Get Mpesa token
async function getMpesaToken() {
    const cached = await getCache('mpesa:token');
    if (cached) return cached;

    const auth = Buffer.from(
        `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
    ).toString('base64');

    const { data } = await axios.get(
        'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
     { headers: { Authorization: `Basic ${auth}` } }
    );

    await setCache('mpesa:token', data.access_token, 3500); //expires in 1hr
    return data.access_token;
}


//--Mpesa Callback -- Safaricom calls this 
app.post('/payments/webhook/mpesa', (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (!SAFARICOM_IPS.includes(ip)) {
        console.warn('Blocked unauthorized Mpesa callback from:', ip);
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
}, async (req, res) => {
    console.log('MPesa callback received:', JSON.stringify(req.body));

    const callback = req.body?.Body?.stkCallback;

    if (!callback) {
        console.warn('Invalid callback structure:', req.body);
        return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = callback;
    console.log('Result:', ResultCode, ResultDesc, CheckoutRequestID);

    try {
        const payment = await Payment.findOne({
            checkoutRequestId: CheckoutRequestID
        });

        if (!payment) {
            console.warn('Payment not found for:', CheckoutRequestID);
            return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
        }

        if (ResultCode === 0) {
            const mpesaReceipt = CallbackMetadata?.Item?.find(
                i => i.Name === 'MpesaReceiptNumber'
            )?.Value;

            payment.status = 'completed';
            payment.mpesaReceiptNumber = mpesaReceipt || CheckoutRequestID;
            payment.checkoutRequestId = CheckoutRequestID;
            payment.updatedAt = new Date();
            await payment.save();

            // Create voucher
            try {
                    // Check first
    const existingVoucher = await axios.get(
        `${process.env.VOUCHER_SERVICE_URL}/vouchers/my`,
        {
            headers: {
                'x-user-id': payment.memberId.toString(),
                'x-user-role': 'member',
                'x-user-email': ''
            }
        }
    );

    const alreadyHas = existingVoucher.data?.vouchers?.some(
        v => v.eventId.toString() === payment.eventId.toString() &&
             ['active', 'used'].includes(v.status)
    );
                   if (alreadyHas) {
        console.log('Member already has voucher for this event — skipping creation');
    } else {
                await axios.post(
                    `${process.env.VOUCHER_SERVICE_URL}/vouchers/purchase`,
                    {
                        eventId: payment.eventId,
                        paymentId: payment._id,
                        amount: payment.amount
                    },
                    {
                        headers: {
                            'x-user-id': payment.memberId.toString(),
                            'x-user-role': 'member',
                            'x-user-email': ''
                        }
                    }
                );
                console.log('Voucher created for MPesa payment:', payment._id);
            }
            } catch (voucherErr) {
                if (voucherErr.response?.status === 409) {
     console.log('Voucher already exists for payment:', payment._id);
 } else {
     console.error('Voucher creation failed:', voucherErr.message);
  }
            }

            // Queue receipt
            await enqueue('notifications', {
                type: 'payment_receipt',
                to: payment.phone,
                amount: payment.amount,
                currency: 'KES',
                method: 'MPesa',
                paymentId: payment._id
            });

            console.log('MPesa payment completed:', payment._id);

        } else {
            payment.status = 'failed';
            payment.updatedAt = new Date();
            await payment.save();
            console.log('MPesa payment failed:', ResultDesc);
        }

        res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    } catch (err) {
        console.error('MPesa callback error:', err.message);
        res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
});

//STK Push

app.post('/payments/mpesa', async (req, res) => {
    const user = getUser(req);
    if (!user.id) return res.status(401).json({ error: 'Not authenticated' });

    const { eventId, amount, phone } = req.body;

    try {
        if (!eventId || !amount || !phone) {
            return res.status(400).json({ error: 'eventId, amount and phone required' });
        }
     // ── Duplicate voucher check BEFORE STK push ──
       try {
    const { data } = await axios.get(
        `${process.env.VOUCHER_SERVICE_URL}/vouchers/check/${eventId}`,
        { headers: {
            'x-user-id': user.id,
            'x-user-role': user.role,
            'x-user-email': user.email
        }}
    );
    if (data.hasVoucher) {
        return res.status(409).json({ error: 'You already have a voucher for this event' });
    }
} catch (checkErr) {
    console.error('Voucher pre-check failed:', checkErr.message);
    // Don't block payment if check fails — voucher service will catch it anyway
}

        let formattedPhone = phone.replace(/\s+/g, '');
        if (formattedPhone.startsWith('0')) {
            formattedPhone = `254${formattedPhone.slice(1)}`;
        } else if (formattedPhone.startsWith('+')) {
            formattedPhone = formattedPhone.slice(1);
        }

        const token = await getMpesaToken();
        const timestamp = new Date()
            .toISOString()
            .replace(/[-T:.Z]/g, '')
            .slice(0, 14);

        const password = Buffer.from(
            `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
        ).toString('base64');

        const { data } = await axios.post(
            'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            {
                BusinessShortCode: process.env.MPESA_SHORTCODE,
                Password: password,
                Timestamp: timestamp,
                TransactionType: 'CustomerPayBillOnline',
                Amount: amount,
                PartyA: formattedPhone,
                PartyB: process.env.MPESA_SHORTCODE,
                PhoneNumber: formattedPhone,
                CallBackURL: process.env.MPESA_CALLBACK_URL,
                AccountReference: 'BikeClub',
                TransactionDesc: 'Event voucher payment'
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );

        console.log('MPesa STK push response:', data);

        const payment = await Payment.create({
            memberId: user.id,
            eventId,
            amount,
            currency: 'KES',
            method: 'mpesa',
            status: 'pending',
            phone: formattedPhone,
            checkoutRequestId: data.CheckoutRequestID,
            mpesaReceiptNumber: data.CheckoutRequestID
        });

        console.log('Mpesa STK push sent:', data.CheckoutRequestID);

        res.json({
            message: 'MPesa payment initiated. Check your phone.',
            checkoutRequestId: data.CheckoutRequestID,
            paymentId: payment._id
        });

    } catch (err) {
        console.error('MPesa error:', err.response?.data || err.message);
        res.status(500).json({
            error: 'MPesa payment failed',
            detail: err.response?.data || err.message
        });
    }
});


// Status check — supports MPesa CheckoutRequestID or MongoDB _id
app.get('/payments/status/:id', async (req, res) => {
    try {
        console.log('Status check for:', req.params.id);

        const payment = await Payment.findOne({
            $or: [
                { checkoutRequestId: req.params.id },
                { mpesaReceiptNumber: req.params.id },
                { _id: req.params.id.match(/^[a-f\d]{24}$/i) ? req.params.id : null }
            ]
        });

        if (!payment) {
            console.log('Payment not found for:', req.params.id);
            return res.status(404).json({ error: 'Payment not found' });
        }

        console.log('Found payment status:', payment.status);
        res.json({ status: payment.status, paymentId: payment._id });

    } catch (err) {
        console.error('Status check error:', err.message);
        res.status(500).json({ error: 'Status check failed' });
    }
});


//Stripe payment
app.post('/payments/stripe', async (req, res) => {
    const user = getUser(req);

    if (!user.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const  { eventId, amount, currency = 'usd', paymentMethodId } = req.body;

 try {
    if (!eventId || !amount || !paymentMethodId) {
        return res.status(400).json({ error: 'eventId, amount and paymentMethodId required' });
    }

    try {
    const { data } = await axios.get(
       `${process.env.VOUCHER_SERVICE_URL}/vouchers/check/${eventId}`,
        { headers: {
            'x-user-id': user.id,
            'x-user-role': user.role,
            'x-user-email': user.email
        }}
    );
    if (data.hasVoucher) {
        return res.status(409).json({ error: 'You already have a voucher for this event' });
    }
} catch (checkErr) {
    console.error('Voucher pre-check failed:', checkErr.message);
}

    //Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
        amount: amount * 100, //stripe uses captureEvents
        currency,
        payment_method: paymentMethodId,
        confirm: true,
        automatic_payment_methods: {
            enabled: true,
            allow_redirects: 'never'
        },
        metadata: {
            userId: user.id,
            eventId,
            userEmail: user.email
        }
    });

    //Save payment record
    const payment = await Payment.create({
        memberId:user.id,
        eventId,
        amount,
        currency,
        method: 'stripe',
        status: paymentIntent.status === 'succeeded' ? 'completed' : 'pending',
        stripePaymentId: paymentIntent.id
    });

    console.log('Stripe payment:', payment._id, '| Status:', payment.status);

    //If payment succeeded create voucher automatically
if (payment.status === 'completed') {
    try {
        const voucherRes = await axios.post(
          `${process.env.VOUCHER_SERVICE_URL}/vouchers/purchase`,
            { eventId, paymentId: payment._id, amount },
            { headers: {
                'x-user-id': user.id,
                'x-user-role': user.role,
                'x-user-email': user.email
            }}
        );
        console.log('Voucher created:', voucherRes.data);
    } catch (voucherErr) {
        console.error('Voucher error status:', voucherErr.response?.status);
        console.error('Voucher error body:', voucherErr.response?.data);
    }
}
        await enqueue('notifications', {
            type: 'payment_receipt',
            to: user.email,
            amount,
            currency,
            method: 'Stripe',
            paymentId: payment._id
        });

    res.json({
        message: 'Payment successful',
        payment: {
            id: payment._id,
            status: payment.status,
            amount: payment.amount,
            currency: payment.currency,
            method: payment.method
        }
    });

 } catch (err) {
    console.error('Stripe payment error:',  err.message);
    res.status(500).json({ error: 'Payment failed', detail: err.message });
 }
});



// Stripe webhook
app.post('/payments/webhook/stripe', async (req, res) => {
    const sig = req.headers['stripe-signature'];

    try {
        const event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );

        if (event.type === 'payment_intent.succeeded') {
            const intent = event.data.object;
            await Payment.findOneAndUpdate(
                { stripePaymentId: intent.id },
                { $set: {status: 'completed', updatedAt: new Date() } }
            );
            console.log('Stripe webhook: payment succeeded:', intent.id);
        }

        if (event.type === 'payment_intent.payment_failed') {
            const intent = event.data.object;
            await Payment.findByIdAndUpdate(
                { stripePaymentId: intent.id },
                { $set: {status: 'failed', updatedAt: new Date() } }
            );
            console.log('Stripe webhook: payment failed:', intent.id);
            
        }
        res.json({ received: true });
    } catch (err) {
        console.error('Stripe webhook error:', err.message);
        res.status(400).json({ error: err.message });
        
    }
});


//Payment history
app.get('/payment/history', async (req, res) => {
    const user = getUser(req);

    if (!user.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const cacheKey = `payment:${user.id}`;
        const cached = await getCache(cacheKey);
        if (cached) return res.json({ payments: cached });

        const payments = await Payment.find({ memberId: user.id })
        .sort({ createdAt: -1 });

        await setCache(cacheKey, payments, 300);
        res.json({ payments });
    } catch (err) {
        console.error('Payment history error:', err,message);
        res.status(500)/json({ error: 'Failed to get payment history' });
        
    }
});

//Get all payments -- admin only
app.get('/payments', async (req,res) => {
    const user = getUser(req);
    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    const { method, status, page = 1, limit = 20 } = req.query;
    const cacheKey = `payments:${method || 'all'}:${status || 'all'}:${page}:${limit}`; 
    try {
        const query = {};
        if (method) query.method = method;
        if (status) query.status = status;

        const skip = (page - 1) * limit;
        const total = await Payment.countDocuments(query);
        const payments = await Payment.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit));

        const result = {
            payments,
            pagination: {
                total,
                page: Number(page),
                pages: Math.ceil(total / limit)
            }
        };
        res.json(result);
    }  catch (err) {
        console.error('Get payments error:', err.message);
        res.status(500).json({ error: 'Failed to get payments' });
        
    }
});


// ── Health check ──────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'payments', port: PORT });
});

// ── Start ─────────────────────────────────────────────────
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Payment service running on port ${PORT}`);
    });
});