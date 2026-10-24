'use strict';

const byId = id => document.getElementById(id);
const form = byId('trip-form');
let currentJourney = null;
let requestController = null;
let requestVersion = 0;
let busy = false;
let weatherAvailable = false;
let routeLayer;
let markerLayer;
let map;
let routeBounds;
const poiDetails = new Map();
const poiMarkers = new Map();

function text(id, value) {
    byId(id).textContent = value;
}

function showMessage(id, message) {
    text(id, message);
    byId(id).hidden = !message;
    if (id === 'request-error' && message && window.matchMedia('(max-width: 720px)').matches) {
        byId(id).scrollIntoView({ block: 'center' });
    }
}

function placeName(place) {
    return [place.name, place.city !== place.name ? place.city : '', place.country].filter(Boolean).join(', ');
}

function minutes(time) {
    const total = Math.max(1, Math.round(time / 60000));
    return total >= 60 ? `${Math.floor(total / 60)} hr ${total % 60} min` : `${total} min`;
}

function distance(meters) {
    return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
}

function selectedMode() {
    return new FormData(form).get('profile');
}

function journeyStops(journey) {
    return [journey.start.address, ...(journey.intermediates || []).map(stop => stop.address), journey.end.address];
}

function validPoi(poi) {
    return poi && ['node', 'way', 'relation'].includes(poi.type) && /^[1-9]\d{0,15}$/.test(String(poi.id))
        && Number.isFinite(poi.lat) && Math.abs(poi.lat) <= 90
        && Number.isFinite(poi.lon) && Math.abs(poi.lon) <= 180 && typeof poi.tags?.name === 'string';
}

function journeyPois(journey) {
    const found = new Map();
    for (const stop of [journey.start, ...(journey.intermediates || []), journey.end]) {
        for (const poi of Array.isArray(stop.poi) ? stop.poi : []) {
            if (!validPoi(poi)) continue;
            found.set(poi.type + '/' + poi.id, poi);
        }
    }
    return [...found.values()];
}

function safeLink(value) {
    try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}

function link(label, url) {
    const anchor = document.createElement('a');
    anchor.textContent = label;
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return anchor;
}

function poiCard(poi) {
    const card = document.createElement('article');
    card.className = 'poi-card';
    const title = document.createElement('h3');
    title.textContent = poi.tags.name;
    const category = document.createElement('p');
    category.className = 'poi-category';
    category.textContent = [poi.tags.tourism || poi.tags.amenity || 'Point of interest', poi.tags['addr:city']]
        .filter(Boolean).join(' | ').replaceAll('_', ' ');
    const image = document.createElement('img');
    image.className = 'poi-photo';
    image.alt = poi.tags.name;
    image.referrerPolicy = 'no-referrer';
    image.hidden = true;
    const photoStatus = document.createElement('p');
    photoStatus.className = 'poi-photo-status';
    photoStatus.textContent = 'Loading photo and details...';
    image.addEventListener('error', () => {
        image.hidden = true;
        photoStatus.hidden = false;
        photoStatus.textContent = 'The photo could not be loaded.';
    });
    const info = document.createElement('div');
    info.className = 'poi-info';
    const status = document.createElement('p');
    status.className = 'poi-status';
    status.setAttribute('aria-live', 'polite');
    card.append(title, category, image, photoStatus, info, status);
    return card;
}

async function populatePoiCard(card, poi) {
    const identity = poi.type + '/' + poi.id;
    const status = card.querySelector('.poi-status');
    const photoStatus = card.querySelector('.poi-photo-status');
    try {
        let pending = poiDetails.get(identity);
        if (!pending) {
            pending = api('/v1/trip/poi/' + identity, {}, AbortSignal.timeout(18000));
            if (poiDetails.size >= 64) poiDetails.delete(poiDetails.keys().next().value);
            poiDetails.set(identity, pending);
        }
        const details = await pending;
        const info = card.querySelector('.poi-info');
        info.replaceChildren();
        if (details.description) {
            const description = document.createElement('p');
            description.textContent = details.description;
            info.append(description);
        }
        const facts = document.createElement('dl');
        for (const [label, value] of [
            ['Address', details.address], ['Opening hours', details.openingHours],
            ['Wheelchair access', details.wheelchair], ['Entry fee', details.fee]
        ]) {
            if (!value) continue;
            const term = document.createElement('dt');
            term.textContent = label;
            const definition = document.createElement('dd');
            definition.textContent = value;
            facts.append(term, definition);
        }
        info.append(facts);
        const image = card.querySelector('.poi-photo');
        const imageUrl = safeLink(details.image?.url);
        if (imageUrl && new URL(imageUrl).protocol === 'https:'
            && ['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(new URL(imageUrl).hostname)) {
            image.src = imageUrl;
            image.hidden = false;
            photoStatus.hidden = true;
            const credits = document.createElement('p');
            credits.className = 'poi-credits';
            credits.append(document.createTextNode([details.image.author, details.image.license].filter(Boolean).join(' | ') + ' '));
            const sourceUrl = safeLink(details.image.sourceUrl);
            if (sourceUrl) credits.append(link('Photo source & license', sourceUrl));
            info.append(credits);
        } else {
            image.hidden = true;
            photoStatus.hidden = false;
            photoStatus.textContent = 'No photo is available for this place.';
        }
        const links = document.createElement('p');
        links.className = 'poi-links';
        const website = safeLink(details.website);
        if (website) links.append(link('Official website', website));
        for (const source of Array.isArray(details.sources) ? details.sources : []) {
            const url = safeLink(source.url);
            if (url) links.append(link(source.label, url));
        }
        info.append(links);
        status.textContent = [...(details.warnings || []), 'Community-maintained information. Verify access and opening hours before visiting.'].join(' ');
        if (details.warnings?.length) poiDetails.delete(identity);
    } catch (error) {
        poiDetails.delete(identity);
        photoStatus.textContent = 'Photo unavailable.';
        status.textContent = error.message + ' Close and reopen this place to retry.';
    }
}

function navigationUrl(journey, profile) {
    const stops = journeyStops(journey).map(place => `${place.point.lat},${place.point.lng}`);
    const query = new URLSearchParams({
        api: '1', origin: stops[0], destination: stops[stops.length - 1],
        travelmode: { car: 'driving', bike: 'bicycling', foot: 'walking' }[profile]
    });
    if (stops.length > 2) query.set('waypoints', stops.slice(1, -1).join('|'));
    return 'https://www.google.com/maps/dir/?' + query;
}

function setBusy(value) {
    busy = value;
    for (const control of form.querySelectorAll('input, select, button')) control.disabled = value;
    byId('weather').disabled = value || !weatherAvailable;
    byId('explore-example').disabled = value;
    byId('share-trip').disabled = value;
    for (const preset of document.querySelectorAll('.preset-button')) preset.disabled = value;
    byId('cancel-request').hidden = !value;
    byId('cancel-request').disabled = false;
    byId('trip-form').setAttribute('aria-busy', String(value));
    byId('plan-label').textContent = value ? 'Finding your way...' : 'Find my route';
    for (const control of document.querySelectorAll('#add-stop-form input, #add-stop-form button, .remove-stop, .place-option')) {
        control.disabled = value || Boolean(currentJourney?.sample);
    }
}

async function api(url, options = {}, signal) {
    const response = await fetch(url, { ...options, signal });
    let body;
    try {
        body = await response.json();
    } catch {
        throw new Error('The server returned an unreadable response. Please try again.');
    }
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'The trip service is temporarily unavailable.');
    return body;
}

function validateJourney(journey) {
    const path = journey?.paths?.[0];
    const validPoint = point => point && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
        && Number.isFinite(point.lng) && Math.abs(point.lng) <= 180;
    const places = journey?.start?.address && journey?.end?.address ? journeyStops(journey) : [];
    if (!places.length || !places.every(place => validPoint(place.point))
        || !Number.isFinite(path?.distance) || path.distance < 0 || !Number.isFinite(path.time) || path.time < 0
        || !Array.isArray(path.points?.coordinates) || path.points.coordinates.length < 2
        || !path.points.coordinates.every(point => Array.isArray(point) && point.length >= 2
            && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180
            && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90)) {
        throw new Error('The route service returned incomplete route data. Please try another journey.');
    }
}

async function runRequest(work, label) {
    requestController?.abort();
    requestController = new AbortController();
    const version = ++requestVersion;
    const signal = AbortSignal.any([requestController.signal, AbortSignal.timeout(65000)]);
    setBusy(true);
    showMessage('request-error', '');
    text('request-status', label);
    try {
        const result = await work(signal);
        if (version !== requestVersion) return;
        signal.throwIfAborted();
        if (result) {
            validateJourney(result.journey);
            renderJourney(result);
        }
    } catch (error) {
        if (version !== requestVersion) return;
        if (signal.aborted && signal.reason?.name === 'AbortError') {
            text('request-status', 'Request canceled.' + (currentJourney ? ' Your previous route is still shown.' : ''));
        } else {
            showMessage('request-error', error.name === 'TimeoutError'
                ? 'Planning took too long. Try fewer stops or try again shortly.'
                : error.message === 'Failed to fetch' ? 'Cannot reach EasyTrip. Check your connection and try again.' : error.message);
            text('request-status', currentJourney ? 'Your previous route is still shown; it has not been updated.' : '');
        }
    } finally {
        if (version === requestVersion) setBusy(false);
    }
}

if (window.L) {
    map = L.map('map', { scrollWheelZoom: false }).setView([45.65, 10.65], 8);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19
    }).on('tileerror', () => { byId('map-notice').hidden = false; }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
} else {
    text('map-notice', 'The interactive map could not load. Route details and navigation links still work.');
    byId('map-notice').hidden = false;
}

function drawMap(journey) {
    if (!map) return;
    if (routeLayer) routeLayer.remove();
    markerLayer.clearLayers();
    poiMarkers.clear();
    routeLayer = L.geoJSON(journey.paths[0].points, {
        style: { color: '#174b3d', weight: 5, opacity: 0.9 }
    }).addTo(map);
    const places = journeyStops(journey);
    places.forEach((place, index) => {
        const last = index === places.length - 1;
        const icon = L.divIcon({
            className: 'route-marker' + (last ? ' destination' : ''),
            html: index === 0 ? 'A' : last ? 'B' : String(index), iconSize: [28, 28], iconAnchor: [14, 14]
        });
        const popup = document.createElement('span');
        popup.textContent = placeName(place);
        L.marker([place.point.lat, place.point.lng], { icon, title: placeName(place) }).bindPopup(popup).addTo(markerLayer);
    });
    routeBounds = routeLayer.getBounds();
    for (const poi of journeyPois(journey)) {
        const popup = poiCard(poi);
        const tooltip = poiCard(poi);
        const marker = L.marker([poi.lat, poi.lon], {
            icon: L.divIcon({ className: 'poi-marker', html: 'i', iconSize: [28, 28], iconAnchor: [14, 14] }),
            title: poi.tags.name, riseOnHover: true, zIndexOffset: 500
        }).bindPopup(popup, { maxWidth: 280, minWidth: 220, maxHeight: 300 }).addTo(markerLayer);
        if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
            marker.bindTooltip(tooltip, { className: 'poi-tooltip', interactive: true, direction: 'top', offset: [0, -12] });
        }
        marker.getElement().setAttribute('aria-label', 'Point of interest: ' + poi.tags.name);
        poiMarkers.set(poi.type + '/' + poi.id, marker);
        marker.on('popupopen', () => {
            marker.closeTooltip();
            populatePoiCard(popup, poi).then(() => marker.getPopup()?.update());
        });
        marker.on('tooltipopen', () => populatePoiCard(tooltip, poi).then(() => marker.getTooltip()?.update()));
        routeBounds.extend([poi.lat, poi.lon]);
    }
    map.fitBounds(routeBounds, { padding: [35, 35], maxZoom: 17 });
    byId('fit-route').hidden = false;
}

function renderJourney(result) {
    const { journey, profile, sample = false } = result;
    currentJourney = { journey, profile, sample };
    const path = journey.paths[0];
    const count = (journey.intermediates || []).length;
    byId('results').hidden = false;
    byId('empty-state').hidden = true;
    text('map-heading', sample ? 'A little walk through Verona' : `${journey.start.address.name} to ${journey.end.address.name}`);
    text('route-kind', sample ? 'Sample route' : { car: 'Driving route', bike: 'Cycling route', foot: 'Walking route' }[profile]);
    text('map-caption', sample ? 'Saved example from this project. Not a live search.'
        : 'Real route geometry. Your stops, in order.' + (journeyPois(journey).length
            ? ' Amber i markers: hover or tap for place photos and details.' : ''));
    text('route-distance', distance(path.distance));
    text('route-time', minutes(path.time));
    text('route-stop-count', String(count));
    text('result-note', sample
        ? 'Sample route from the project documentation, not a live search. Plan a live journey to add or remove stops.'
        : 'Travel time excludes visits, breaks, and live traffic. Suggested stops are towns; POI markers show nearby places, not confirmed visits. Google Maps may recalculate routes or limit stops on mobile; verify the full itinerary before navigating.');
    byId('navigation-link').href = navigationUrl(journey, profile);
    text('request-status', sample ? 'Sample route loaded. Live trip planning requires a configured routing provider.' : 'Your route is ready. Review the stops before setting out.');
    showMessage('route-warnings', (journey.warnings || []).join(' '));
    byId('itinerary').replaceChildren();
    const places = journeyStops(journey);
    places.forEach((place, index) => {
        const item = document.createElement('li');
        const number = document.createElement('span');
        number.className = 'stop-number';
        number.textContent = index === 0 ? 'A' : index === places.length - 1 ? 'B' : String(index);
        const content = document.createElement('div');
        content.className = 'stop-content';
        const name = document.createElement('p');
        name.className = 'stop-name';
        name.textContent = placeName(place);
        const detail = document.createElement('p');
        detail.className = 'stop-detail';
        detail.textContent = index === 0 ? 'Your starting point' : index === places.length - 1 ? 'Your destination' : sample ? 'Sample waypoint' : 'A stop along your route';
        const description = index === places.length - 1 ? journey.end : journey.intermediates?.[index - 1];
        if (description?.weather?.current) detail.textContent += ' | Weather now: ' + description.weather.current;
        content.append(name, detail);
        const pois = Array.isArray(description?.poi) ? description.poi.filter(validPoi) : [];
        if (pois.length) {
            const choices = document.createElement('div');
            choices.className = 'poi-list';
            choices.setAttribute('role', 'group');
            choices.setAttribute('aria-label', 'Nearby points of interest');
            for (const poi of pois) {
                const choice = document.createElement('button');
                choice.type = 'button';
                choice.className = 'poi-choice';
                choice.textContent = poi.tags.name;
                choice.setAttribute('aria-label', 'View ' + poi.tags.name);
                choice.addEventListener('click', () => {
                    const marker = poiMarkers.get(poi.type + '/' + poi.id);
                    if (map && marker) {
                        byId('map').scrollIntoView({ block: 'start' });
                        map.setView([poi.lat, poi.lon], 17, { animate: false });
                        marker.openPopup();
                    } else {
                        let card = choice.nextElementSibling;
                        if (!card?.classList.contains('poi-card')) {
                            card = poiCard(poi);
                            choice.after(card);
                        }
                        populatePoiCard(card, poi);
                    }
                });
                choices.append(choice);
            }
            content.append(choices);
        }
        item.append(number, content);
        if (index > 0 && index < places.length - 1) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'remove-stop';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', 'Remove stop ' + place.name);
            remove.disabled = sample;
            remove.addEventListener('click', () => {
                const remaining = (currentJourney.journey.intermediates || []).map(stop => stop.address);
                remaining.splice(index - 1, 1);
                recalculate(remaining);
            });
            item.append(remove);
        }
        byId('itinerary').append(item);
    });
    byId('add-stop-form').hidden = count >= 8 || sample;
    byId('place-options').replaceChildren();
    drawMap(journey);
    if (window.matchMedia('(max-width: 720px)').matches) {
        byId('map').scrollIntoView({ block: 'start' });
    }
}

function recalculate(intermediates) {
    if (!currentJourney || currentJourney.sample || busy) return;
    const previous = currentJourney;
    runRequest(async signal => {
        const journey = await api('/v1/trip/route', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                profile: previous.profile,
                stops: { start: previous.journey.start.address, end: previous.journey.end.address, intermediates: intermediates.map(details => ({ details })) }
            })
        }, signal);
        const previousPlaces = [previous.journey.start, ...(previous.journey.intermediates || []), previous.journey.end];
        for (const place of [journey.start, ...(journey.intermediates || []), journey.end]) {
            const original = previousPlaces.find(item => item.address.point.lat === place.address.point.lat
                && item.address.point.lng === place.address.point.lng);
            if (original?.poi) place.poi = original.poi;
        }
        return { journey, profile: previous.profile };
    }, 'Updating the route with your chosen stops...');
}

form.addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(form);
    const minDistance = Number(fields.get('minDistance')) * 1000;
    const maxDetour = Number(fields.get('maxDetour')) * 1000;
    if (maxDetour > minDistance / 2) {
        showMessage('request-error', 'Stop search distance must be at most half the minimum stop spacing.');
        return;
    }
    if (Number(fields.get('limit')) > 0 && !fields.getAll('interest').length) {
        showMessage('request-error', 'Choose at least one interest for suggested stops, or select Just the route.');
        return;
    }
    const profile = fields.get('profile');
    const query = new URLSearchParams({
        start: fields.get('start').trim(), end: fields.get('end').trim(), profile,
        limit: fields.get('limit'), minDistance: String(minDistance), maxDetour: String(maxDetour),
        weather: String(fields.has('weather')), bikes: 'false'
    });
    fields.getAll('interest').forEach(interest => query.append('interest', interest));
    runRequest(async signal => ({
        journey: await api('/v1/trip/travel?' + query, {}, signal), profile
    }), 'Finding your route and looking for stops along the way...');
});

byId('swap-places').addEventListener('click', () => {
    const start = byId('start');
    const end = byId('end');
    [start.value, end.value] = [end.value, start.value];
    form.dispatchEvent(new Event('input'));
});

form.addEventListener('input', () => {
    if (currentJourney && !busy) text('request-status', 'Your inputs changed. Find a new route to apply them; the previous route is still shown.');
});

byId('cancel-request').addEventListener('click', () => requestController?.abort());
for (const preset of document.querySelectorAll('.preset-button')) {
    preset.addEventListener('click', () => {
        if (busy) return;
        const walk = preset.dataset.preset === 'walk';
        byId('start').value = walk ? 'Piazza Bra, Verona, Italy' : 'Trento, Italy';
        byId('end').value = walk ? 'Ponte Pietra, Verona, Italy' : 'Verona, Italy';
        form.querySelector(`input[name="profile"][value="${walk ? 'foot' : 'car'}"]`).checked = true;
        byId('limit').value = walk ? '1' : '2';
        byId('min-distance').value = walk ? '1' : '20';
        byId('max-detour').value = walk ? '0.5' : '10';
        form.querySelector('input[name="interest"][value="tourism"]').checked = true;
        text('request-status', 'Journey idea filled in. Choose Find my route to calculate a live itinerary.'
            + (currentJourney ? ' Your previous route is still shown.' : ''));
        form.scrollIntoView({ block: 'start' });
        byId('start').focus({ preventScroll: true });
    });
}

byId('share-trip').addEventListener('click', async () => {
    if (!currentJourney || busy) return;
    const { journey, profile } = currentJourney;
    const url = navigationUrl(journey, profile);
    const title = `EasyTrip: ${journey.start.address.name} to ${journey.end.address.name}`;
    const button = byId('share-trip');
    button.disabled = true;
    try {
        if (navigator.share) {
            await navigator.share({ title, text: 'My itinerary, including stops. Google Maps may recalculate the route.', url });
            text('request-status', 'Itinerary shared.');
        } else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(url);
            text('request-status', 'Navigation link copied. Share it with your travel companions; Google Maps may recalculate the route.');
        } else {
            throw new Error('Sharing is not supported here. Use Open navigation and copy its link instead.');
        }
    } catch (error) {
        if (error.name === 'AbortError') text('request-status', 'Sharing canceled.');
        else showMessage('request-error', error.message || 'Could not share this itinerary. Use the Open navigation link instead.');
    } finally {
        button.disabled = busy;
    }
});
byId('fit-route').addEventListener('click', () => {
    if (map && routeBounds) map.fitBounds(routeBounds, { padding: [35, 35], maxZoom: 17 });
});

byId('explore-example').addEventListener('click', () => {
    if (busy) return;
    runRequest(async signal => {
        const path = await api('/example-route.json', {}, signal);
        const coordinates = path.points.coordinates;
        const place = (name, point) => ({ name, city: 'Verona', country: 'Italy', point: { lat: point[1], lng: point[0] } });
        return {
            sample: true, profile: 'foot',
            journey: {
                start: { address: place('Via degli Alpini - start', coordinates[0]) },
                end: { address: place('Via degli Alpini - end', coordinates[coordinates.length - 1]) },
                intermediates: [{ address: place('Via degli Alpini - waypoint', coordinates[1]) }],
                paths: [path], warnings: []
            }
        };
    }, 'Loading the saved sample route...');
});

byId('add-stop-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy || !currentJourney || currentJourney.sample) return;
    const address = byId('add-stop').value.trim();
    if (!address) return;
    byId('place-options').replaceChildren();
    runRequest(async signal => {
        const result = await api('/v1/trip/places?' + new URLSearchParams({ address }), {}, signal);
        if (!result.hits?.length) throw new Error('No matching places. Try a more specific address.');
        for (const place of result.hits) {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'place-option outline-button';
            option.textContent = 'Add ' + placeName(place);
            option.addEventListener('click', () => recalculate([...(currentJourney.journey.intermediates || []).map(stop => stop.address), place]));
            byId('place-options').append(option);
        }
        text('request-status', 'Choose the matching place to add it before your destination.');
    }, 'Looking for matching places...');
});

api('/v1/status', {}, AbortSignal.timeout(10000)).then(status => {
    weatherAvailable = status.weather === true;
    byId('weather').disabled = busy || !weatherAvailable;
    text('weather-status', weatherAvailable ? '' : '(not configured)');
    text('service-status', status.routing
        ? 'Live routing is configured. Pick your journey and explore along the way.'
        : 'Live routing needs a GraphHopper API key on the server. You can explore the sample walk while setup is completed.');
    byId('service-status').classList.toggle('ready', status.routing === true);
}).catch(error => {
    text('service-status', 'Could not check live service availability. ' + error.message);
    text('weather-status', '(availability unknown)');
});
