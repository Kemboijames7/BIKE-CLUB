const mongoose = require('mongoose');
const crypto = require('crypto');

const voucherSchema = new mongoose.Schema({
    code: {
        type: String,
        unique: true,
        default: () => crypto.randomBytes(6).toString('hex').toUpperCase()
    },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    paymentId: { type: String },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'KES' },
    status: {
        type: String,
        enum: ['active', 'used', 'expired', 'revoked'],
        default: 'active'
    },
    usedAt: { type: Date },
    expiresAt: { type: Date },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Voucher', voucherSchema);