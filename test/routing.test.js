'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const httpPath = require.resolve('../common/http');
require(httpPath);
let request;
require.cache[httpPath].exports = (...args) => request(...args);
const functions = require('../common/functions');
let providerFetch;
functions.fetch = (...args) => providerFetch(...args);
const graphhopper = require('../common/graphhopper');
const facade = require('../processes/EasyTripFacade/controllers/tripController');
const pathController = require('../processes/pathSearch/controllers/pathController');
const adapter = require('../processes/OSMTools/controllers/routingAdapter');
const poiAdapter = require('../processes/OSMTools/controllers/POIAdapter');
const combined = require('../processes/pointSearch/controllers/OSMcombinedController');
const weather = require('../processes/pointSearch/controllers/weatherController');
const fixture = require('../docExamples/miniPath.json');
const originalKey = process.env.GRAPHHOPPER_KEY;
const originalWeather = process.env.WEATHER_API_KEY;
const start = { name: 'Trento', point: { lat: 46.06, lng: 11.12 } };
const end = { name: 'Verona', point: { lat: 45.44, lng: 10.99 } };
const stops = { start, end, intermediates: [] };
const routeResult = () => ({ route: { paths: [structuredClone(fixture)] }, stops: structuredClone(stops) });
const response = () => ({
    statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
});
let keySequence = 0;

beforeEach(() => {
    graphhopper.clearCache();
    process.env.GRAPHHOPPER_KEY = 'test-only-placeholder-' + ++keySequence;
    delete process.env.WEATHER_API_KEY;
    request = async () => { throw new Error('Unexpected internal request'); };
    providerFetch = async () => { throw new Error('Unexpected external request'); };
});

after(() => {
    if (originalKey === undefined) delete process.env.GRAPHHOPPER_KEY;
    else process.env.GRAPHHOPPER_KEY = originalKey;
    if (originalWeather === undefined) delete process.env.WEATHER_API_KEY;
    else process.env.WEATHER_API_KEY = originalWeather;
});

for (const profile of ['car', 'bike', 'foot']) {
    test('no-stop route preserves travel mode: ' + profile, async () => {
        const calls = [];
        request = async options => { calls.push(options); return routeResult(); };
        const res = response();
        await facade.travel({ query: { start: 'Trento', end: 'Verona', profile, limit: '0' } }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(new URL(calls[0].uri).searchParams.get('profile'), profile);
        assert.equal(calls.length, 1, 'basic routes should not geocode endpoints again for optional descriptions');
        assert.deepEqual(res.body.start.address, start);
    });
}

test('addresses and repeated interests are encoded safely', async () => {
    let routeQuery;
    request = async options => {
        const url = new URL(options.uri);
        if (url.pathname === '/v1/path/route') { routeQuery = url.searchParams; return routeResult(); }
        return { address: end };
    };
    await facade.travel({ query: { start: 'A & B #1', end: 'Café + Park', profile: 'foot', limit: '1', interest: ['tourism', 'sustenance'] } }, response());
    assert.equal(routeQuery.get('start'), 'A & B #1');
    assert.equal(routeQuery.get('end'), 'Café + Park');
    assert.deepEqual(routeQuery.getAll('interest'), ['tourism', 'sustenance']);
});

test('guest planning reuses discovered POIs without optional POI or place lookups', async () => {
    let calls = 0;
    const poi = { type: 'node', id: 1, lat: 45.89, lon: 11.04, tags: { name: 'Museum', tourism: 'museum' } };
    request = async options => {
        calls++;
        assert.ok(options.uri.includes('/v1/path/route'));
        assert.equal(new URL(options.uri).searchParams.get('poisDescriptions'), 'true');
        return {
            ...routeResult(),
            stops: { ...structuredClone(stops), intermediates: [{ details: end, pois: [poi] }] }
        };
    };
    const res = response();
    await facade.travel({ query: { start: 'Trento', end: 'Verona', limit: '2', interest: 'tourism' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls, 1);
    assert.deepEqual(res.body.intermediates[0].poi, [poi]);
});

test('routing provider limits reach the facade as an actionable 429', async () => {
    request = async () => { const error = new Error('Limited'); error.statusCode = 429; throw error; };
    const res = response();
    await facade.travel({ query: { start: 'Praga', end: 'Brno', profile: 'bike' } }, res);
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'ROUTING_RATE_LIMITED');
    assert.match(res.body.error, /minute/);
});

test('initial lookup and final route limits are preserved by the path service', async () => {
    request = async () => { const error = new Error('Limited'); error.statusCode = 429; throw error; };
    const lookup = response();
    await pathController.routeGET({ query: { start: 'Praga', end: 'Brno', limit: '0', profile: 'bike' } }, lookup);
    assert.equal(lookup.statusCode, 429);
    const route = response();
    await pathController.routePOST({ query: { profile: 'bike' }, body: { stops } }, route);
    assert.equal(route.statusCode, 429);
});

test('GraphHopper requests are coalesced, cached, and isolated from caller mutations', async () => {
    let calls = 0;
    providerFetch = async () => { calls++; return { ok: true, json: async () => ({ hits: [structuredClone(start)] }) }; };
    const query = new URLSearchParams({ q: 'Trento', limit: '1' });
    const [first, second] = await Promise.all([graphhopper('geocode', query), graphhopper('geocode', query)]);
    first.hits[0].name = 'Changed';
    assert.equal(second.hits[0].name, 'Trento');
    assert.equal((await graphhopper('geocode', query)).hits[0].name, 'Trento');
    assert.equal(calls, 1);
    assert.equal(query.has('key'), false);
});

test('GraphHopper cache expires and provider errors are never cached', async context => {
    let now = 1000;
    context.mock.method(Date, 'now', () => now);
    let calls = 0;
    providerFetch = async () => { calls++; return { ok: true, json: async () => ({ hits: [] }) }; };
    const query = new URLSearchParams({ q: 'Trento' });
    await graphhopper('geocode', query);
    now += 300001;
    await graphhopper('geocode', query);
    assert.equal(calls, 2);
    graphhopper.clearCache();
    providerFetch = async () => { calls++; return { ok: false, status: 404 }; };
    await assert.rejects(graphhopper('geocode', query), { status: 404 });
    await assert.rejects(graphhopper('geocode', query), { status: 404 });
    assert.equal(calls, 4);
});

test('GraphHopper parallel searches are paced instead of sent as a quota-exhausting burst', async () => {
    const started = [];
    providerFetch = async () => {
        started.push(Date.now());
        return { ok: true, json: async () => ({ hits: [] }) };
    };
    await Promise.all(['one', 'two', 'three'].map(q => graphhopper('geocode', new URLSearchParams({ q }))));
    assert.equal(started.length, 3);
    assert.ok(started[1] - started[0] >= 250);
    assert.ok(started[2] - started[1] >= 250);
});

test('a provider 429 pauses uncached requests without consuming more external requests', async t => {
    let now = 100000;
    t.mock.method(Date, 'now', () => now);
    let calls = 0;
    providerFetch = async () => { calls++; return { ok: false, status: 429 }; };
    const query = new URLSearchParams({ q: 'one' });
    await assert.rejects(graphhopper('geocode', query), { status: 429 });
    await assert.rejects(graphhopper('geocode', new URLSearchParams({ q: 'two' })), { status: 429 });
    assert.equal(calls, 1);
    now += 60001;
    providerFetch = async () => { calls++; return { ok: true, json: async () => ({ hits: [] }) }; };
    await graphhopper('geocode', query);
    assert.equal(calls, 2);
});

test('missing credentials are an explicit 503, not fake route data', async () => {
    delete process.env.GRAPHHOPPER_KEY;
    const res = response();
    await facade.travel({ query: { start: 'Trento', end: 'Verona' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'ROUTING_NOT_CONFIGURED');
    assert.equal(res.body.paths, undefined);
});

for (const query of [
    { start: '', end: 'Verona' },
    { start: ['Trento'], end: 'Verona' },
    { start: 'Trento', end: 'Verona', limit: ['0'] },
    { start: 'Trento', end: 'Verona', minDistance: ['20000'] },
    { start: 'Trento', end: 'Verona', minDistance: '1000001' },
    { start: 'Trento', end: 'Verona', maxDetour: '' },
    { start: 'Trento', end: 'Verona', profile: 'plane' },
    { start: 'Trento', end: 'Verona', profile: ['bike'] },
    { start: 'Trento', end: 'Verona', limit: '9' },
    { start: 'Trento', end: 'Verona', limit: '1' },
    { start: 'Trento', end: 'Verona', maxDetour: '15000', minDistance: '20000' }
]) {
    test('invalid route input is rejected: ' + JSON.stringify(query), async () => {
        const res = response();
        await facade.travel({ query }, res);
        assert.equal(res.statusCode, 400);
    });
}

test('malformed upstream route geometry is rejected by the facade, not returned as success', async () => {
    request = async () => {
        const result = routeResult();
        result.route.paths[0].points.coordinates = [[500, 91], [11, 46]];
        return result;
    };
    const res = response();
    await facade.travel({ query: { start: 'Trento', end: 'Verona', limit: '0' } }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.paths, undefined);
    const custom = response();
    await facade.route({ body: { stops, profile: 'bike' } }, custom);
    assert.equal(custom.statusCode, 502);
});

test('an absent custom-route body is a client error rather than an unhandled exception', async () => {
    const res = response();
    await facade.route({}, res);
    assert.equal(res.statusCode, 400);
});

test('optional place information does not discard a valid route', async () => {
    request = async options => {
        if (options.uri.includes('/v1/path/route')) return routeResult();
        throw new Error('Weather unavailable');
    };
    const res = response();
    await facade.travel({ query: { start: 'Trento', end: 'Verona', weather: 'true' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.paths.length, 1);
    assert.match(res.body.warnings[0], /could not be loaded/);
});

test('routing failure becomes a structured upstream error', async () => {
    request = async () => { throw new Error('Provider timeout'); };
    const res = response();
    await facade.travel({ query: { start: 'Trento', end: 'Verona' } }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.code, 'ROUTING_UNAVAILABLE');
});

test('missing route geometry is not reported as success', async () => {
    request = async () => ({ route: { paths: [] }, stops });
    const res = response();
    await facade.travel({ query: { start: 'Trento', end: 'Verona' } }, res);
    assert.equal(res.statusCode, 502);
});

test('routing provider failures no longer dereference a null path', async () => {
    request = async () => { throw new Error('Provider failure'); };
    const res = response();
    await pathController.routePOST({ query: { profile: 'bike' }, body: { stops } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Bad Request');
});

test('successful routing returns geometry and waypoint coordinates', async () => {
    request = async () => JSON.stringify({ paths: [structuredClone(fixture)] });
    const res = response();
    await pathController.routePOST({ query: { profile: 'foot' }, body: { stops } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.route.paths[0].distance, fixture.distance);
    assert.equal(res.body.route.paths[0].snapped_waypoints.coordinates.length, 2);
});

test('path route response includes resolved endpoints for the guest planner', async () => {
    request = async url => {
        if (url.includes('/geocode')) return JSON.stringify({ hits: [url.includes('Trento') ? start : end] });
        return JSON.stringify({ paths: [structuredClone(fixture)] });
    };
    const res = response();
    await pathController.routeGET({ query: { start: 'Trento', end: 'Verona', limit: '0', profile: 'bike' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.stops, stops);
});

test('a two-point route cannot suggest its destination as an intermediate stop', async () => {
    const shortPath = structuredClone(fixture);
    shortPath.points.coordinates = [fixture.points.coordinates[0], fixture.points.coordinates[3]];
    request = async url => {
        if (url.includes('/geocode')) return JSON.stringify({ hits: [url.includes('Trento') ? start : end] });
        assert.ok(!url.includes('/locations/poi'), 'there are no interior route points to search');
        return JSON.stringify({ paths: [shortPath] });
    };
    const res = response();
    await pathController.stops({
        query: { start: 'Trento', end: 'Verona', limit: '8', minDistance: '0', maxDetour: '0', interest: 'tourism', profile: 'foot' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.stops.intermediates, []);
});

test('an empty first area does not redirect later stop attempts back to the first route segment', async () => {
    const geometry = Array.from({ length: 30 }, (_, index) => [11.12 - index * 0.005, 46.06 - index * 0.02]);
    const sampled = [];
    const middle = { name: 'Rovereto', point: { lat: 45.89, lng: 11.04 } };
    request = async uri => {
        const url = new URL(uri);
        if (url.pathname.endsWith('/geocode')) {
            return JSON.stringify({ hits: [{ Trento: start, Verona: end, Rovereto: middle }[url.searchParams.get('address')]] });
        }
        if (url.pathname.endsWith('/poi')) {
            assert.equal(url.searchParams.get('squareSide'), '1000', 'a 500 m search distance means a 1000 m search square');
            sampled.push(url.searchParams.get('point'));
            return JSON.stringify({ elements: sampled.length === 5 ? [
                { type: 'node', id: 1, lat: 45.89, lon: 11.04, tags: { name: 'Museum', 'addr:city': 'Rovereto', tourism: 'museum' } }
            ] : [] });
        }
        return JSON.stringify({ paths: [{ ...structuredClone(fixture), points: { type: 'LineString', coordinates: geometry } }] });
    };
    const res = response();
    await pathController.stops({
        query: { start: 'Trento', end: 'Verona', limit: '2', minDistance: '1000', maxDetour: '500', interest: 'tourism', profile: 'bike' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(sampled, [10, 8, 12, 19, 17].map(index => geometry[index].slice().reverse().join(',')));
    assert.equal(res.body.stops.intermediates.length, 1);
    assert.equal(res.body.stops.intermediates[0].details.name, 'Rovereto');
});

test('stop searches follow route distance rather than dense geometry near the origin', async () => {
    const geometry = [[10, 45], [10.001, 45], [10.002, 45], [10.003, 45], [10.004, 45], [10.05, 45], [10.1, 45]];
    const samples = [];
    request = async uri => {
        const url = new URL(uri);
        if (url.pathname.endsWith('/geocode')) return JSON.stringify({ hits: [url.searchParams.get('address') === 'Trento' ? start : end] });
        if (url.pathname.endsWith('/poi')) {
            samples.push(url.searchParams.get('point'));
            return JSON.stringify({ elements: [] });
        }
        return JSON.stringify({ paths: [{ ...structuredClone(fixture), points: { type: 'LineString', coordinates: geometry } }] });
    };
    const res = response();
    await pathController.stops({ query: {
        start: 'Trento', end: 'Verona', limit: '1', interest: 'tourism',
        minDistance: '0', maxDetour: '0', profile: 'car'
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(samples[0], '45,10.05', 'search starts halfway along the route, not halfway through its point count');
});

test('failed POI discovery returns a real direct route with an explicit warning', async () => {
    const profiles = [];
    request = async url => {
        if (url.includes('/geocode')) return JSON.stringify({ hits: [url.includes('Trento') ? start : end] });
        if (url.includes('/locations/poi')) {
            const error = new Error('POI provider unavailable');
            error.statusCode = 502;
            throw error;
        }
        profiles.push(new URL(url).searchParams.get('profile'));
        return JSON.stringify({ paths: [structuredClone(fixture)] });
    };
    const res = response();
    await pathController.routeGET({
        query: { start: 'Trento', end: 'Verona', limit: '2', minDistance: '0', maxDetour: '0', interest: 'tourism', profile: 'bike' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.route.paths[0].distance, fixture.distance);
    assert.deepEqual(res.body.stops.intermediates, []);
    assert.equal(res.body.suggestionsUnavailable, true);
    assert.match(res.body.warnings[0], /direct route without suggested stops/);
    assert.deepEqual(profiles, ['bike', 'bike']);
});

test('failure of the initial route never produces a degraded success', async () => {
    request = async url => {
        if (url.includes('/geocode')) return JSON.stringify({ hits: [url.includes('Trento') ? start : end] });
        throw new Error('Actual route provider failed');
    };
    const res = response();
    await pathController.routeGET({
        query: { start: 'Trento', end: 'Verona', limit: '2', minDistance: '0', maxDetour: '0', interest: 'tourism', profile: 'car' }
    }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.route, undefined);
});

test('failure to calculate the direct route after a POI outage remains an error', async () => {
    let routingCalls = 0;
    request = async url => {
        if (url.includes('/geocode')) return JSON.stringify({ hits: [url.includes('Trento') ? start : end] });
        if (url.includes('/locations/poi')) throw new Error('POI provider unavailable');
        if (++routingCalls > 1) throw new Error('Route provider also unavailable');
        return JSON.stringify({ paths: [structuredClone(fixture)] });
    };
    const res = response();
    await pathController.routeGET({
        query: { start: 'Trento', end: 'Verona', limit: '2', minDistance: '0', maxDetour: '0', interest: 'tourism', profile: 'car' }
    }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.route, undefined);
});

test('facade preserves the stop-outage warning and does not query the failed POI provider again', async () => {
    const calls = [];
    const warning = 'Suggested stops could not be loaded. Showing the direct route without suggested stops.';
    request = async options => {
        calls.push(options.uri);
        return { ...routeResult(), suggestionsUnavailable: true, warnings: [warning] };
    };
    const res = response();
    await facade.travel({
        query: { start: 'Trento', end: 'Verona', limit: '2', interest: 'tourism', profile: 'car' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.warnings, [warning]);
    assert.deepEqual(res.body.intermediates, []);
    assert.equal(calls.length, 1);
});

test('POI transport failures are upstream errors, not invalid user input', async () => {
    providerFetch = async () => { throw new Error('POI connection timed out'); };
    const res = response();
    await poiAdapter.poi({ query: { point: '45.850154,11.000342', interest: 'tourism', squareSide: '10000' } }, res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /temporarily unavailable/);
});

test('POI discovery uses bounded category-filtered GraphHopper queries and normalizes real places', async () => {
    const calls = [];
    providerFetch = async (uri, options) => {
        const url = new URL(uri);
        calls.push(url);
        assert.equal(url.hostname, 'graphhopper.com');
        assert.ok(options.signal instanceof AbortSignal);
        return {
            ok: true,
            json: async () => url.searchParams.get('reverse') === 'true'
                ? { hits: [{ city: 'Verona', point: end.point }] }
                : { hits: [
                    { name: 'Museum', city: 'Verona', point: { lat: 45.438, lng: 10.991 }, osm_key: 'tourism', osm_value: 'museum', osm_type: 'W', osm_id: 12 },
                    { name: 'Museum', city: 'Verona', point: { lat: 45.438, lng: 10.991 }, osm_key: 'tourism', osm_value: 'museum', osm_type: 'W', osm_id: 12 },
                    { name: 'Distant museum', city: 'Elsewhere', point: { lat: 50, lng: 10.99 }, osm_key: 'tourism', osm_value: 'museum', osm_type: 'N', osm_id: 13 },
                    { name: 'Hotel', city: 'Verona', point: { lat: 45.438, lng: 10.991 }, osm_key: 'tourism', osm_value: 'hotel', osm_type: 'N', osm_id: 14 },
                    { name: 'Unknown town', point: { lat: 45.438, lng: 10.991 }, osm_key: 'tourism', osm_value: 'museum', osm_type: 'N', osm_id: 15 },
                    { name: 'Invalid location', city: 'Verona', point: { lat: '45.438', lng: 10.991 }, osm_key: 'tourism', osm_value: 'museum', osm_type: 'N', osm_id: 16 }
                ] }
        };
    };
    const res = response();
    await poiAdapter.poi({ query: { bbox: '10.93,45.49,11.05,45.40', interest: 'tourism' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].searchParams.get('q'), 'museum');
    assert.equal(calls[1].searchParams.get('q'), 'attraction');
    assert.equal(calls[1].searchParams.get('bbox'), '10.93,45.4,11.05,45.49');
    assert.ok(calls[1].searchParams.getAll('osm_tag').includes('tourism:museum'));
    assert.ok(!calls[1].searchParams.getAll('osm_tag').includes('tourism:hotel'));
    assert.deepEqual(res.body.elements, [{
        type: 'way', id: 12, lat: 45.438, lon: 10.991,
        tags: { name: 'Museum', 'addr:city': 'Verona', tourism: 'museum' }
    }]);
    assert.equal(res.body.source, 'GraphHopper geocoding');
});

test('food interests do not admit unrelated tourism results', async () => {
    providerFetch = async uri => {
        const url = new URL(uri);
        return {
            ok: true,
            json: async () => url.searchParams.get('reverse') === 'true'
                ? { hits: [{ city: 'Verona' }] }
                : { hits: [
                    { name: 'Coffee', city: 'Verona', point: { lat: 45.44, lng: 10.99 }, osm_key: 'amenity', osm_value: 'cafe', osm_type: 'N', osm_id: 1 },
                    { name: 'Museum', city: 'Verona', point: { lat: 45.44, lng: 10.99 }, osm_key: 'tourism', osm_value: 'museum', osm_type: 'N', osm_id: 2 }
                ] }
        };
    };
    const res = response();
    await poiAdapter.poi({ query: { point: '45.44,10.99', squareSide: '10000', interest: 'sustenance' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.elements.length, 1);
    assert.equal(res.body.elements[0].tags.amenity, 'cafe');
});

test('a malformed POI provider result is an error rather than an empty search', async () => {
    providerFetch = async () => ({ ok: true, json: async () => ({ unexpected: [] }) });
    const res = response();
    await poiAdapter.poi({ query: { point: '45.44,10.99', interest: 'tourism' } }, res);
    assert.equal(res.statusCode, 502);
});

test('empty bounded category searches do not invent a locality or POI', async () => {
    let calls = 0;
    providerFetch = async () => {
        calls++;
        return { ok: true, json: async () => ({ hits: [] }) };
    };
    const res = response();
    await poiAdapter.poi({ query: { point: '45.44,10.99', interest: 'tourism' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.elements, []);
    assert.equal(calls, 2);
});

test('POI search requires a configured key before contacting the provider', async () => {
    delete process.env.GRAPHHOPPER_KEY;
    const res = response();
    await poiAdapter.poi({ query: { point: '45.44,10.99', interest: 'tourism' } }, res);
    assert.equal(res.statusCode, 503);
});

test('exhausted provider quota remains an explicit POI error', async () => {
    providerFetch = async () => ({ ok: false, status: 429 });
    const res = response();
    await poiAdapter.poi({ query: { point: '45.44,10.99', interest: 'tourism' } }, res);
    assert.equal(res.statusCode, 429);
    assert.match(res.body.error, /request limit/);
    assert.ok(!JSON.stringify(res.body).includes(process.env.GRAPHHOPPER_KEY));
});

test('GraphHopper POIs produce a genuine intermediate town and route legs through it', async () => {
    const middle = { name: 'Rovereto', point: { lat: 45.89, lng: 11.04 } };
    const routingCalls = [];
    providerFetch = async uri => ({
        ok: true,
        json: async () => new URL(uri).searchParams.get('reverse') === 'true'
            ? { hits: [{ city: 'Rovereto' }] }
            : { hits: [{
                name: 'Rovereto museum', city: 'Rovereto', point: middle.point,
                osm_key: 'tourism', osm_value: 'museum', osm_type: 'W', osm_id: 123
            }] }
    });
    request = async uri => {
        const url = new URL(uri);
        if (url.pathname.endsWith('/geocode')) {
            return JSON.stringify({ hits: [{ Trento: start, Verona: end, Rovereto: middle }[url.searchParams.get('address')]] });
        }
        if (url.pathname.endsWith('/poi')) {
            const res = response();
            await poiAdapter.poi({ query: Object.fromEntries(url.searchParams) }, res);
            assert.equal(res.statusCode, 200);
            return JSON.stringify(res.body);
        }
        routingCalls.push(url.searchParams);
        const path = structuredClone(fixture);
        path.points.coordinates = routingCalls.length === 1
            ? [[11.12, 46.06], [11.08, 46], [11.04, 45.89], [11.02, 45.65], [10.99, 45.44]]
            : url.searchParams.getAll('point').map(point => point.split(',').map(Number).reverse());
        path.instructions = [{ interval: [0, path.points.coordinates.length - 1], text: 'Arrive', sign: 4 }];
        return JSON.stringify({ paths: [path] });
    };
    const res = response();
    await pathController.routeGET({
        query: { start: 'Trento', end: 'Verona', limit: '1', minDistance: '20000', maxDetour: '10000', interest: 'tourism', profile: 'bike' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stops.intermediates.length, 1);
    assert.equal(res.body.stops.intermediates[0].details.name, 'Rovereto');
    assert.equal(res.body.stops.intermediates[0].nPois, 1);
    assert.equal(routingCalls.length, 3);
    assert.ok(routingCalls.every(query => query.get('profile') === 'bike'));
    assert.deepEqual(routingCalls[1].getAll('point'), ['46.06,11.12', '45.89,11.04']);
    assert.deepEqual(routingCalls[2].getAll('point'), ['45.89,11.04', '45.44,10.99']);
    assert.deepEqual(res.body.route.paths[0].snapped_waypoints.coordinates, [
        [11.12, 46.06], [11.04, 45.89], [10.99, 45.44]
    ]);
});

for (const query of [
    { point: '100,10', interest: 'tourism' },
    { point: '45,10,11', interest: 'tourism' },
    { point: '45x,10', interest: 'tourism' },
    { point: '45,10', interest: 'tourism', squareSide: '-1' },
    { bbox: '10,45,200,46', interest: 'tourism' },
    { point: '45,10', interest: 'unknown' }
]) {
    test('invalid POI inputs never contact a provider: ' + JSON.stringify(query), async () => {
        const res = response();
        await poiAdapter.poi({ query }, res);
        assert.equal(res.statusCode, 400);
    });
}

test('custom waypoints are routed with the original travel mode', async () => {
    let captured;
    request = async options => { captured = options; return routeResult(); };
    const res = response();
    await facade.route({ body: { stops, profile: 'bike' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(new URL(captured.uri).searchParams.get('profile'), 'bike');
    assert.equal(captured.method, 'POST');
    assert.deepEqual(captured.body.stops, stops);
});

test('invalid custom waypoint coordinates are rejected', async () => {
    const res = response();
    await facade.route({ body: { stops: { ...stops, intermediates: [{ details: { name: 'Invalid', point: { lat: 200, lng: 0 } } }] } } }, res);
    assert.equal(res.statusCode, 400);
});

test('place search encodes its query and preserves a not-found result', async () => {
    request = async options => {
        assert.equal(new URL(options.uri).searchParams.get('address'), 'A & B');
        const error = new Error('Not found');
        error.statusCode = 404;
        throw error;
    };
    const res = response();
    await facade.places({ query: { address: 'A & B' } }, res);
    assert.equal(res.statusCode, 404);
});

test('provider adapter encodes geocoding addresses and sends a timeout signal', async () => {
    providerFetch = async (url, options) => {
        assert.equal(new URL(url).searchParams.get('q'), 'A & B');
        assert.ok(options.signal instanceof AbortSignal);
        return { ok: true, json: async () => ({ hits: [start] }) };
    };
    const res = response();
    await adapter.geocode({ query: { address: 'A & B' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.hits, [start]);
});

test('provider errors are not returned as HTTP 200', async () => {
    providerFetch = async () => ({ ok: false, status: 401 });
    const res = response();
    await adapter.route({ query: { point: ['46.06,11.12', '45.44,10.99'], profile: 'bike' } }, res);
    assert.equal(res.statusCode, 502);
});

test('weather without a key is explicitly unavailable', async () => {
    const res = response();
    await weather.current({ query: { city: 'Verona' } }, res);
    assert.equal(res.statusCode, 503);
});

test('optional weather failure leaves place data and an explicit warning', async () => {
    request = async () => ({ hits: [end] });
    const res = response();
    await combined.getCombined({ query: { address: 'Verona', weather: 'true' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.address, end);
    assert.match(res.body.warnings[0], /Weather is not configured/);
    assert.equal(res.body.weather, undefined);
});

test('POI enrichment reuses the geocoded place instead of geocoding twice', async () => {
    const calls = [];
    request = async options => {
        calls.push(options.uri);
        return options.uri.includes('/geocode') ? { hits: [end] } : { elements: [] };
    };
    const res = response();
    await combined.getCombined({ query: { address: 'Verona', interest: 'tourism' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls.filter(url => url.includes('/geocode')).length, 1);
    assert.deepEqual(res.body.poi, []);
});

test('public service status exposes only capability flags', () => {
    const res = response();
    facade.status({}, res);
    assert.deepEqual(res.body, { routing: true, weather: false });
    assert.ok(!JSON.stringify(res.body).includes(process.env.GRAPHHOPPER_KEY));
});
