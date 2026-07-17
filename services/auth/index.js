const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const connectDB = require('../../shared/db');
const { setCache, getCache, deleteCache } = require('../../shared/cache');
const { enqueue } = require('../../shared/queue');
const User = require('./models/User');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const crypto = require('crypto');

const app = express();
const PORT = process.env.AUTH_PORT || 4001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Helper ────────────────────────────────────────────────
function generateToken(user) {
    return jwt.sign(
        { id: user._id, role: user.role, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
}

// ── Register ──────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {   // ← was requestAnimationFrame
    const { name, email, password } = req.body;

    try {
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const existing = await User.findOne({ email });
        if (existing) {
            return res.status(409).json({ error: 'Email already registered' });
        }

 console.log('Step 1: Creating user...');
    const user = await User.create({ name, email, password });
    console.log('Step 1 OK:', user._id);


    // Step 2 - test token generation
    console.log('Step 2: Generating token...');
    console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET);
    const token = generateToken(user);
    console.log('Step 2 OK:', token ? 'token generated' : 'token empty');

        console.log('Step 3: Caching session...');
        // ← was 'session:${user._id' (broken template literal)
        await setCache(`session:${user._id}`, {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role
        }, 604800);
         console.log('Step 3 OK');

          console.log('Step 4: Queuing email...');
        await enqueue('notifications', {
            type: 'welcome',
            to: user.email,
            name: user.name
        });

        console.log('Step 4 OK');

        res.status(201).json({
            message: 'Registration successful',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });

    } catch (err) {
        console.error('Register error:', err.message);
        res.status(500).json({
            error: 'Registration failed',
            detail: err.message });
    }
});

// ── Login ─────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        if (!user.isActive) {
            return res.status(403).json({ error: 'Account suspended. Contact support.' });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = generateToken(user);

        await setCache(`session:${user._id}`, {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role
        }, 604800);

        console.log('User logged in:', email);

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });

    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Login failed' });
    }
});

// ── Logout ────────────────────────────────────────────────
app.post('/auth/logout', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1]; // ← was split('')[1]

    if (!token) {
        return res.status(400).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET); // ← was jwt.verity

        await deleteCache(`session:${decoded.id}`);
        await setCache(`blacklist:${token}`, true, 604800);

        console.log('User logged out:', decoded.email);
        res.json({ message: 'Logged out successfully' });

    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
});

// ── Get current user ──────────────────────────────────────
app.get('/auth/me', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1]; // ← was split('')[1]

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const blacklisted = await getCache(`blacklist:${token}`);
        if (blacklisted) {
            return res.status(401).json({ error: 'Token invalidated' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const cached = await getCache(`session:${decoded.id}`);
        if (cached) {
            return res.json({ user: cached });
        }

        // ← was missing DB fallback
        const user = await User.findById(decoded.id).select('-password');
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ user });

    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
});

// ── Validate token — gateway calls this ──────────────────
app.get('/auth/validate', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1]; // ← was split('')[1]

    if (!token) {
        return res.status(401).json({ valid: false, error: 'No token' });
    }

    try {
        const blacklisted = await getCache(`blacklist:${token}`); // ← was broken string
        if (blacklisted) {
            return res.status(401).json({ valid: false, error: 'Token invalidated' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        res.json({ valid: true, user: decoded });

    } catch (err) {
        res.status(401).json({ valid: false, error: 'Invalid token' });
    }
});

// ── Forgot Password ──────────────────────────────────────────
app.post('/auth/forgot-password', async (req, res) => {
    const { email } = req.body;

    try {
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Find user (don't reveal if exists for security)
        const user = await User.findOne({ email });
        
        // Always generate a token (prevents email enumeration attacks)
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetExpires = Date.now() + 3600000; // 1 hour from now
        
        if (user && user.isActive) {
            // Store reset token in database
            user.resetPasswordToken = resetToken;
            user.resetPasswordExpires = resetExpires;
            await user.save();
            
            // Queue password reset email
            await enqueue('notifications', {
                type: 'password_reset',
                to: user.email,
                name: user.name,
                resetToken: resetToken,
                resetUrl: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/reset-password/${resetToken}`
            });
            
            console.log(`Password reset requested for: ${email}`);
        } else {
            // Log but don't reveal - just for monitoring
            console.log(`Password reset attempted for non-existent/inactive email: ${email}`);
        }
        
        // Always return success (prevents email enumeration)
        res.json({ 
            message: 'If an account exists with that email, you will receive a password reset link.' 
        });

    } catch (err) {
        console.error('Forgot password error:', err.message);
        res.status(500).json({ error: 'Unable to process request' });
    }
});

// ── Verify Reset Token ──────────────────────────────────────
app.get('/auth/verify-reset-token/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const user = await User.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: Date.now() }
        });

        if (!user) {
            return res.json({ valid: false });
        }

        res.json({ valid: !!user });

    } catch (err) {
        console.error('Verify token error:', err.message);
        res.json({ valid: false });
    }
});

// ── Reset Password ──────────────────────────────────────────
app.post('/auth/reset-password', async (req, res) => {
    const { token, password } = req.body;

    try {
        if (!token || !password) {
            return res.status(400).json({ error: 'Token and password are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Find user with valid reset token
        const user = await User.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ error: 'Password reset link is invalid or has expired' });
        }

        // Update password (model will hash it automatically if you have pre-save hook)
        user.password = password;
        user.resetPasswordToken = null;
        user.resetPasswordExpires = null;
        await user.save();

        // Invalidate all existing sessions for this user (security best practice)
        await deleteCache(`session:${user._id}`);
        
        // Queue password changed confirmation email
        await enqueue('notifications', {
            type: 'password_changed',
            to: user.email,
            name: user.name
        });

        console.log(`Password reset successful for: ${user.email}`);

        res.json({ message: 'Password has been reset successfully' });

    } catch (err) {
        console.error('Reset password error:', err.message);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// ── Health check ──────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'auth', port: PORT });
});

// ── Start ─────────────────────────────────────────────────
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Auth service running on port ${PORT}`);
    });
});

