const mongoose = require('mongoose')

const memberSchema = new mongoose.Schema({
    userId: { type: String, required:true },
    name: {type: String, default: ''},
    phone: { type: String, trim: true },
    avatar: { type: String, default: ''},
    bio: { type: String, default: ''},
    city: { type: String, default: ''},
    bikeType: {
        type: String,
        enum: ['road', 'mountain', 'hybrid', 'bmx', 'other'],
        default: 'other'
    },
    membershipStatus: {
        type: String,
        enum: ['active', 'inactive', 'suspended'],
        default: 'active'
    },
    joinedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Member', memberSchema)