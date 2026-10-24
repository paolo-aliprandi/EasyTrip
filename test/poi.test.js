'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const functions = require('../common/functions');
let providerFetch;
functions.fetch = (...args) => providerFetch(...args);
const controller = require('../processes/EasyTripFacade/controllers/poiController');

const response = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
});

beforeEach(() => {
    controller.clearCache();
    providerFetch = async () => { throw new Error('Unexpected external request'); };
});

function metadataProvider(inspect = () => {}) {
    return async (uri, options) => {
        inspect(new URL(uri), options);
        return {
            ok: true,
            json: async () => uri.includes('api.openstreetmap.org') ? {
                elements: [{ type: 'node', id: 123, tags: {
                    name: 'City Museum', tourism: 'museum', wikidata: 'Q123',
                    'addr:street': 'Museum Street', 'addr:housenumber': '2',
                    opening_hours: 'Mo-Fr 10:00-18:00', website: 'https://museum.example/'
                } }]
            } : uri.includes('www.wikidata.org') ? {
                entities: { Q123: {
                    descriptions: { en: { value: 'A local history museum.' } },
                    claims: { P18: [{ mainsnak: { datavalue: { value: 'City Museum.jpg' } } }] },
                    sitelinks: { enwiki: { title: 'City Museum' } }
                } }
            } : { query: { pages: [{ imageinfo: [{
                thumburl: 'https://thumb.wikimedia.org/museum.jpg',
                extmetadata: {
                    Artist: { value: '<a href="https://commons.wikimedia.org">Photo author</a>' },
                    LicenseShortName: { value: 'CC BY-SA 4.0' },
                    LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' }
                }
            }] }] } }
        };
    };
}

test('POI cards use identity-linked photos with factual details and photo attribution', async () => {
    const calls = [];
    providerFetch = metadataProvider((url, options) => {
        calls.push(url);
        assert.ok(options.signal instanceof AbortSignal);
    });
    const res = response();
    await controller.details({ params: { type: 'node', id: '123' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.description, 'A local history museum.');
    assert.equal(res.body.openingHours, 'Mo-Fr 10:00-18:00');
    assert.equal(res.body.image.author, 'Photo author');
    assert.equal(res.body.image.license, 'CC BY-SA 4.0');
    assert.equal(res.body.image.url, 'https://thumb.wikimedia.org/museum.jpg');
    assert.ok(res.body.image.sourceUrl.includes('City%20Museum.jpg'));
    assert.equal(calls.length, 3);
    assert.equal(calls[2].searchParams.get('titles'), 'File:City Museum.jpg');
    assert.deepEqual(res.body.warnings, []);
});

test('parallel and repeated POI detail opens reuse metadata instead of spending more requests', async () => {
    let calls = 0;
    providerFetch = metadataProvider(() => calls++);
    await Promise.all([controller.details({ params: { type: 'node', id: '123' } }, response()),
        controller.details({ params: { type: 'node', id: '123' } }, response())]);
    await controller.details({ params: { type: 'node', id: '123' } }, response());
    assert.equal(calls, 3);
});

test('a POI without a real image never receives an unrelated or generated photo', async () => {
    providerFetch = async () => ({
        ok: true, json: async () => ({ elements: [{ type: 'node', id: 123, tags: { name: 'Small Museum', tourism: 'museum' } }] })
    });
    const res = response();
    await controller.details({ params: { type: 'node', id: '123' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.image, null);
    assert.equal(res.body.name, 'Small Museum');
});

test('optional metadata outages preserve basic OSM information with an explicit warning', async () => {
    const successful = metadataProvider();
    providerFetch = async (...args) => args[0].includes('wikidata.org') ? { ok: false, status: 503 } : successful(...args);
    const res = response();
    await controller.details({ params: { type: 'node', id: '123' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.openingHours, 'Mo-Fr 10:00-18:00');
    assert.equal(res.body.image, null);
    assert.match(res.body.warnings[0], /temporarily unavailable/);
});

test('untrusted image hosts and non-HTTP website links are rejected', async () => {
    const successful = metadataProvider();
    providerFetch = async (...args) => {
        const result = await successful(...args);
        const body = await result.json();
        if (args[0].includes('openstreetmap.org')) body.elements[0].tags.website = 'javascript:alert(1)';
        if (args[0].includes('commons.wikimedia.org')) body.query.pages[0].imageinfo[0].thumburl = 'https://untrusted.example/image.jpg';
        return { ok: true, json: async () => body };
    };
    const res = response();
    await controller.details({ params: { type: 'node', id: '123' } }, res);
    assert.equal(res.body.website, null);
    assert.equal(res.body.image, null);
    assert.match(res.body.warnings[0], /Photo/);
});

test('missing or failed OSM objects do not become successful POI details', async () => {
    for (const status of [404, 503]) {
        providerFetch = async () => ({ ok: false, status });
        const res = response();
        await controller.details({ params: { type: 'node', id: '123' } }, res);
        assert.equal(res.statusCode, status === 404 ? 404 : 502);
    }
});

for (const params of [
    { type: 'user', id: '123' }, { type: 'node', id: '../123' },
    { type: 'node', id: '0' }, { type: 'node', id: 'https://example.com' }
]) {
    test('invalid POI identifiers never trigger external requests: ' + JSON.stringify(params), async () => {
        const res = response();
        await controller.details({ params }, res);
        assert.equal(res.statusCode, 400);
    });
}
