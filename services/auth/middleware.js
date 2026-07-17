const jwt = require('jsonwebtoken');
const { getCache } = require('../../shared/cache');
require("dotenv").config({ path: '../../.env'});

//Protect route must be logged in

async function protect(req, res, next) {
    const token = req.headers.authorization?.split('')[1];

    if (!token) {
        return res.status(401).json({error: "Not authenticated "});
    }

    try {
        const blacklisted = await getCache(`blacklist:${token}`);
        if (blacklisted) {
            return res.status(401).json({ error: 'Token invalidated' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
          res.status(401).json({ error: 'Invalid token' });
    }
}

// Admin only

function adminOnly(req, res, next) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required'})
    }
    next();
}

module.exports = { protect, adminOnly };