'use strict';

module.exports = async function request(options) {
    const settings = typeof options === 'string' ? { uri: options } : options;
    const headers = new Headers(settings.headers);
    if (settings.json && settings.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(settings.uri, {
        method: settings.method || 'GET',
        headers,
        body: settings.json && settings.body !== undefined ? JSON.stringify(settings.body) : settings.body,
        signal: AbortSignal.timeout(settings.timeout ?? 15000)
    });
    const text = await response.text();
    if (!response.ok) {
        const error = new Error('HTTP provider request failed with status ' + response.status);
        error.name = 'StatusCodeError';
        error.statusCode = response.status;
        error.status = response.status;
        throw error;
    }
    return settings.json ? JSON.parse(text) : text;
};
