'use strict';

const { fetch } = require('./functions');
const createBudget = require('./providerBudget');
const cache = new Map();
let activeKey;
let consumeBudget = createBudget();
let activeRequests = 0;
let nextTurn = Promise.resolve();
let blockedUntil = 0;

function limited(message) {
    const error = new Error(message);
    error.status = 429;
    error.statusCode = 429;
    return error;
}

async function providerRequest(endpoint, query) {
    if (!process.env.GRAPHHOPPER_KEY) {
        const error = new Error('GraphHopper is not configured');
        error.status = 503;
        throw error;
    }
    if (activeKey !== process.env.GRAPHHOPPER_KEY) {
        cache.clear();
        activeKey = process.env.GRAPHHOPPER_KEY;
        consumeBudget = createBudget();
        nextTurn = Promise.resolve();
        blockedUntil = 0;
    }
    const params = new URLSearchParams(query);
    params.delete('key');
    params.sort();
    const identity = endpoint + '?' + params;
    const cached = cache.get(identity);
    if (cached && cached.expires > Date.now()) return structuredClone(await cached.data);
    if (Date.now() < blockedUntil) throw limited('Routing provider requests are temporarily paused after a rate limit.');
    if (activeRequests >= 16) {
        throw limited('Too many active routing requests.');
    }
    consumeBudget();
    params.set('key', activeKey);
    const entry = {
        expires: Date.now() + 300000,
        data: (async () => {
            activeRequests++;
            try {
                const turn = nextTurn.then(() => new Promise(resolve => setTimeout(resolve, 300)));
                nextTurn = turn;
                await turn;
                if (Date.now() < blockedUntil) throw limited('Routing provider requests are temporarily paused after a rate limit.');
                const response = await fetch('https://graphhopper.com/api/1/' + endpoint + '?' + params, {
                    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000)
                });
                if (!response.ok) {
                    if (response.status === 429) blockedUntil = Date.now() + 60000;
                    const error = new Error('GraphHopper rejected the request');
                    error.status = [404, 429].includes(response.status) ? response.status : 502;
                    error.statusCode = response.status;
                    throw error;
                }
                const data = await response.json();
                if (endpoint === 'geocode' && !Array.isArray(data.hits)
                    || endpoint === 'route' && !Array.isArray(data.paths)) {
                    throw new Error('GraphHopper returned invalid data');
                }
                return data;
            } finally {
                activeRequests--;
            }
        })()
    };
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    cache.set(identity, entry);
    try {
        return structuredClone(await entry.data);
    } catch (error) {
        if (cache.get(identity) === entry) cache.delete(identity);
        throw error;
    }
}

providerRequest.clearCache = () => cache.clear();
module.exports = providerRequest;
