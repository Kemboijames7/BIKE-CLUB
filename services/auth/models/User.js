const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
    name: {type: String, required: true, trim: true },
    email: {type: String, required: true, unique: true, lowercase: true },
    password: {type:String, required:true, minlength:6 },
    role: {type: String, enum: ['member', 'admin'], default: 'member' },
    isActive: {type: Boolean, default:true },
      resetPasswordToken: { 
        type: String, 
        default: null 
    },
    resetPasswordExpires: { 
        type: Date, 
        default: null 
    },
    createdAt: {type:Date, default: Date.now }
});

userSchema.pre('save', async function() {
    if (!this.isModified('password')) return;
    this.password = await bcrypt.hash(this.password, 12);
});

//Compare password

userSchema.methods.comparePassword = async function (candidatePassword) {
    return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);

