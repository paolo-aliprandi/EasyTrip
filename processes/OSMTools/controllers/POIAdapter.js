'use strict';

const { fetch, cleanWrtStruct, strToPoint, pointToStr, arrayToStr } = require('../../../common/functions');
const { AMENITIES, TOURISM, PLACES, INTERESTS } = require('../../../common/dataStructures');
const graphhopper = require('../../../common/graphhopper');
const geolib = require('geolib');
const searchTerms = {
    tourism: ['museum', 'attraction'],
    sustenance: ['restaurant', 'cafe'],
    entertainment: ['theatre', 'cinema'],
    education: ['library'],
    accomodation: ['hotel', 'camping']
};

function coordinates(text, length) {
    if (typeof text !== 'string') return null;
    const parts = text.split(',');
    if (parts.length !== length || parts.some(part => !part.trim())) return null;
    const result = parts.map(Number);
    return result.every(Number.isFinite) ? result : null;
}

function boundsFor(query) {
    if (query.bbox !== undefined) {
        const bbox = coordinates(query.bbox, 4);
        if (!bbox || Math.abs(bbox[0]) > 180 || Math.abs(bbox[2]) > 180
            || Math.abs(bbox[1]) > 90 || Math.abs(bbox[3]) > 90) return null;
        return [Math.min(bbox[0], bbox[2]), Math.min(bbox[1], bbox[3]),
            Math.max(bbox[0], bbox[2]), Math.max(bbox[1], bbox[3])];
    }
    const point = coordinates(query.point, 2);
    const side = Number(query.squareSide ?? 20000);
    if (!point || Math.abs(point[0]) > 90 || Math.abs(point[1]) > 180
        || !Number.isFinite(side) || side < 0) return null;
    const center = { latitude: point[0], longitude: point[1] };
    const south = geolib.computeDestinationPoint(center, side / 2, 180).latitude;
    const west = geolib.computeDestinationPoint(center, side / 2, -90).longitude;
    const north = geolib.computeDestinationPoint(center, side / 2, 0).latitude;
    const east = geolib.computeDestinationPoint(center, side / 2, 90).longitude;
    if (![south, west, north, east].every(Number.isFinite) || west > east) return null;
    return [west, south, east, north];
}

function validPoint(point) {
    return point && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
        && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
}

function hitsFrom(result) {
    if (!Array.isArray(result.hits)) throw new Error('Invalid GraphHopper POI response');
    return result.hits;
}

module.exports.poi = async (req, res) => {
    const interests = cleanWrtStruct([].concat(req.query.interest || []), INTERESTS);
    const bounds = boundsFor(req.query);
    if (!interests.length || !bounds) {
        return res.status(400).json({ error: 'Provide valid interests and a bounding box or coordinates with a non-negative search distance.' });
    }
    if (!process.env.GRAPHHOPPER_KEY) {
        return res.status(503).json({ error: 'POI search requires a configured GraphHopper key.' });
    }
    if (bounds[0] === bounds[2] || bounds[1] === bounds[3]) return res.json({ elements: [] });

    const tags = new Set();
    for (const interest of interests) {
        for (const value of AMENITIES[interest] || []) tags.add('amenity:' + value);
        for (const value of TOURISM[interest] || []) tags.add('tourism:' + value);
    }
    const point = [(bounds[1] + bounds[3]) / 2, (bounds[0] + bounds[2]) / 2].join(',');
    try {
        const searches = interests.flatMap(interest => searchTerms[interest].map(term => {
            const query = new URLSearchParams({
                q: term, point, bbox: bounds.join(','),
                location_bias_scale: '0', limit: '10', locale: 'en'
            });
            for (const value of AMENITIES[interest] || []) query.append('osm_tag', 'amenity:' + value);
            for (const value of new Set(TOURISM[interest] || [])) query.append('osm_tag', 'tourism:' + value);
            return graphhopper('geocode', query).then(hitsFrom);
        }));
        const results = await Promise.allSettled(searches);
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        const hits = results.flatMap(result => result.value);
        const elements = [];
        const seen = new Set();
        for (const hit of hits) {
            if (!validPoint(hit.point) || typeof hit.city !== 'string' || !hit.city.trim()
                || typeof hit.name !== 'string' || !hit.name.trim()
                || !tags.has(hit.osm_key + ':' + hit.osm_value)
                || hit.point.lng < bounds[0] || hit.point.lng > bounds[2]
                || hit.point.lat < bounds[1] || hit.point.lat > bounds[3]) continue;
            const identity = hit.osm_id != null
                ? hit.osm_type + ':' + hit.osm_id
                : hit.point.lat + ',' + hit.point.lng + ':' + hit.name;
            if (seen.has(identity)) continue;
            seen.add(identity);
            elements.push({
                type: { N: 'node', W: 'way', R: 'relation' }[hit.osm_type] || hit.osm_type || 'node',
                id: hit.osm_id,
                lat: hit.point.lat, lon: hit.point.lng,
                tags: { name: hit.name, 'addr:city': hit.city, [hit.osm_key]: hit.osm_value }
            });
            if (elements.length === 10) break;
        }
        res.json({
            elements, source: 'GraphHopper geocoding',
            attribution: 'OpenStreetMap contributors, https://www.openstreetmap.org/copyright'
        });
    } catch (error) {
        console.error('Points-of-interest provider failed:', error.name, error.statusCode || '');
        if (error.status === 429) res.setHeader('Retry-After', '60');
        res.status([429, 503].includes(error.status) ? error.status : 502).json({
            error: error.status === 429
                ? 'Points-of-interest request limit reached. Wait before trying again or check your provider account limits.'
                : 'Points-of-interest provider is temporarily unavailable.'
        });
    }
};

module.exports.nearbyCities = (req, res) => {
    const range = req.query.range !== undefined && req.query.range >= 0 ? req.query.range : 5000;
    const point = strToPoint(req.query.point);
    if (point != null) {
        return queryOverpass("[out:json];node(around:" + range + "," + pointToStr(point)
                + ")[place~'^(" + arrayToStr(PLACES) + ")$'];out;")
            .then(response => response.json())
            .then(response => res.status(200).json(response))
            .catch(() => res.status(400).json({ error: 'Bad Request' }));
    }
    return res.status(400).json({ error: 'Bad Request' });
};

async function queryOverpass(query) {
    const response = await fetch('https://www.overpass-api.de/api/interpreter?', {
        method: 'POST', headers: { Accept: 'application/json' },
        body: query, signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) {
        const error = new Error('Points-of-interest provider rejected the request');
        error.statusCode = response.status;
        throw error;
    }
    return response;
}
