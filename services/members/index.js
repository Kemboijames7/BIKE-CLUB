const path = require('path');
const connectDB = require('../../shared/db');
const {getCache, setCache, deleteCache } = require('../../shared/cache');
const Member = require('./models/Member');
const { error } = require('console');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const express = require('express');

const app = express();
const PORT = process.env.MEMBER_PORT || 4002;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --Helper - get user from gateway header
function getUser(req) {
    return {
        id: req.headers['x-user-id'],
        name: req.headers['x-user-name'],
        role: req.headers['x-user-role'],
        email: req.headers['x-user-email']
    };
}


// --Get own profile
app.get('/members/profile', async (req, res) => {
    const user = getUser(req);

    if (!user.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        // Check cache first
        const cached = await getCache(`member:${user.id}`);
        if (cached) {
            console.log('Profile cache HIT:', user.id);
            return res.json({ member: cached });
        }

        // Fall back to DB
        const member = await Member.findOne({ userId: user.id });

        if (!member) {
            // Auto create profile if doesn't exist
            const newMember = await Member.create({
                userId:           user.id,
                phone:            '',
                city:             '',
                bikeType:         'other',
                bio:              '',
                avatar:           '',
                membershipStatus: 'active',
                joinedAt:         new Date()
            });

            await setCache(`member:${user.id}`, newMember, 300);
            return res.json({ member: newMember });
        }

        // Existing member found
        await setCache(`member:${user.id}`, member, 300);
        return res.json({ member });

    } catch (err) {
        console.log('GET /members/profile error:', err.message);
        return res.status(500).json({ error: 'Failed to get profile' });
    }
});

// -- Update own profile
app.put('/members/profile', async (req, res) => {
    const user = getUser(req);

    if (!user.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const {phone, bio, city, bikeType, avatar } = req.body;

    try {
        const member = await Member.findOneAndUpdate(
            { userId: user.id },
            {
                $set: {
                    phone, bio, city, bikeType, avatar,
                    updatedAt: new Date()
                }
            },
            { new: true, upsert: true }
        );

        //Invalidate cache
        await deleteCache(`member:${user.id}`);
        await setCache(`member:${user.id}`, member, 3600);

        console.log('Profile updated:', user.id);
        res.json({ message: 'Profile updated', member });
        
    } catch (err) {
        console.error('update profile error:', err.message);
        res.status(500).json({ error: 'Failed to update profile' });
        
    }
});

/// Get all members - all logged-in members can view
app.get('/members', async (req, res) => {
    const user = getUser(req);
   
    if (!user) {
        return res.status(401).json({ error: 'Unauthorised' });
    }

    try {
        const cached = await getCache('members:all');
        if (cached) {
            return res.json({ members: cached });
        }

        const members = await Member.find().sort({ joinedAt: -1 });
        await setCache('members:all', members, 300);

        res.json({ members });
    } catch (err) {
        console.error('Get members error:', err.message);
        res.status(500).json({ error: 'Failed to get members' });
    }
});

//Get member by id - admin only
app.get('/members/:id', async (req, res) => {
    const user = getUser(req);

    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try {
        const cached = await getCache(`member:${req.params.id}`);
        if (cached) return res.json({ member: cached });

        const member = await Member.findById(req.params.id);
        if (!member) {
            return res.status(404).json({ error: "Member not found" });
        }
        await setCache(`member:${req.params.id}`, member, 3600);
        res.json({ member });
    } catch (err) {
        console.error('Get member error:', err.message);
        res.status(500).json({ error: 'Failed to get member' });
        
    }
});
app.patch('/members/:id/suspend', async (req, res) => {
    const user = getUser(req);

    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try {
        const member = await Member.findByIdAndUpdate(
            req.params.id,
            { $set: { membershipStatus: 'suspended' } },  // ← suspended
            { returnDocument: 'after' }                    // ← fixes mongoose warning
        );

        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        // Bust both possible cache keys
        await deleteCache(`member:${req.params.id}`);      // by _id
        await deleteCache(`member:${member.userId}`);      // by userId
        await deleteCache('members:all');                  // bust the all-members list too

        console.log('Member suspended:', req.params.id);
        res.json({ message: 'Member suspended', member });

    } catch (err) {
        console.error('Suspend error:', err.message);
        res.status(500).json({ error: 'Failed to suspend member' });
    }
});

// SUSPEND
app.patch('/members/:id/suspend', async (req, res) => {
    const user = getUser(req);
    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try {
        const member = await Member.findByIdAndUpdate(
            req.params.id,
            { $set: { membershipStatus: 'suspended' } },
            { returnDocument: 'after' }
        );

        if (!member) return res.status(404).json({ error: 'Member not found' });

        await deleteCache(`member:${req.params.id}`);
        await deleteCache(`member:${member.userId}`);
        await deleteCache('members:all');

        console.log('Member suspended:', req.params.id);
        res.json({ message: 'Member suspended', member });

    } catch (err) {
        console.error('Suspend error:', err.message);
        res.status(500).json({ error: 'Failed to suspend member' });
    }
});

// ACTIVATE
app.patch('/members/:id/activate', async (req, res) => {
    const user = getUser(req);
    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    try {
        const member = await Member.findByIdAndUpdate(
            req.params.id,
            { $set: { membershipStatus: 'active' } },
            { returnDocument: 'after' }
        );

        if (!member) return res.status(404).json({ error: 'Member not found' });

        await deleteCache(`member:${req.params.id}`);
        await deleteCache(`member:${member.userId}`);
        await deleteCache('members:all');

        console.log('Member activated:', req.params.id);
        res.json({ message: 'Member activated', member });

    } catch (err) {
        console.error('Activate error:', err.message);
        res.status(500).json({ error: 'Failed to activate member' });
    }
});
// --Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'members', port: PORT });
});

//Start
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Member service running on port ${PORT}`);
        
    });
});

