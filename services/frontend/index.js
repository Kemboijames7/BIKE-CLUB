const express = require('express');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const connectDB = require('../../shared/db');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const ContactMessage = require('../../shared/models/Message');
// ── Validate required env vars on startup ─────────────────
const REQUIRED_ENV = [
    'JWT_SECRET',
    'AUTH_SERVICE_URL',
    'MEMBER_SERVICE_URL',
    'EVENT_SERVICE_URL',
    'VOUCHER_SERVICE_URL',
    'PAYMENT_SERVICE_URL',
    'STRIPE_PUBLISHABLE_KEY'
];
 
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length > 0) {
    console.error('Missing required environment variables:', missing.join(', '));
    process.exit(1);
}
 
// ── Service URLs 
const SERVICES = {
    auth:     process.env.AUTH_SERVICE_URL,
    members:  process.env.MEMBER_SERVICE_URL,
    events:   process.env.EVENT_SERVICE_URL,
    vouchers: process.env.VOUCHER_SERVICE_URL,
    payments: process.env.PAYMENT_SERVICE_URL,
    chat:       process.env.CHAT_SERVICE_URL,   
    newsletter: process.env.NEWSLETTER_SERVICE_URL
};
 
const app = express();
const PORT = process.env.FRONTEND_PORT || 3001;
 
app.use(cookieParser());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
 

async function callService(url, token, method = 'get', body = null) {
    try {
        const headers = { 'Content-Type': 'application/json' };

        if (token) {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            headers['authorization'] = `Bearer ${token}`;
            headers['x-user-id'] = decoded.id;
            headers['x-user-role'] = decoded.role;
            headers['x-user-email'] = decoded.email;
        }

        let response;
        if (method === 'get') {
            response = await axios.get(url, { headers });
        } else if (method === 'put') {
            response = await axios.put(url, body, { headers }); 
        } else {
            response = await axios.post(url, body, { headers });
        }

        return { data: response.data, error: null, status: response.status };
    } catch (err) {
        return {
            data: null,
            error: err.response?.data?.error || err.message,
            status: err.response?.status || 500
        };
    }
}
//Auth helper
function getToken(req) {
    
    if (req.path.match(/\.(css|js|ico|png|jpg|woff|map)$/)) {
        return req.cookies?.token || req.query?.token || null;
    }

    const token = req.cookies?.token || req.query?.token || null;
    console.log('getToken - cookies:', req.cookies, 'query token:', req.query?.token, 'result:', token ? 'found' : 'null');
    return token;
}



//Home - show events
app.get('/', async (req, res) => {
    const token = getToken(req)
    const {type, page = 1 }= req.query;

    const { data } = await callService(
        `${SERVICES.events}/events?page=${page}$limit=9${type ? `&type=${type}` : ''}`,
        token
    );

    res.render('home', {
        token,
        events: data?.events || [],
        pagination: data?.pagination || {},
        currentType: type || 'all',
        error: null
    });
});

//-Register page
app.get('/register', (req, res) => {
    res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
        const { data, error } = await callService(
        `${SERVICES.auth}/auth/register`,
        null, 'post', { name, email, password }
    );
     if (error) {
        return res.render('register', { error });
    }
       // Check if data and token exist
    if (!data || !data.token) {
        console.error('Registration response missing token:', data);
        return res.render('register', { 
            error: 'Registration failed. Please try again.' 
        });
    }

       // Set token cookie
    res.setHeader('Set-Cookie', `token=${data.token}; Path=/; HttpOnly`);
    res.redirect('/dashboard');
})

app.get('/login', (req, res) => {
    res.render('login', {  error: null, token: null});
});

app.get('/forgot-password', (req, res) => {
    res.render('forgot-password', { 
        error: null, 
        success: null 
    });
});

app.post('/forgot-password', async (req, res) => {
    
        const { email } = req.body;
        
        const { data, error } = await callService(
        `${SERVICES.auth}/auth/forgot-password`,
        null,  // No token needed for forgot password
        'post',
        { email }
    );
        if (error) {
        // Don't reveal if email exists or not - generic error
        return res.render('forgot-password', {
            error: 'Unable to process request. Please try again.',
            success: null
        });
    }
    
    // Always show success message (prevents email enumeration)
    res.render('forgot-password', {
        success: data.message || 'If an account exists with that email, you will receive a password reset link.',
        error: null
    });
        
});


// ── Reset Password Page (verify token) ───────────────────
app.get('/reset-password/:token', async (req, res) => {
    const { token } = req.params;
    
    // Verify token with auth service
    const { data, error } = await callService(
        `${SERVICES.auth}/auth/verify-reset-token/${token}`,
        null,
        'get'
    );
    
    if (error || !data?.valid) {
        return res.render('reset-password', {
            error: 'Password reset link is invalid or has expired.',
            token: null,
            valid: false
        });
    }
    
    // Show reset form
    res.render('reset-password', {
        error: null,
        token: token,
        valid: true
    });
});


app.post('/reset-password/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const { password, confirmPassword } = req.body;
        
        // Validate passwords match
        if (password !== confirmPassword) {
            return res.render('reset-password', {
                error: 'Passwords do not match.',
                token: token,
                valid: true
            });
        }
        
        // Validate password strength
        if (password.length < 8) {
            return res.render('reset-password', {
                error: 'Password must be at least 8 characters.',
                token: token,
                valid: true
            });
        }
        
        const { data, error } = await callService(
        `${SERVICES.auth}/auth/reset-password`,
        null,
        'post',
        { token, password }
    );
        
           if (error) {
        return res.render('reset-password', {
            error: error || 'Failed to reset password. Please try again.',
            token: token,
            valid: true
        });
    }
        
        // Redirect to login with success message
        res.render('login', {
            success: 'Password has been reset successfully. Please login with your new password.',
            error: null,
            token: null
        });
        
    } catch (error) {
        console.error('Reset password error:', error);
        res.render('reset-password', {
            error: 'Something went wrong. Please try again.',
            token: req.params.token,
            valid: true
        });
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
       console.log('Login attempt:', email); 
    const { data, error } = await callService(
        `${SERVICES.auth}/auth/login`,
        null, 'post', { email, password }
    );

    console.log('data:', data);    // ← move before error check
    console.log('error:', error);  // ← see both regardless

    if (error) return res.render('login', { error });
    res.setHeader('Set-Cookie', `token=${data.token}; Path=/; HttpOnly`);
    res.redirect('/dashboard'); 
});
// ── Logout ────────────────────────────────────────────────
app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    res.redirect('/login');
});

// ── Member dashboard ──────────────────────────────────────
app.get('/dashboard', async (req, res) => {
    const token = getToken(req);
    if (!token) return res.redirect('/login');

    const [profileRes, vouchersRes, eventsRes] = await Promise.all([
        callService(`${SERVICES.members}/members/profile`, token),
        callService(`${SERVICES.vouchers}/vouchers/my`, token),
        callService(`${SERVICES.events}/events?limit=6`, token)
    ]);


    if (profileRes.error) return res.redirect('/login');

    const decoded = jwt.decode(token);
    
    res.render('dashboard', {
        token,
        member: {
             ...profileRes.data?.member,
              email: decoded?.email 
        } || {},
        vouchers: vouchersRes.data?.vouchers || [],
        events: eventsRes.data?.events || [],
        success: req.query.success || null,
        error: req.query.error || null
    });
});

// ── Single event page ─────────────────────────────────────
app.get('/events/:id', async (req, res) => {
    const token = getToken(req);

    const { data, error } = await callService(
        `${SERVICES.events}/events/${req.params.id}`,
        token
    );

    if (error) return res.redirect('/');

    res.render('event', {
         token, event: data.event });
});

// ── Payment page ──────────────────────────────────────────
app.get('/events/:id/pay', async (req, res) => {
    const token = getToken(req);
    if (!token) return res.redirect('/login');

    const { data, error } = await callService(
        `${SERVICES.events}/events/${req.params.id}`,
        token
    );

    if (error) return res.redirect('/');

    res.render('payment', {
        token,
        event: data.event,
        error: req.query.error || null,
        stripeKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
});

/// ── Stripe payment ────────────────────────────────────────
app.post('/events/:id/pay/stripe', async (req, res) => {
    const token = getToken(req);
    if (!token) return res.redirect('/login');

    const { paymentMethodId, amount } = req.body;
    const eventId = req.params.id;

    const { data, error, status } = await callService(
        `${SERVICES.payments}/payments/stripe`,
        token,
        'post',
        { eventId, amount: Number(amount), paymentMethodId, currency: 'usd' }
    );

    if (status === 409) {
        return res.redirect(`/events/${eventId}/pay?error=You already have a voucher for this event`);
    }

    if (error) {
        return res.redirect(`/events/${eventId}/pay?error=${error}`);
    }
    res.redirect(`/dashboard?success=Payment successful! Check your vouchers.`);
});

// ── MPesa payment ─────────────────────────────────────────
app.post('/events/:id/pay/mpesa', async (req, res) => {
    const token = getToken(req);
    if (!token) return res.redirect('/login');

    console.log('Mpesa payment hit:', req.params.id);
    console.log('Body:', req.body);

    const { phone, amount } = req.body;
    const eventId = req.params.id;

    const { data, error, status } = await callService(
        `${SERVICES.payments}/payments/mpesa`,
        token, 'post',
        { eventId, amount: Number(amount), phone }
    );

    if (status === 409) {
        return res.redirect(`/events/${eventId}/pay?error=You already have a voucher for this event`);
    }

    if (error) {
        return res.redirect(`/events/${eventId}/pay?error=${error}`);
    }

    res.redirect(`/payment/pending?checkoutId=${data.checkoutRequestId}&eventId=${eventId}`);
});

// ── MPesa pending page ────────────────────────────────────
app.get('/payment/pending', (req, res) => {
    const token = getToken(req);
    res.render('payment-pending', {
        token,
        checkoutId: req.query.checkoutId,
        eventId: req.query.eventId
    }); 
});

// ── MPesa payment status ──────────────────────────────────
app.get('/payment/status/:checkoutId', async (req, res) => {
    const token = getToken(req);
      console.log('[STATUS PROXY] Checking:', req.params.checkoutId);
    try {
        const { data } = await axios.get(
            `${SERVICES.payments}/payments/status/${req.params.checkoutId}`,
            { headers: { authorization: `Bearer ${token}` } }
        );
         console.log('[STATUS PROXY] Response from payment service:', data);
        res.json(data);
    } catch (err) {
  console.error('[STATUS PROXY] Error:', err.response?.status, err.response?.data || err.message);
        res.status(500).json({ status: 'error', message: 'Status check failed' });
    }
});

// ── Purchase voucher ──────────────────────────────────────
app.post('/events/:id/purchase', async (req, res) => {
    const token = getToken(req);
    if (!token) return res.redirect('/login');

    const { amount } = req.body;
    const { data, error } = await callService(
        `${SERVICES.vouchers}/vouchers/purchase`, 
        token, 'post',
       { eventId: req.params.id, amount: 0, paymentId: 'free' }
    ); 

    if (error) {
        return res.redirect(`/events/${req.params.id}?error=${error}`);
    }

    res.redirect(`/dashboard?success=Voucher purchased! Code: ${data.voucher.code}`);
});

//── Profile page ──────────────────────────────────────────
app.get('/profile', async (req, res) => {
    const token = getToken(req);
    if (!token) return res.redirect('/login');

    // Decode the token (no need to verify — gateway already did that)
    const decoded = jwt.decode(token);

    try {
        const { data } = await axios.get(
            `${SERVICES.members}/members/profile`,
            {
                headers: {
                    'x-user-id':    decoded.id,
                    'x-user-role':  decoded.role,
                    'x-user-email': decoded.email
                }
            }
        );

        res.render('profile', {
             token, 
            member: data.member,
            success: req.query.success || null,
            error: req.query.error || null
        });

    } catch (err) {
        console.log('STATUS:', err.response?.status);
        console.log('ERROR:', err.response?.data);
        res.render('profile', {
             token, 
            member: { phone: '', city: '', bikeType: 'other', bio: '' },
            success: null,
            error: 'Could not load profile'
        });
    }
});

// GET /profile
// app.get('/profile', async (req, res) => {
//     const token = getToken(req);
//     if (!token) return res.redirect('/login');

//     const { data, error } = await callService(
//         'http://localhost:4002/members/profile',
//         token
//     );

//     if (error) {
//         return res.render('profile', {
//              token, 
//             member: { phone: '', city: '', bikeType: 'other', bio: '', name: '' },
//             success: null,
//             error: 'Could not load profile'
//         });
//     }

//     res.render('profile', {
//          token, 
//         member: data.member,
//         success: req.query.success || null,
//         error: req.query.error || null
//     });
// });

// POST /profile
app.post('/profile', async (req, res) => {
    const token = getToken(req);
    if (!token) return res.redirect('/login');

    const { name, phone, city, bikeType, bio } = req.body;

    const { error } = await callService(
        `${SERVICES.members}/members/profile`,
        token,'put',
        {
        name:      name?.trim(),
        phone:    phone?.trim(),
        city:     city?.trim(),
        bikeType: bikeType?.trim(),
        bio:      bio?.trim() 
     }
    );

    if (error) {
        return res.redirect(`/profile?error=${encodeURIComponent(error)}`);
    }

    res.redirect('/profile?success=Profile updated');
});

//Vouchers 
app.get('/vouchers', async (req, res) => {
    const token = getToken(req);
    if (!token) return res.redirect('/login');

    const { data, error } = await callService(
        `${SERVICES.vouchers}/vouchers/my`,
        token
    );

      try {
        res.render('my-vouchers', {
            token,
            vouchers: data?.vouchers || [],
            success:  req.query.success || null,
            error:    error || req.query.error || null
        });
    } catch (renderErr) {
        console.log('Render error:', renderErr.message);
        res.send(renderErr.message);
    }
});

app.get('/members', async (req, res) => {
    const token = getToken(req);
    if (!token) return res.redirect('/login');

    const { data, error } = await callService(
        `${SERVICES.members}/members`,
        token
    ); 

    if (error) return res.redirect('/dashboard');

    res.render('members', {
        token,
        members: data.members,
        error: error || null
    });
});

// ── Terms of Use ──────────────────────────────────────────
app.get('/terms', (req, res) => {
    const token = getToken(req);
    res.render('terms', { token });
});




// Serve newsletter signup page
app.get('/newsletter', (req, res) => {
    res.render('newsletter', { 
        token: getToken(req),
        error: null,
        success: null 
    });
});

// ── Newsletter subscribe API ───────────────────────────────
app.post('/api/newsletter/subscribe', async (req, res) => {
    const { email, name } = req.body;

    const { data, error } = await callService(
         `${SERVICES.newsletter}/newsletter/subscribe`,
        null, 'post', { email, name }
    );

    if (error) return res.status(400).json({ error });
    res.json(data);
});

// ── Newsletter unsubscribe page ────────────────────────────
app.get('/newsletter/unsubscribe/:token', async (req, res) => {
    const { data, error } = await callService(
        `${SERVICES.newsletter}/newsletter/unsubscribe/${req.params.token}`,
        null, 'get'
    );

    res.render('unsubscribe', {
        token: getToken(req),
        message: data?.message || error,
        success: !error
    });
});

app.get('/contact', (req, res) => {
    res.render('contact', { success: req.query.success, error: req.query.error });
});

app.post('/contact', async (req, res) => {
    const { name, email, subject, message } = req.body;
    
    try {
        await ContactMessage.create({
            name,
            email,
            subject,
            message,
            type: 'contact',
            read: false
        });
        res.redirect('/contact?success=Thanks! We\'ll get back to you soon.');
    } catch (err) {
        console.error('Contact form error:', err.message);
        res.redirect('/contact?error=Failed to send message. Please try again.');
    }
});

// ── Chat page ─────────────────────────────────────────────
app.get('/events/:id/chat', async (req, res) => {
    const token = getToken(req);
    if (!token) return res.redirect('/login');

    const { data, error } = await callService(
         `${SERVICES.events}/events/${req.params.id}`,
        token
    );

    if (error) return res.redirect('/');

    res.render('chat', {
        token,
        event: data.event,
        eventId: req.params.id,
        chatServiceUrl: process.env.CHAT_SERVICE_URL || 'http://localhost:4006'
    });
});

// ── Get chat history ──────────────────────────────────────
app.get('/api/chat/:roomId/messages', async (req, res) => {
    const token = getToken(req);

    try {
        const { data } = await axios.get(
             `${SERVICES.chat}/chat/${req.params.roomId}/messages`,
            { headers: { authorization: `Bearer ${token}` } }
        );
        res.json(data);
    } catch (err) {
        res.json({ messages: [] });
    }
});

// ── Get online users in room ──────────────────────────────
app.get('/api/chat/:roomId/users', async (req, res) => {
    const token = getToken(req);

    try {
        const { data } = await axios.get(
            `${SERVICES.chat}/chat/${req.params.roomId}/users`,
            { headers: { authorization: `Bearer ${token}` } }
        );
        res.json(data);
    } catch (err) {
        res.json({ users: [], count: 0 });
    }
});


// ── Health ────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'frontend', port: PORT });
});

// ── Start ─────────────────────────────────────────────────
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Frontend running on port ${PORT}`);
        console.log(`Open: http://localhost:${PORT}`);
    });
});