'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

process.env.OSM_PORT = '0';
process.env.POINT_PORT = '0';
process.env.PATH_PORT = '0';
process.env.PORT = '0';
process.env.DB_URL = '';
process.env.TOKEN_SECRET = '';
process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_CLIENT_SECRET = '';
process.env.GRAPHHOPPER_KEY = '';
process.env.WEATHER_API_KEY = '';
process.env.PUBLIC_URL = 'https://easytrip.example';

const startGuest = require('../guest');

test('public guest deployment starts without a database or OAuth and keeps internal services private', async t => {
    const servers = startGuest();
    t.after(async () => {
        await Promise.all(servers.map(server => new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
            server.closeAllConnections();
        })));
    });
    await Promise.all(servers.map(server => once(server, 'listening')));
    for (const server of servers.slice(0, -1)) assert.equal(server.address().address, '127.0.0.1');
    const facade = servers.at(-1);
    assert.equal(facade.address().address, '0.0.0.0');
    const base = 'http://127.0.0.1:' + facade.address().port;
    const health = await fetch(base + '/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const status = await fetch(base + '/v1/status');
    assert.deepEqual(await status.json(), { routing: false, weather: false });
    const home = await fetch(base);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Plan routes with interesting stops/);
    assert.match(html, /property="og:title"/);
    assert.match(html, /rel="canonical" href="https:\/\/easytrip.example\/"/);
    assert.match(html, /property="og:url" content="https:\/\/easytrip.example\/"/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(home.headers.get('x-powered-by'), null);
    const robots = await fetch(base + '/robots.txt');
    assert.equal(robots.status, 200);
    const robotText = await robots.text();
    assert.match(robotText, /Disallow: \/v1\//);
    assert.match(robotText, /Sitemap: https:\/\/easytrip.example\/sitemap.xml/);
    const sitemap = await fetch(base + '/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(await sitemap.text(), /<loc>https:\/\/easytrip.example\/<\/loc>/);
    for (const asset of ['/app.js', '/styles.css', '/favicon.svg', '/vendor/leaflet/leaflet.js', '/example-route.json']) {
        assert.equal((await fetch(base + asset)).status, 200, asset);
    }
    const route = await fetch(base + '/v1/trip/travel?start=Trento&end=Verona&limit=0');
    assert.equal(route.status, 503);
    assert.equal((await route.json()).code, 'ROUTING_NOT_CONFIGURED');
    assert.equal((await fetch(base + '/v1/users')).status, 404);
    assert.equal((await fetch(base + '/v1/history')).status, 404);
    const invalid = await fetch(base + '/v1/trip/route', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken'
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /valid JSON/);
    const oversized = await fetch(base + '/v1/trip/route', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(33000) })
    });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /too large/);
    let limited;
    for (let count = 0; count < 10; count++) {
        limited = await fetch(base + '/v1/trip/travel?start=Trento&end=Verona&limit=0');
        if (limited.status === 429) break;
    }
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, 'TOO_MANY_REQUESTS');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    process.env.PORT = 'invalid';
    assert.throws(() => startGuest(), /valid TCP port/);
    process.env.PORT = '0';
});
