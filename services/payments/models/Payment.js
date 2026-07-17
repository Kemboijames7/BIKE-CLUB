const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'KES' },
    method: {
        type: String,
        enum: ['stripe', 'mpesa'],
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'refunded'],
        default: 'pending'
    },
    stripePaymentId: { type: String },
    checkoutRequestId: { type: String },
    mpesaReceiptNumber: { type: String },
    phone: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Payment', paymentSchema);