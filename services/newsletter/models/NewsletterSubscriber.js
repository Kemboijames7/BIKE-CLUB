// shared/models/NewsletterSubscriber.js
const mongoose = require('mongoose');

const newsletterSubscriberSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    name: {
        type: String,
        trim: true
    },
    status: {
        type: String,
        enum: ['subscribed', 'unsubscribed', 'pending'],
        default: 'subscribed'
    },
    subscribedAt: {
        type: Date,
        default: Date.now
    },
    unsubscribeToken: {
        type: String,
        required: true,
        unique: true
    },
    consentGivenAt: {
        type: Date,
        default: Date.now
    },
    ipAddress: {
        type: String
    },
    source: {
        type: String,
        enum: ['website_form', 'registration', 'admin_import'],
        default: 'website_form'
    }
}, {
    timestamps: true
});

// Index for faster queries
newsletterSubscriberSchema.index({ email: 1, status: 1 });

module.exports = mongoose.model('NewsletterSubscriber', newsletterSubscriberSchema);