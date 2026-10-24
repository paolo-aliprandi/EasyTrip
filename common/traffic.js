'use strict';

const { rateLimit } = require('express-rate-limit');

function limiter(limit) {
    return rateLimit({
        windowMs: 60000,
        limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: {
            code: 'TOO_MANY_REQUESTS',
            error: 'Too many requests. Please wait a minute before trying again.'
        }
    });
}

module.exports = { browsing: limiter(60), planning: limiter(10) };
