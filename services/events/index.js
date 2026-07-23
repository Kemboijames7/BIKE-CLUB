
const path = require('path');
const connectDB = require('../../shared/db')
const { getCache, setCache, deleteCache, flushPattern } = require('../../shared/cache');
const Event = require('./models/Event');
const { eventNames } = require('cluster');
const { error } = require('console');
const { register } = require('module');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env')});

const express = require('express');
const app = express();
const PORT = process.env.EVENT_PORT || 4003;

app.use(express.json());
app.use(express.urlencoded({ extended: true}));

// if (search) query.title = { $regex: search, $options: 'i' };

//Helper
function getUser(req) {
    return {
        id: req.headers['x-user-id'],
        role: req.headers['x-user-role'],
        email: req.headers['x-user-email']
    };
}

//Get all events
app.get('/events', async(req, res) => {
    const { type, status, page=1, limit=10 } = req.query;

    const cacheKey = `events:${type || 'all'}:${status || 'all'}:page${page}`;

    try {
        //Check cache
        const cached = await getCache(cacheKey);
        if (cached) {
            console.log('Events cache HIT:', cacheKey);
            return res.json(cached);       
        }

        //Build query
        const query = {};
        if (type) query.type = type;
        if (status) query.status = status;
        else query.status = { $ne: 'cancelled' };

        const skip = (page - 1) * limit;
        const total = await Event.countDocuments(query);
        const events = await Event.find(query)
        .sort({ date: 1 })
        .skip(skip)
        .limit(Number(limit));

        const result = {
            events,
            pagination: {
                total,
                page: Number(page),
                pages:Math.ceil(total / limit),
                limit: Number(limit)
            }
        };

        await setCache(cacheKey, result, 300);
        res.json(result);
    } catch (err) {
        console.error('Get events error:', err.message);
        res.status(500).json({ error: 'Failed to get events' });
    }
});

// -- Get single event
app.get('/events/:id', async (req, res) => {
    try {
        const cached = await getCache(`event:${req.params.id}`);
        if (cached) return res.json({ event: cached});

        const event = await Event.findById(req.params.id);
        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        await setCache(`event:${req.params.id}`, event, 300);
        res.json({ event });
    } catch (err) {
        console.error('Get event error:', err.message);
        res.status(500).json({ error: 'Failed to get event' });
        
    }
});

//Create event - admin only
app.post('/events', async (req, res) => {
    const user = getUser(req);

    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    const {
        title, description, type, location,
        date, endDate, capacity, price,
        currency, hasLiveChat, hasCommentary, image
    } = req.body;

    try {
        if (!title || !description || !type || !date || !capacity) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const event = await Event.create({
            title, description, type, location,
            date, endDate, capacity, price: price || 0,
            currency: currency || 'KES',
            hasLiveChat: hasLiveChat || false,
            hasCommentary: hasCommentary || false,
            image: image || '',
            createdBy: user.id
        });

        //Flush events cache so lists refresh
        await flushPattern('events:*');

        console.log('Event created:', event._id, '|', title);
        res.status(201).json({ message: 'Event created', event });
        
    } catch (err) {
        console.error('Create event error:', err.message);
        res.status(500).json({ error: 'Failed to create event' });
        
    }
});

//Update event - admin only
app.put('/events/:id', async (req, res) => {
    const user =  getUser(req);

    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try { 
        const event = await Event.findByIdAndUpdate(
            req.params.id,
            { $set: req.body },
            { new: true }
        );

        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        //Invalidate caches 
        await deleteCache(`event:${req.params.id}`);
        await flushPattern('events:*');

        console.log('Event updated:', req.params.id);
        res.json({ message: 'Event updated', event });
        } catch (err) {
            console.error('update event error:', err.message);
            res.status(500).json({ error: 'Failed to update event' });
            
        }
});

//Cancel event --admin only
app.delete('/events/:id', async (req, res) => {
    const user = getUser(req);

    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try {
        const event = await Event.findByIdAndUpdate(
            req.params.id,
            { $set: { status: 'cancelled' } },
            { new: true }
        );

        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        await deleteCache(`event:${req.params.id}`);
        await flushPattern('events:*');

        console.log('Event cancelled:', req.params.id);
        res.json({ message: 'Event cancelled', event});
    } catch (err) {
        console.error('Cancel event error:', err.message);
        res.status(500).json({ error: 'Failed to cancel event' });
    }
});

//-- Get event attendees -- admin only
app.get('/event/:id/attendees', async (req, res) => {
    const user = getUser(req);

    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required'});
    }

    try {
        const cached = await getCache(`event:${req.params.id}:attendees`);
        if (cached) return res.json({  attendees: cached });

        //This will be populated by voucher service
        //For now return event registration count
        const event = await Event.findById(req.paramsms.id);
        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        res.json({
            eventId: req.params.id,
            title: event.title,
            capacity: event.capacity,
            registered: event.registered,
            spotsLeft: event.capacity - event.registered
        });
    } catch (err) {
        console.error('Get attendees error:', err.message);
        res.status(500).json({ error: 'Failed to get attendees' });
        
    }
});

//--Increment registered count
// Called internally by voucher service when someone buys a voucher
app.patch('/events/:id/register', async (req, res) => {
    try {
        const event = await Event.findById(req.params.id);

        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        if (event.registered >= event.capacity) {
            return res.status(400).json({error: 'Event is fully booked' });
        }

        event.registered += 1;
        await event.save();

        await deleteCache(`event:${req.params.id}`);
        await flushPattern('events:*');

        res.json({ message: 'Registered', registered: event.registered, capacity: event.capacity });
    } catch (err) {
        console.error("Register error", err.message);
        res.status(500).json({ error: 'Failed to register' });
    }
});

//Health check

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'events', port: PORT });
});

//Start 
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Event service running on port ${PORT}`);
    });
});
