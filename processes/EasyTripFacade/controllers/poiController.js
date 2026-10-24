'use strict';

const { fetch } = require('../../../common/functions');
const cache = new Map();
const types = new Set(['node', 'way', 'relation']);
const agent = 'EasyTrip/1.0 (+https://github.com/paolo-aliprandi/EasyTrip)';

async function jsonFrom(url) {
    const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': agent },
        signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
        const error = new Error('Place metadata provider is unavailable');
        error.status = response.status;
        throw error;
    }
    return response.json();
}

function httpUrl(value) {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}

function plainText(value) {
    return typeof value === 'string'
        ? value.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 500)
        : '';
}

async function photoFor(filename, name) {
    const query = new URLSearchParams({
        action: 'query', format: 'json', formatversion: '2', prop: 'imageinfo',
        titles: 'File:' + filename, iiprop: 'url|extmetadata', iiurlwidth: '480'
    });
    const data = await jsonFrom('https://commons.wikimedia.org/w/api.php?' + query);
    const info = data.query?.pages?.[0]?.imageinfo?.[0];
    const url = httpUrl(info?.thumburl || info?.url);
    if (!url || new URL(url).protocol !== 'https:'
        || !['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(new URL(url).hostname)) {
        throw new Error('No valid Wikimedia photo was returned');
    }
    const metadata = info.extmetadata || {};
    return {
        url, alt: name,
        author: plainText(metadata.Artist?.value),
        license: plainText(metadata.LicenseShortName?.value),
        licenseUrl: httpUrl(metadata.LicenseUrl?.value),
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(filename)
    };
}

async function lookup(type, id) {
    const source = 'https://www.openstreetmap.org/' + type + '/' + id;
    const data = await jsonFrom('https://api.openstreetmap.org/api/0.6/' + type + '/' + id + '.json');
    const element = data.elements?.find(item => item.type === type && String(item.id) === id);
    if (!element?.tags || typeof element.tags !== 'object') throw new Error('Invalid OpenStreetMap place data');
    const tags = element.tags;
    const result = {
        name: tags.name || 'Unnamed place',
        description: tags['description:en'] || tags.description || '',
        category: tags.tourism || tags.amenity || tags.historic || 'point of interest',
        address: [[tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' '),
            tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(', '),
        openingHours: tags.opening_hours || '',
        website: httpUrl(tags.website || tags['contact:website']),
        wheelchair: tags.wheelchair || '', fee: tags.fee || '',
        image: null, sources: [{ label: 'OpenStreetMap', url: source }], warnings: []
    };
    let entity;
    if (typeof tags.wikidata === 'string' && /^Q[1-9]\d*$/.test(tags.wikidata)) {
        try {
            const wikidata = await jsonFrom('https://www.wikidata.org/wiki/Special:EntityData/' + tags.wikidata + '.json');
            entity = wikidata.entities?.[tags.wikidata];
            if (!entity) throw new Error('Missing Wikidata place');
            result.description ||= entity.descriptions?.en?.value || entity.descriptions?.it?.value
                || entity.descriptions?.cs?.value || '';
            result.sources.push({ label: 'Wikidata', url: 'https://www.wikidata.org/wiki/' + tags.wikidata });
            for (const language of ['en', 'it', 'cs']) {
                const title = entity.sitelinks?.[language + 'wiki']?.title;
                if (title) {
                    result.sources.push({ label: 'Wikipedia', url: 'https://' + language + '.wikipedia.org/wiki/' + encodeURIComponent(title) });
                    break;
                }
            }
        } catch (error) {
            console.error('POI background lookup failed:', error.name);
            result.warnings.push('Background information is temporarily unavailable.');
        }
    }
    const filename = entity?.claims?.P18?.find(claim => typeof claim.mainsnak?.datavalue?.value === 'string')
        ?.mainsnak.datavalue.value || (tags.wikimedia_commons?.startsWith('File:') ? tags.wikimedia_commons.slice(5) : null);
    if (filename) {
        try {
            result.image = await photoFor(filename, result.name);
        } catch (error) {
            console.error('POI photo lookup failed:', error.name);
            result.warnings.push('Photo information is temporarily unavailable.');
        }
    }
    return result;
}

module.exports.details = async (req, res) => {
    const { type, id } = req.params;
    if (!types.has(type) || typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id)) {
        return res.status(400).json({ error: 'Provide a valid OpenStreetMap place identifier.' });
    }
    const identity = type + '/' + id;
    let entry = cache.get(identity);
    if (!entry || entry.expires <= Date.now()) {
        entry = { expires: Date.now() + 3600000, data: lookup(type, id) };
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(identity, entry);
    }
    try {
        const result = await entry.data;
        if (result.warnings.length) entry.expires = Math.min(entry.expires, Date.now() + 60000);
        res.json(result);
    } catch (error) {
        if (cache.get(identity) === entry) cache.delete(identity);
        console.error('POI details lookup failed:', error.name);
        res.status(error.status === 404 ? 404 : 502).json({
            error: error.status === 404 ? 'This place is no longer available in OpenStreetMap.'
                : 'Place details are temporarily unavailable. The route is still available.'
        });
    }
};

module.exports.clearCache = () => cache.clear();
