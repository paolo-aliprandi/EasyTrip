'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const createBudget = require('../common/providerBudget');

test('routing budget bounds each minute and recovers after its window', t => {
    let now = 100000;
    t.mock.method(Date, 'now', () => now);
    const consume = createBudget();
    for (let i = 0; i < 30; i++) consume();
    assert.throws(consume, { status: 429, statusCode: 429 });
    now += 60000;
    assert.doesNotThrow(consume);
});

test('routing budget bounds daily usage even when requests are spread across minutes', t => {
    let now = 100000;
    t.mock.method(Date, 'now', () => now);
    const consume = createBudget();
    for (let i = 0; i < 400; i++) {
        consume();
        now += 3000;
    }
    assert.throws(consume, { status: 429 });
    now += 86400000;
    assert.doesNotThrow(consume);
});
