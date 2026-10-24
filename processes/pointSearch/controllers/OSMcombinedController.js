'use strict';

const { OSM_TOOLS_URL, POINT_SEARCH_URL, INTERESTS } = require('../../../common/dataStructures');
const request = require('../../../common/http');

module.exports.getCombined = async (req, res) => {
    if (typeof req.query.address !== 'string' || !req.query.address.trim()) {
        return res.status(400).json({ error: 'Enter a place to look up.' });
    }
    let address;
    try {
        const query = new URLSearchParams({ address: req.query.address, limit: '1' });
        const result = await request({ uri: OSM_TOOLS_URL + '/v1/routing/geocode?' + query, json: true });
        address = result.hits?.[0];
        if (!address) return res.status(404).json({ error: 'Place not found.' });
    } catch (error) {
        console.error('Place lookup failed:', error.name);
        return res.status(error.statusCode === 404 ? 404 : 502).json({ error: 'Place information is unavailable.' });
    }

    const result = { address, warnings: [] };
    const city = address.city || address.name;
    const cityQuery = new URLSearchParams({ city });
    const tasks = [];
    const optional = (label, work, assign) => {
        tasks.push(work().then(assign).catch(error => {
            console.error(label + ' lookup failed:', error.name);
            result.warnings.push(label + ' is unavailable for this place. The route is still available.');
        }));
    };
    if (req.query.weather === 'true') {
        if (!process.env.WEATHER_API_KEY) {
            result.warnings.push('Weather is not configured. The route is still available.');
        } else {
            optional('Weather', () => Promise.all([
                request({ uri: POINT_SEARCH_URL + '/v1/weather/current?' + cityQuery, json: true }),
                request({ uri: POINT_SEARCH_URL + '/v1/weather/forecast?' + cityQuery, json: true })
            ]), ([current, forecasts]) => { result.weather = { current: current.message, forecasts: forecasts.message }; });
        }
    }
    if (req.query.bikes === 'true') {
        optional('Bike sharing', () => request({
            uri: POINT_SEARCH_URL + '/v1/bikes/networks?' + cityQuery, json: true
        }), data => { result.bike = data.message; });
    }
    const interests = [].concat(req.query.interest || []).filter(interest => INTERESTS.has(interest));
    if (interests.length) {
        const query = new URLSearchParams();
        interests.forEach(interest => query.append('interest', interest));
        if (address.extent) query.set('bbox', address.extent.join(','));
        else {
            query.set('point', address.point.lat + ',' + address.point.lng);
            query.set('squareSide', '20000');
        }
        optional('Points of interest', () => request({
            uri: OSM_TOOLS_URL + '/v1/locations/poi?' + query, json: true
        }), data => {
            if (!Array.isArray(data.elements)) throw new Error('Invalid points-of-interest response');
            result.poi = data.elements;
        });
    }
    await Promise.all(tasks);
    res.json(result);
};
