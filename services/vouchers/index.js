const express = require('express');
const path = require('path');
const connectDB = require('../../shared/db');
const { getCache, setCache, deleteCache } = require('../../shared/cache');
const { enqueue } = require('../../shared/queue');
const Voucher = require('./models/Voucher');
const axios = require('axios');
const Joi = require('joi');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env')});

// Validate required env vars on startup
const REQUIRED_ENV = [
    'MONGO_URI',
    'JWT_SECRET',
    'VOUCHER_SERVICE_URL',  // adjust per service
    'EVENT_SERVICE_URL'
];

const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length > 0) {
    console.error('Missing required environment variables:', missing.join(', '));
    process.exit(1);
}
const app = express();
const PORT = process.env.VOUCHER_PORT || 4004;

app.use(express.json());
app.use(express.urlencoded({ extended: true}));

//Helper
function getUser(req) {
    return {
        id: req.headers['x-user-id'],
        role: req.headers['x-user-role'],
        email: req.headers['x-user-email']
    };
}

// ── Joi schemas ───────────────────────────────────────────
const schemas = {
    purchase: Joi.object({
        eventId:   Joi.string().required(),
        amount:    Joi.number().min(0).required(),
        paymentId: Joi.string().optional()
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


//Purchase voucher
app.post('/vouchers/purchase', async (req, res) => {
    const user = getUser(req);

    if (!user.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { eventId, paymentId, amount } = req.body;

    try {
        if  (!eventId || amount === undefined || amount === null) {
         return res.status(400).json({ error: 'eventId and amount required' });   
        }

        //Check event exists and has capacity
        const eventRes = await axios.get(
            `${process.env.EVENT_SERVICE_URL}/events/${eventId}`
        );
        const event = eventRes.data.event;

        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        if (event.status === 'cancelled') {
            return res.status(400).json({ error: `Event has been cancelled`});
        }

        if (event.registered >= event.capacity) {
            return res.status(400).json({ error: 'Event is fully booked' });
        }

        //Check member hasn't already bought a voucher for this event
        const existing = await Voucher.findOne({
            memberId: user.id,
            eventId,
            status: { $in: ['active', 'used'] }
        });

        if (existing) {
            return res.status(409).json({ error: 'You already have a voucher for this event' });

        }

        //Set expiry to event date
        const expiresAt = new Date(event.date);

        //Create voucher
        const voucher = await Voucher.create({
            memberId: user.id,
            nameId: user.name,
            eventId,
            paymentId: paymentId || 'pending',
            amount,
            currency: event.currency || 'KES',
            expiresAt: new Date(event.date)
        });

        //Increment event registered count
        await axios.patch(
            `${process.env.EVENT_SERVICE_URL}/events/${eventId}/register`
        );

        //Invalidate member voucher cache
        await deleteCache(`vouchers:member:${user.id}`);

        //Queue confirmation email
        await enqueue('notifications', {
            type: 'voucher_confirmation',
            to: user.email,
            voucherCode: voucher.code,
            eventTitle: event.title,
            eventDate: event.date,
            eventlocation: event.location,
            amount: voucher.amount,
            currency: voucher.currency
        });

        console.log('Voucher created:', voucher.code, '| Event:', event.title);

        res.status(201).json({
            message: 'Voucher purchased successfully',
            voucher: {
                id: voucher._id,
                code: voucher.code,
                eventId: voucher.eventId,
                amount: voucher.amount,
                currency: voucher.currency,
                status: voucher.status,
                expiresAt: voucher.expiresAt
            }
        });
        
    }  catch (err) {
        console.error('Purchase voucher error:', err.message);
        res.status(500).json({ error: 'Failed to purchase voucher' });
    }
});


//-- Get my vouchers
app.get('/vouchers/my', async (req, res) => {
    const user = getUser(req);

    if (!user.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const cacheKey = `vouchers:member:${user.id}`;
        const cached = await getCache(cacheKey);
        if (cached) return res.json({ vouchers: cached })

        const vouchers = await Voucher.find({ memberId: user.id})
        .sort({ createdAt: -1 });

                // Enrich with event title
        const enriched = await Promise.all(vouchers.map(async (v) => {
            try {
                const { data } = await axios.get(
                    `${process.env.EVENT_SERVICE_URL}/events/${v.eventId}`,
                    { headers: {
                        'x-user-id': user.id,
                        'x-user-role': user.role,
                        'x-user-email': user.email
                    }}
                );
                return { ...v.toObject(), eventTitle: data.event?.title || 'Event' };
            } catch {
                return { ...v.toObject(), eventTitle: 'Event' };
            }
        }));

        await setCache(cacheKey, enriched, 300);
        res.json({  vouchers: enriched  });
    } catch (err) {
        console.error('Get vouchers error:', err.message);
        res.status(500).json({ error: 'Failed to get vouchers' });
        
    }
});

// Check if member already has a voucher for an event
app.get('/vouchers/check/:eventId', async (req, res) => {
    const user = getUser(req);

    if (!user.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const existing = await Voucher.findOne({
            memberId: user.id,
            eventId: req.params.eventId,
            status: { $in: ['active', 'used'] }
        });

        res.json({ hasVoucher: !!existing, voucher: existing || null });

    } catch (err) {
        console.error('Voucher check error:', err.message);
        res.status(500).json({ error: 'Failed to check voucher' });
    }
});


//--Validate voucher
app.get('/vouchers/:code', async (req, res) => {
    try {
        const cacheKey = `voucher:${req.params.code}`;
        const cached = await getCache(cacheKey)
        if (cached) return res.json({ voucher: cached });

        const voucher = await Voucher.findOne({ code: req.params.code });

        if (!voucher) {
            return res.status(404).json({ error: 'Voucher not found' });
        }

        //Check expiry
        if (new Date() > new Date(voucher.expiresAt)) {
            await Voucher.findByIdAndUpdate(voucher._id, { $set: { status: 'expired' } });
            return res.status(400).json({ error: 'Voucher has expired' });
        }

        await setCache(cacheKey, voucher, 60); //1 min cache
        res.json({
            voucher: {
            code: voucher.code,
            status:voucher.status,
            eventId: voucher.eventId,
            amount: voucher.amount,
            expiresAt: voucher.expiresAt
            }
  
        });
    } catch (err) {
        console.error('Validate voucher error:', err.message);
        res.status(500).json({ error: 'Failed to validate voucher' });
    }
});

//- Use voucher -- mark as used
app.patch('/vouchers/:code/use', async (req, res) => {
    const user =getUser(req);

    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try {
        const voucher = await Voucher.findOne({ code: req.params.code });

        if (!voucher) {
            return res.status(404).json({ error: 'Voucher not found' });
        }
        if (voucher.status !== 'active') {
            return res.status(400).json({
                error: `Voucher is ${voucher.status} - cannot be used`
            });
        }

        voucher.status = 'used'
        voucher.usedAt = new Date();
        await voucher.save();

        await deleteCache(`voucher:${req.params.code}`);
        await deleteCache(`vouchers:member:${voucher.memberId}`);

        console.log('Voucher used:', req.params.code);
        res.json({ message: 'Voucher marked as used', voucher });
        
    } catch (err) {
        console.error('Use voucher error:', err.message);
        res.status(500).json({ error: 'Failed to use voucher' });
        
    }
});

app.patch('/vouchers/:code/expire', async (req, res) => {
    const user = getUser(req);
    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try {
        const voucher = await Voucher.findOneAndUpdate(
            { code: req.params.code, status: 'active' }, // only expire active ones
            { $set: { status: 'expired', expiresAt: new Date() } },
            { returnDocument: 'after' }
        );

        if (!voucher) {
            return res.status(404).json({ error: 'Voucher not found or not active' });
        }

        await deleteCache(`voucher:${req.params.code}`);
        await deleteCache(`vouchers:member:${voucher.memberId}`);

        console.log('Voucher expired:', req.params.code);
        res.json({ message: 'Voucher expired', voucher });

    } catch (err) {
        console.error('Expire error:', err.message);
        res.status(500).json({ error: 'Failed to expire voucher' });
    }
});


//Revoke voucher - admin only
app.delete('/vouchers/:code', async (req, res) => {
    const user = getUser(req);
    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try {
        const voucher = await Voucher.findOneAndUpdate(
            { code: req.params.code },
            { $set: { status: 'revoked' } },
            { returnDocument: 'after' }
        );

        if (!voucher) {
            return res.status(404).json({ error: 'Voucher not found' });
        }

        await deleteCache(`voucher:${req.params.code}`);
        await deleteCache(`vouchers:member:${voucher.memberId}`);
        // await setCache(`vouchers:member:${user.id}`, enriched, 300);

        console.log('Voucher revoked:', req.params.code);
        res.json({ message: 'Voucher revoked', voucher });

    } catch (err) {
        console.error('Revoke voucher error:', err.message);
        res.status(500).json({ error: 'Failed to revoke voucher' });
    }
});

app.patch('/vouchers/:code/reinstate', async (req, res) => {
    const user = getUser(req);
    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try {
        const voucher = await Voucher.findOneAndUpdate(
            { code: req.params.code, status: 'revoked' }, // only reinstate revoked ones
            { $set: { status: 'active' } },
            { returnDocument: 'after' }
        );

        if (!voucher) {
            return res.status(404).json({ error: 'Voucher not found or not revoked' });
        }

        await deleteCache(`voucher:${req.params.code}`);
        await deleteCache(`vouchers:member:${voucher.memberId}`);

        console.log('Voucher reinstated:', req.params.code);
        res.json({ message: 'Voucher reinstated', voucher });

    } catch (err) {
        console.error('Reinstate error:', err.message);
        res.status(500).json({ error: 'Failed to reinstate voucher' });
    }
});

app.get('/vouchers', async (req, res) => {
     const user = getUser(req);
    if (user.role !== 'admin') {
        return res.status(403).json({ error: `Admin access required` });
    }

    const { eventId, status, page = 1, limit = 20 } = req.query;

    try {
        const query = {};
        if (eventId) query.eventId = eventId;
        if (status) query.status = status;

        const skip = (page - 1) * limit;
        const total = await Voucher.countDocuments(query);
        const vouchers = await Voucher.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Number(limit));

            res.json({
                vouchers,
                pagination: {
                    total,
                    page: Number(page),
                    pages: Math.ceil(total / limit)
                }
            });
    } catch (err) {
        console.error('Get all vouchers error:', err.message);
        res.status(500).json({ error: 'Failed to get vouchers' });
        
    }
});

//--Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'vouchers', port: PORT});
});

//Start
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Voucher service running on port ${PORT}`);
        
    });
});