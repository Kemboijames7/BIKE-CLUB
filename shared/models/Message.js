const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    // Contact form fields
    name:    { type: String },
    email:   { type: String, required: true },
    subject: { type: String },
    message: { type: String },

    // Type of message
    type: {
        type: String,
        enum: ['contact', 'newsletter_subscribe', 'newsletter_unsubscribe', 'system'],
        default: 'contact'
    },

    read:    { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ContactMessage', messageSchema);