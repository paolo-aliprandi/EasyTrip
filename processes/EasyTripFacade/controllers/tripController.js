'use strict';

const { INTERESTS, PROFILES, OSM_TOOLS_URL, POINT_SEARCH_URL, PATH_SEARCH_URL } = require('../../../common/dataStructures');
const request = require('../../../common/http');

function routingAvailable(res) {
    if (process.env.GRAPHHOPPER_KEY) return true;
    res.status(503).json({
        code: 'ROUTING_NOT_CONFIGURED',
        error: 'Live routing is not configured yet. Add GRAPHHOPPER_KEY to the server environment and restart the server.'
    });
    return false;
}

function failedRequest(res, error) {
    console.error('Trip request failed:', error.name);
    const status = [404, 429].includes(error.statusCode) ? error.statusCode : 502;
    if (status === 429) res.setHeader('Retry-After', '60');
    res.status(status).json({
        code: status === 429 ? 'ROUTING_RATE_LIMITED' : status === 404 ? 'PLACE_NOT_FOUND' : 'ROUTING_UNAVAILABLE',
        error: status === 429
            ? 'Routing request limit reached. Wait at least a minute before trying again; the provider or application daily budget may be exhausted if it persists.'
            : status === 404
            ? 'We could not find that place. Try a city, country, or a more specific address.'
            : 'The route service is unavailable or could not find a route. Try another journey or try again shortly.'
    });
}

function validAddress(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 300;
}

function validPlace(place) {
    return place && validAddress(place.name) && place.point
        && Number.isFinite(place.point.lat) && Math.abs(place.point.lat) <= 90
        && Number.isFinite(place.point.lng) && Math.abs(place.point.lng) <= 180;
}

function validPath(path) {
    return path && Number.isFinite(path.distance) && path.distance >= 0
        && Number.isFinite(path.time) && path.time >= 0
        && path.points?.type === 'LineString' && Array.isArray(path.points.coordinates)
        && path.points.coordinates.length >= 2
        && path.points.coordinates.every(point => Array.isArray(point) && point.length >= 2
            && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180
            && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90);
}

async function about(address, options) {
    const query = new URLSearchParams({ address, weather: String(options.weather), bikes: String(options.bikes) });
    options.interests.forEach(interest => query.append('interest', interest));
    return request({ uri: POINT_SEARCH_URL + '/v2/combined/about?' + query, json: true });
}

module.exports.status = (req, res) => {
    res.json({
        routing: Boolean(process.env.GRAPHHOPPER_KEY),
        weather: Boolean(process.env.WEATHER_API_KEY)
    });
};

module.exports.places = async (req, res) => {
    if (!validAddress(req.query.address)) return res.status(400).json({ error: 'Enter a place to search for.' });
    if (!routingAvailable(res)) return;
    try {
        const query = new URLSearchParams({ address: req.query.address.trim(), limit: '5' });
        res.json(await request({ uri: OSM_TOOLS_URL + '/v1/routing/geocode?' + query, json: true }));
    } catch (error) {
        failedRequest(res, error);
    }
};

module.exports.destination = async (req, res) => {
    if (!validAddress(req.query.address)) return res.status(400).json({ error: 'Enter a destination.' });
    if (!routingAvailable(res)) return;
    const interests = [].concat(req.query.interest || []).filter(interest => INTERESTS.has(interest));
    try {
        res.json({
            success: true,
            message: await about(req.query.address.trim(), {
                weather: req.query.weather === 'true', bikes: req.query.bikes === 'true', interests
            })
        });
    } catch (error) {
        failedRequest(res, error);
    }
};

module.exports.travel = async (req, res) => {
    const { start, end } = req.query;
    const profile = req.query.profile ?? 'car';
    const limit = Number(req.query.limit ?? 0);
    const minDistance = Number(req.query.minDistance ?? 20000);
    const maxDetour = Number(req.query.maxDetour ?? minDistance / 2);
    const interests = [...new Set([].concat(req.query.interest || []).filter(interest => INTERESTS.has(interest)))];
    if (!validAddress(start) || !validAddress(end) || typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)
        || ['limit', 'minDistance', 'maxDetour'].some(key => req.query[key] !== undefined
            && (typeof req.query[key] !== 'string' || !req.query[key].trim()))
        || !Number.isInteger(limit) || limit < 0 || limit > 8
        || !Number.isFinite(minDistance) || minDistance < 0 || minDistance > 1000000
        || !Number.isFinite(maxDetour) || maxDetour < 0 || maxDetour > minDistance / 2
        || (limit > 0 && !interests.length)) {
        return res.status(400).json({ error: 'Enter a start and destination, a valid travel mode, and interests when requesting stops.' });
    }
    if (!routingAvailable(res)) return;
    const query = new URLSearchParams({
        start: start.trim(), end: end.trim(), profile, limit: String(limit), poisDescriptions: 'true',
        minDistance: String(minDistance), maxDetour: String(maxDetour)
    });
    interests.forEach(interest => query.append('interest', interest));
    try {
        const result = await request({ uri: PATH_SEARCH_URL + '/v1/path/route?' + query, json: true, timeout: 45000 });
        if (!validPath(result.route?.paths?.[0]) || !validPlace(result.stops?.start)
            || !validPlace(result.stops?.end) || !Array.isArray(result.stops.intermediates)
            || result.stops.intermediates.length > 8
            || !result.stops.intermediates.every(stop => validPlace(stop?.details))) {
            throw new Error('Missing or invalid route data');
        }
        const places = [result.stops.start, ...result.stops.intermediates.map(stop => stop.details), result.stops.end];
        const warnings = [...(result.warnings || [])];
        const options = {
            weather: req.query.weather === 'true', bikes: req.query.bikes === 'true',
            interests: []
        };
        const descriptions = await Promise.all(places.map(async (place, index) => {
            const poi = index > 0 && index < places.length - 1
                ? result.stops.intermediates[index - 1].pois || [] : [];
            if (index === 0 || (!options.weather && !options.bikes)) return { address: place, poi };
            try {
                const details = await about([place.name, place.city, place.country].filter(Boolean).join(', '), options);
                warnings.push(...(details.warnings || []));
                return { ...details, address: place, poi };
            } catch (error) {
                console.error('Optional place information failed:', error.name);
                warnings.push('Some place information could not be loaded. The route is still available.');
                return { address: place, poi };
            }
        }));
        if (limit > 0 && !result.stops.intermediates.length && !result.suggestionsUnavailable) {
            warnings.push('No matching stops were found within the search area. Try other interests or a wider search area.');
        }
        res.json({
            start: descriptions[0], end: descriptions[descriptions.length - 1],
            intermediates: descriptions.slice(1, -1), paths: result.route.paths,
            warnings: [...new Set(warnings)]
        });
    } catch (error) {
        failedRequest(res, error);
    }
};

module.exports.route = async (req, res) => {
    const { stops, profile = 'car' } = req.body || {};
    if (!stops || !validPlace(stops.start) || !validPlace(stops.end)
        || !Array.isArray(stops.intermediates) || stops.intermediates.length > 8
        || !stops.intermediates.every(stop => validPlace(stop?.details))
        || typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) {
        return res.status(400).json({ error: 'Provide valid start, destination, travel mode, and at most eight stops.' });
    }
    if (!routingAvailable(res)) return;
    try {
        const result = await request({
            uri: PATH_SEARCH_URL + '/v1/path/route?' + new URLSearchParams({ profile }),
            method: 'POST', body: { stops }, json: true, timeout: 45000
        });
        if (!validPath(result.route?.paths?.[0])) throw new Error('Missing or invalid route data');
        res.json({
            start: { address: stops.start }, end: { address: stops.end },
            intermediates: stops.intermediates.map(stop => ({ address: stop.details })),
            paths: result.route.paths, warnings: []
        });
    } catch (error) {
        failedRequest(res, error);
    }
};
