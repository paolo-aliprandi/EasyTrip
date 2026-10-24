'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const generateToken = require('../processes/auth/utils/tokenGenerator');
const verifyToken = require('../processes/auth/middleware/auth');

test('updated password hashing still verifies bcrypt password formats', async () => {
    const hash = await bcrypt.hash('test-only-password', 4);
    assert.equal(await bcrypt.compare('test-only-password', hash), true);
    assert.equal(await bcrypt.compare('incorrect-password', hash), false);
    assert.equal(await bcrypt.compare('test-only-password', hash.replace(/^\$2b\$/, '$2a$')), true);
});

test('updated JWT library preserves signed login tokens and rejects unsigned tokens', t => {
    const original = process.env.TOKEN_SECRET;
    process.env.TOKEN_SECRET = 'test-only-signing-key-not-a-real-credential';
    t.after(() => {
        if (original === undefined) delete process.env.TOKEN_SECRET;
        else process.env.TOKEN_SECRET = original;
    });
    const token = generateToken({ username: 'test-user', _id: 'test-id' });
    const decoded = jwt.verify(token, process.env.TOKEN_SECRET);
    assert.equal(decoded.username, 'test-user');
    assert.equal(decoded.user_id, 'test-id');
    assert.equal(decoded.exp - decoded.iat, 86400);
    const req = { body: {}, query: {}, headers: { 'x-access-token': token } };
    let passed = false;
    const res = { status(code) { this.statusCode = code; return this; }, send(body) { this.body = body; } };
    verifyToken(req, res, () => { passed = true; });
    assert.equal(passed, true);
    assert.equal(req.loggedUser.username, 'test-user');
    const unsigned = jwt.sign({ username: 'test-user' }, '', { algorithm: 'none' });
    verifyToken({ body: {}, query: {}, headers: { 'x-access-token': unsigned } }, res, () => assert.fail('Unsigned token accepted'));
    assert.equal(res.statusCode, 403);
});

test('schema conversion uses the patched shared Mongoose and preserves user/history fields', () => {
    const converterDirectory = path.dirname(require.resolve('convert-json-schema-to-mongoose'));
    assert.equal(require.resolve('mongoose', { paths: [converterDirectory] }), require.resolve('mongoose'));
    for (const [name, file] of [
        ['AuthCompatibility', '../processes/auth/models/users'],
        ['FacadeCompatibility', '../processes/EasyTripFacade/models/users']
    ]) {
        const schema = require(file);
        const Model = mongoose.model(name, schema);
        const user = new Model({
            username: 'test-user', psw: 'test-only-hash', email: 'test@example.invalid',
            history: [{ dateTime: new Date(), route: 'trip', type: 'travel', parameters: { start: 'A', end: 'B', profile: 'foot', limit: 1 } }]
        });
        assert.equal(user.validateSync(), undefined);
        assert.equal(user.googleaccount, false);
        assert.equal(user.history[0].parameters.profile, 'foot');
        assert.equal(user.history[0].parameters.limit, 1);
        assert.ok(user.history[0].dateTime instanceof Date);
        mongoose.deleteModel(name);
    }
});
