'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const request = require('../common/http');

test('native HTTP client preserves text, JSON, POST bodies, status failures and timeouts', async t => {
    const server = http.createServer(async (req, res) => {
        if (req.url === '/slow') {
            setTimeout(() => res.end('late'), 100);
            return;
        }
        if (req.url === '/limited') {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end('{"error":"limited"}');
            return;
        }
        if (req.url === '/invalid') return res.end('not json');
        if (req.url === '/text') return res.end('plain text');
        let body = '';
        for await (const chunk of req) body += chunk;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ method: req.method, body: body ? JSON.parse(body) : null, type: req.headers['content-type'] }));
    }).listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    assert.equal(await request(base + '/text'), 'plain text');
    const posted = await request({ uri: base, method: 'POST', json: true, body: { stops: ['A', 'B'] } });
    assert.equal(posted.method, 'POST');
    assert.equal(posted.type, 'application/json');
    assert.deepEqual(posted.body, { stops: ['A', 'B'] });
    await assert.rejects(request({ uri: base + '/limited', json: true }), { statusCode: 429, status: 429 });
    await assert.rejects(request({ uri: base + '/invalid', json: true }), SyntaxError);
    await assert.rejects(request({ uri: base + '/slow', timeout: 10 }), { name: 'TimeoutError' });
});
