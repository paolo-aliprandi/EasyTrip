'use strict';

const { fetch } = require('../../../common/functions');

async function weather(req, res, forecast) {
    if (typeof req.query.city !== 'string' || !req.query.city.trim()) {
        return res.status(400).json({ error: 'Enter a city.' });
    }
    if (!process.env.WEATHER_API_KEY) {
        return res.status(503).json({ error: 'Weather is not configured.' });
    }
    try {
        const query = new URLSearchParams({ city: req.query.city, key: process.env.WEATHER_API_KEY, lang: 'en' });
        const response = await fetch('https://api.weatherbit.io/v2.0/' + (forecast ? 'forecast/daily' : 'current') + '?' + query, {
            signal: AbortSignal.timeout(12000)
        });
        if (!response.ok) throw new Error('Weather provider rejected request');
        const data = await response.json();
        if (!Array.isArray(data.data) || !data.data.length) throw new Error('No weather data');
        const message = forecast ? data.data.map(day => day.weather.description) : data.data[0].weather.description;
        res.json({
            success: true,
            message,
            text: forecast ? 'Forecast for ' + req.query.city + ': ' + message.join(', ') : 'Current weather in ' + req.query.city + ' is ' + message
        });
    } catch (error) {
        console.error('Weather provider failed:', error.name);
        res.status(502).json({ error: 'Weather is temporarily unavailable.' });
    }
}

module.exports.current = (req, res) => weather(req, res, false);
module.exports.forecast = (req, res) => weather(req, res, true);
