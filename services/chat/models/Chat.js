const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true,
        index: true
    },
    roomType: {
        type: String,
        enum: ['live', 'webinar', 'commentary'],
        default: 'live'
    },
    type: {
        type: String,
        enum: ['message', 'question', 'answer'],
        default: 'message'
    },
    content: {
        type: String,
        required: true,
        maxlength: 1000
    },
    sender: {
        id: { type: String, required: true },
        email: { type: String, required: true },
        role: { type: String, enum: ['member', 'admin'] }
    },
    pinned: {
        type: Boolean,
        default: false
    },
    eventId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Event'
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    }
});

// Auto delete messages older than 30 days
messageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

// Compound index for fast room queries
messageSchema.index({ roomId: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);