const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');
const connectDB = require('../../shared/db');
const { redis } = require('../../shared/cache');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.CHAT_PORT || 4006;

app.use(express.json());

// ── Room types ────────────────────────────────────────────
// live        → live event chat (everyone talks)
// webinar     → Q&A only (members ask, admin answers)
// commentary  → admin only broadcasts, members read only

// ── Socket auth middleware ────────────────────────────────
io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token ||
                  socket.handshake.headers?.authorization?.split(' ')[1];

    if (!token) {
        return next(new Error('Authentication required'));
    }

    try {
        // Check blacklist
        const blacklisted = await redis.get(`blacklist:${token}`);
        if (blacklisted) {
            return next(new Error('Token invalidated'));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.user = decoded;
        next();

    } catch (err) {
        next(new Error('Invalid token'));
    }
});

// ── Track online users per room ───────────────────────────
const rooms = {};

function addToRoom(roomId, user) {
    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][user.id] = {
        id: user.id,
        email: user.email,
        role: user.role,
        joinedAt: new Date()
    };
}

function removeFromRoom(roomId, userId) {
    if (rooms[roomId]) {
        delete rooms[roomId][userId];
        if (Object.keys(rooms[roomId]).length === 0) {
            delete rooms[roomId];
        }
    }
}

function getRoomUsers(roomId) {
    return Object.values(rooms[roomId] || {});
}

// ── Save message to Redis ─────────────────────────────────
async function saveMessage(roomId, message) {
    const key = `chat:${roomId}:messages`;
    await redis.lpush(key, JSON.stringify(message));
    await redis.ltrim(key, 0, 99);  // keep last 100 messages
    await redis.expire(key, 86400); // expire after 24 hours
}

// ── Get message history ───────────────────────────────────
async function getMessages(roomId) {
    const key = `chat:${roomId}:messages`;
    const messages = await redis.lrange(key, 0, -1);
    return messages.map(m => JSON.parse(m)).reverse(); // oldest first
}

// ── Socket connection ─────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.user.email} | Socket: ${socket.id}`);

    // ── Join room ─────────────────────────────────────────
    socket.on('join_room', async ({ roomId, roomType }) => {
        socket.join(roomId);
        socket.roomId = roomId;
        socket.roomType = roomType || 'live';

        addToRoom(roomId, socket.user);

        console.log(`${socket.user.email} joined room: ${roomId} (${roomType})`);

        // Send message history
        const history = await getMessages(roomId);
        socket.emit('message_history', history);

        // Notify room someone joined
        io.to(roomId).emit('user_joined', {
            user: {
                id: socket.user.id,
                email: socket.user.email,
                role: socket.user.role
            },
            onlineCount: getRoomUsers(roomId).length
        });

        // Send current online users to the joiner
        socket.emit('online_users', getRoomUsers(roomId));
    });

    // ── Send message ──────────────────────────────────────
    socket.on('send_message', async ({ content, roomId }) => {
        if (!content || !roomId) return;

        const roomType = socket.roomType || 'live';

        // Commentary rooms — only admin can send
        if (roomType === 'commentary' && socket.user.role !== 'admin') {
            socket.emit('error', { message: 'Only admins can send commentary' });
            return;
        }

        // Webinar rooms — members can only send questions
        // Admin sends answers
        const messageType = roomType === 'webinar'
            ? socket.user.role === 'admin' ? 'answer' : 'question'
            : 'message';

        const message = {
            id: Date.now(),
            content,
            type: messageType,
            roomType,
            sender: {
                id: socket.user.id,
                email: socket.user.email,
                role: socket.user.role
            },
            timestamp: new Date().toISOString()
        };

        // Save to Redis
        await saveMessage(roomId, message);

        // Broadcast to room
        io.to(roomId).emit('new_message', message);

        console.log(`Message in ${roomId}: ${socket.user.email}: ${content}`);
    });

    // ── Typing indicator ──────────────────────────────────
    socket.on('typing', ({ roomId }) => {
        socket.to(roomId).emit('user_typing', {
            userId: socket.user.id,
            email: socket.user.email
        });
    });

    socket.on('stop_typing', ({ roomId }) => {
        socket.to(roomId).emit('user_stop_typing', {
            userId: socket.user.id
        });
    });

    // ── Admin pin message ─────────────────────────────────
    socket.on('pin_message', ({ roomId, message }) => {
        if (socket.user.role !== 'admin') {
            socket.emit('error', { message: 'Only admins can pin messages' });
            return;
        }
        io.to(roomId).emit('message_pinned', message);
        console.log(`Message pinned in ${roomId} by ${socket.user.email}`);
    });

    // ── Admin kick user ───────────────────────────────────
    socket.on('kick_user', ({ roomId, userId }) => {
        if (socket.user.role !== 'admin') {
            socket.emit('error', { message: 'Only admins can kick users' });
            return;
        }

        // Find and disconnect the target socket
        io.sockets.sockets.forEach((s) => {
            if (s.user?.id === userId && s.roomId === roomId) {
                s.emit('kicked', { message: 'You have been removed from this room' });
                s.leave(roomId);
                removeFromRoom(roomId, userId);
            }
        });

        io.to(roomId).emit('user_kicked', { userId });
        console.log(`User ${userId} kicked from ${roomId}`);
    });

    // ── Disconnect ────────────────────────────────────────
    socket.on('disconnect', () => {
        if (socket.roomId) {
            removeFromRoom(socket.roomId, socket.user.id);

            io.to(socket.roomId).emit('user_left', {
                userId: socket.user.id,
                email: socket.user.email,
                onlineCount: getRoomUsers(socket.roomId).length
            });
        }
        console.log(`User disconnected: ${socket.user.email}`);
    });
});

// ── REST — get room info ──────────────────────────────────
app.get('/chat/:roomId/users', (req, res) => {
    const users = getRoomUsers(req.params.roomId);
    res.json({ roomId: req.params.roomId, users, count: users.length });
});

// ── REST — get message history ────────────────────────────
app.get('/chat/:roomId/messages', async (req, res) => {
    try {
        const messages = await getMessages(req.params.roomId);
        res.json({ roomId: req.params.roomId, messages });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get messages' });
    }
});

// ── Health check ──────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'chat',
        port: PORT,
        activeRooms: Object.keys(rooms).length,
        totalOnline: Object.values(rooms).reduce(
            (sum, room) => sum + Object.keys(room).length, 0
        )
    });
});

// ── Start ─────────────────────────────────────────────────
connectDB().then(() => {
    server.listen(PORT, () => {
        console.log(`Chat service running on port ${PORT}`);
    });
});