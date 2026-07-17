const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
    title: {type: String, required: true, trim: true},
    description: {type: String, required: true},
    type: {
        type: String,
        enum: ['ride', 'campaign', 'webinar', 'race', 'social'],
        required: true
    },
    location: { type: String, required: true},
    date: {type: Date, required: true},
    endDate: { type: Date },
    image: { type: String, default:''},
    capacity: { type: Number, required: true},
    registered: { type: Number, default: 0 },
    price: { type: Number, default: 0},
    currency: { type: String, default: 'KES'},
    status: {
        type: String,
        enum: ['upcoming', 'ongoing', 'completed', 'cancelled'],
        default: 'upcoming'
    },
    hasLiveChat: {type: Boolean, default: false },
    hasCommentary: { type: Boolean, default: false},
    createdBy: {type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Event', eventSchema);