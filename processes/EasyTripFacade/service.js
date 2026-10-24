'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// require apiV1 routes
const apiV1 = require('./routes/api.v1');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org https://upload.wikimedia.org https://thumb.wikimedia.org; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    next();
});
if (process.env.EASYTRIP_GUEST_ONLY === 'true') {
    if (process.env.RENDER === 'true') app.set('trust proxy', 1);
    const traffic = require('../../common/traffic');
    app.use('/v1', traffic.browsing);
    app.use(['/v1/trip/travel', '/v1/trip/route', '/v1/trip/places'], traffic.planning);
}

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors());

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.use('/v1', apiV1);
app.use('/v1', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
const publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
if (publicUrl) {
    const url = new URL(publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('PUBLIC_URL must be an HTTP or HTTPS origin without credentials or a path.');
    }
    const home = url.origin + '/';
    const html = fs.readFileSync(path.resolve(__dirname, '../../public/index.html'), 'utf8')
        .replace('</head>', `    <link rel="canonical" href="${home}" />\n    <meta property="og:url" content="${home}" />\n  </head>`);
    app.get('/', (req, res) => res.type('html').send(html));
    app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>'
        + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        + '<url><loc>' + home + '</loc></url></urlset>'
    ));
    app.get('/robots.txt', (req, res) => res.type('text/plain').send(
        'User-agent: *\nAllow: /\nDisallow: /v1/\nDisallow: /healthz\nDisallow: /example-route.json\n'
        + 'Sitemap: ' + url.origin + '/sitemap.xml\n'
    ));
}
app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/dist/leaflet.js'))));
app.get('/example-route.json', (req, res) => res.sendFile(path.resolve(__dirname, '../../docExamples/miniPath.json')));
app.use(express.static(path.resolve(__dirname, '../../public')));
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('Facade request failed:', error.type || error.name);
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({
        error: status === 413 ? 'The request is too large.'
            : status === 400 ? 'Provide a valid JSON request.'
            : 'The trip service could not process this request.'
    });
});

module.exports = app;