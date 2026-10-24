'use strict';

const { test, expect } = require('@playwright/test');
const fixture = require('../docExamples/miniPath.json');
const start = { name: 'Trento', country: 'Italy', point: { lat: 46.06, lng: 11.12 } };
const end = { name: 'Verona', country: 'Italy', point: { lat: 45.44, lng: 10.99 } };
const stop = { name: 'Rovereto', country: 'Italy', point: { lat: 45.89, lng: 11.04 } };
const journey = () => ({
    start: { address: start }, end: { address: end }, intermediates: [{ address: stop }],
    paths: [structuredClone(fixture)], warnings: []
});
const museum = {
    type: 'node', id: 123, lat: 45.439, lon: 10.99,
    tags: { name: 'City Museum', 'addr:city': 'Verona', tourism: 'museum' }
};
const museumDetails = () => ({
    description: 'A local history museum with archaeological collections.',
    address: 'Museum Street 2, Verona', openingHours: 'Tu-Su 10:00-18:00',
    website: 'https://museum.example/', wheelchair: 'yes', fee: 'yes',
    image: {
        url: 'https://thumb.wikimedia.org/museum.jpg', author: 'Photo author',
        license: 'CC BY-SA 4.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Museum.jpg'
    },
    sources: [{ label: 'OpenStreetMap', url: 'https://www.openstreetmap.org/node/123' }],
    warnings: []
});

async function mockPoiJourney(page, details = museumDetails()) {
    await mockCapabilities(page);
    await page.route('**/v1/trip/travel?**', route => route.fulfill({
        json: { ...journey(), intermediates: [{ address: stop, poi: [museum, museum] }] }
    }));
    await page.route('**/v1/trip/poi/node/123', route => route.fulfill({ json: details }));
    await page.route('https://thumb.wikimedia.org/**', route => route.fulfill({
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    }));
    await page.goto('/');
    await fillJourney(page);
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.locator('.poi-marker')).toHaveCount(1);
}

test('POI hover cards and touch popups show actual photos, useful facts, and credits', async ({ page }, testInfo) => {
    await mockPoiJourney(page);
    const marker = page.getByRole('button', { name: 'Point of interest: City Museum' });
    if (testInfo.project.name === 'desktop') await marker.hover();
    else await marker.click();
    const card = page.locator(testInfo.project.name === 'desktop' ? '.leaflet-tooltip .poi-card' : '.leaflet-popup .poi-card');
    await expect(card.getByRole('heading', { name: 'City Museum' })).toBeVisible();
    await expect(card.locator('.poi-photo')).toBeVisible();
    await expect.poll(() => card.locator('.poi-photo').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(card).toContainText('archaeological collections');
    await expect(card).toContainText('Tu-Su 10:00-18:00');
    await expect(card).toContainText('Photo author');
    await expect(card).toContainText('CC BY-SA 4.0');
    await expect(card.getByRole('link', { name: 'Photo source & license' })).toHaveAttribute('href', /commons.wikimedia.org/);
    await expect(card.getByRole('link', { name: 'Official website' })).toHaveAttribute('href', 'https://museum.example/');
});

test('places without verified photos explain their absence instead of showing unrelated images', async ({ page }) => {
    await mockPoiJourney(page, { ...museumDetails(), image: null });
    await page.locator('.poi-marker').click();
    const card = page.locator('.leaflet-popup .poi-card');
    await expect(card.locator('.poi-photo-status')).toHaveText('No photo is available for this place.');
    await expect(card.locator('.poi-photo')).toBeHidden();
    await expect(card).toContainText('Museum Street 2');
    await expect(page.locator('#itinerary li')).toHaveCount(3);
});

test('overlapping map POIs remain individually accessible through the itinerary', async ({ page }) => {
    await mockCapabilities(page);
    await page.route('**/v1/trip/travel?**', route => route.fulfill({
        json: { ...journey(), intermediates: [{
            address: stop, poi: [museum, { ...museum, id: 124, tags: { ...museum.tags, name: 'Second Museum' } }]
        }] }
    }));
    await page.route('**/v1/trip/poi/node/*', route => route.fulfill({ json: { ...museumDetails(), image: null } }));
    await page.goto('/');
    await fillJourney(page);
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.locator('.poi-marker')).toHaveCount(2);
    await page.getByRole('button', { name: 'View City Museum', exact: true }).click();
    await expect(page.locator('.leaflet-popup').getByRole('heading', { name: 'City Museum', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'View Second Museum', exact: true }).click();
    await expect(page.locator('.leaflet-popup').getByRole('heading', { name: 'Second Museum', exact: true })).toBeVisible();
});

test('unavailable POI metadata is visible without breaking the route', async ({ page }) => {
    await mockPoiJourney(page);
    await page.route('**/v1/trip/poi/node/123', route => route.fulfill({
        status: 502, json: { error: 'Place details are temporarily unavailable.' }
    }));
    await page.locator('.poi-marker').click();
    const card = page.locator('.leaflet-popup .poi-card');
    await expect(card.locator('.poi-status')).toContainText('temporarily unavailable');
    await expect(card.locator('.poi-photo')).toBeHidden();
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('#itinerary li')).toHaveCount(3);
});

test('route updates retain POIs for remaining stops and remove orphaned POIs', async ({ page }) => {
    await mockCapabilities(page);
    const second = { name: 'Second stop', point: { lat: 45.7, lng: 11 } };
    await page.route('**/v1/trip/travel?**', route => route.fulfill({
        json: { ...journey(), intermediates: [
            { address: stop, poi: [museum] },
            { address: second, poi: [{ ...museum, id: 124, lat: 45.45 }] }
        ] }
    }));
    await page.route('**/v1/trip/route', route => route.fulfill({
        json: {
            ...journey(),
            intermediates: route.request().postDataJSON().stops.intermediates.map(item => ({ address: item.details }))
        }
    }));
    await page.goto('/');
    await fillJourney(page);
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.locator('.poi-marker')).toHaveCount(2);
    await page.getByRole('button', { name: 'Remove stop Second stop' }).click();
    await expect(page.locator('.poi-marker')).toHaveCount(1);
    await page.getByRole('button', { name: 'Remove stop Rovereto' }).click();
    await expect(page.locator('.poi-marker')).toHaveCount(0);
});

test.beforeEach(async ({ page }) => {
    // Keep browser checks deterministic and avoid hitting the public tile service.
    await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({
        contentType: 'image/png',
        body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    }));
});

async function mockCapabilities(page) {
    await page.route('**/v1/status', route => route.fulfill({ json: { routing: true, weather: false } }));
}

async function fillJourney(page, profile = 'bike') {
    await page.getByLabel('Starting from').fill('Trento');
    await page.getByLabel('Going to').fill('Verona');
    await page.locator(`input[name=profile][value=${profile}]`).check();
}

test('guest planner explains missing configuration without pretending to work', async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('The journey is');
    await expect(page.locator('#service-status')).toContainText('needs a GraphHopper API key');
    await expect(page.getByLabel('Include weather', { exact: false })).toBeDisabled();
    await fillJourney(page);
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.getByRole('alert')).toContainText('Live routing is not configured');
    if (testInfo.project.name === 'mobile') await expect(page.getByRole('alert')).toBeInViewport();
    await expect(page.locator('#results')).toBeHidden();
    expect(errors).toEqual([]);
});

test('saved example is explicitly labeled and displays route geometry and navigation', async ({ page }, testInfo) => {
    let liveSearches = 0;
    page.on('request', request => { if (request.url().includes('/v1/trip/travel')) liveSearches++; });
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore a sample walk' }).click();
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('#route-distance')).toHaveText('135 m');
    await expect(page.locator('#route-kind')).toHaveText('Sample route');
    if (testInfo.project.name === 'mobile') await expect(page.locator('#map')).toBeInViewport();
    await expect(page.locator('#result-note')).toContainText('not a live search');
    await expect(page.locator('#map .leaflet-overlay-pane path')).toHaveCount(1);
    await expect(page.locator('.route-marker')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Remove stop' })).toBeDisabled();
    const navigation = new URL(await page.getByRole('link', { name: 'Open navigation' }).getAttribute('href'));
    expect(navigation.searchParams.get('travelmode')).toBe('walking');
    expect(navigation.searchParams.get('waypoints')).toBeTruthy();
    expect(liveSearches).toBe(0);
});

test('live search sends the selected mode and renders a usable itinerary', async ({ page }) => {
    await mockCapabilities(page);
    let query;
    await page.route('**/v1/trip/travel?**', route => {
        query = new URL(route.request().url()).searchParams;
        return route.fulfill({ json: journey() });
    });
    await page.goto('/');
    await fillJourney(page, 'foot');
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.locator('#route-kind')).toHaveText('Walking route');
    await expect(page.locator('#itinerary li')).toHaveCount(3);
    await expect(page.locator('#route-stop-count')).toHaveText('1');
    expect(query.get('profile')).toBe('foot');
    expect(query.getAll('interest')).toEqual(['tourism']);
    expect(query.get('weather')).toBe('false');
    await expect(page.getByRole('link', { name: 'Open navigation' })).toHaveAttribute('href', /travelmode=walking/);
});

test('removing a stop recalculates geometry using the displayed route mode', async ({ page }) => {
    await mockCapabilities(page);
    await page.route('**/v1/trip/travel?**', route => route.fulfill({ json: journey() }));
    let payload;
    await page.route('**/v1/trip/route', route => {
        payload = route.request().postDataJSON();
        return route.fulfill({ json: { ...journey(), intermediates: [] } });
    });
    await page.goto('/');
    await fillJourney(page, 'bike');
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.locator('#results')).toBeVisible();
    await page.locator('input[name=profile][value=foot]').check();
    await expect(page.locator('#request-status')).toContainText('previous route is still shown');
    await page.getByRole('button', { name: 'Remove stop Rovereto' }).click();
    await expect(page.locator('#route-stop-count')).toHaveText('0');
    expect(payload.profile).toBe('bike');
    expect(payload.stops.intermediates).toEqual([]);
    await expect(page.locator('#route-kind')).toHaveText('Cycling route');
});

test('adding a stop requires choosing a matching place and recalculates the route', async ({ page }) => {
    await mockCapabilities(page);
    await page.route('**/v1/trip/travel?**', route => route.fulfill({ json: journey() }));
    const extra = { name: 'Lake Garda', country: 'Italy', point: { lat: 45.6, lng: 10.6 } };
    await page.route('**/v1/trip/places?**', route => route.fulfill({ json: { hits: [extra] } }));
    let payload;
    await page.route('**/v1/trip/route', route => {
        payload = route.request().postDataJSON();
        return route.fulfill({ json: { ...journey(), intermediates: payload.stops.intermediates.map(item => ({ address: item.details })) } });
    });
    await page.goto('/');
    await fillJourney(page);
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.locator('#results')).toBeVisible();
    await page.getByLabel('Add somewhere you want to visit').fill('Lake Garda');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: 'Add Lake Garda, Italy' }).click();
    await expect(page.locator('#route-stop-count')).toHaveText('2');
    expect(payload.stops.intermediates[1].details).toEqual(extra);
    expect(payload.profile).toBe('bike');
});

test('optional information failures are visible without losing the route', async ({ page }) => {
    await mockCapabilities(page);
    await page.route('**/v1/trip/travel?**', route => route.fulfill({
        json: { ...journey(), warnings: ['Weather is unavailable. The route is still available.'] }
    }));
    await page.goto('/');
    await fillJourney(page);
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('#route-warnings')).toContainText('Weather is unavailable');
});

test('a POI outage shows a direct route with no fabricated suggested stops', async ({ page }) => {
    await mockCapabilities(page);
    await page.route('**/v1/trip/travel?**', route => route.fulfill({
        json: {
            ...journey(), intermediates: [],
            warnings: ['Suggested stops could not be loaded. Showing the direct route without suggested stops.']
        }
    }));
    await page.goto('/');
    await fillJourney(page);
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.locator('#results')).toBeVisible();
    await expect(page.locator('#route-warnings')).toContainText('direct route without suggested stops');
    await expect(page.locator('#route-stop-count')).toHaveText('0');
    await expect(page.locator('#itinerary li')).toHaveCount(2);
    await expect(page.getByRole('alert')).toBeHidden();
    await expect(page.getByRole('link', { name: 'Open navigation' })).toHaveAttribute('href', /travelmode=bicycling/);
});

test('a failed route update keeps the previous route and explains that it is unchanged', async ({ page }) => {
    await mockCapabilities(page);
    await page.route('**/v1/trip/travel?**', route => route.fulfill({ json: journey() }));
    await page.route('**/v1/trip/route', route => route.fulfill({ status: 502, json: { error: 'Route service unavailable.' } }));
    await page.goto('/');
    await fillJourney(page);
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.locator('#results')).toBeVisible();
    await page.getByRole('button', { name: 'Remove stop Rovereto' }).click();
    await expect(page.getByRole('alert')).toContainText('Route service unavailable');
    await expect(page.locator('#request-status')).toContainText('previous route is still shown');
    await expect(page.locator('#route-stop-count')).toHaveText('1');
});

test('invalid stop options fail before requesting an expensive route', async ({ page }) => {
    await page.goto('/');
    await fillJourney(page);
    await page.getByText('Fine-tune your journey').click();
    await page.getByLabel('Stop search distance (km)').fill('15');
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.getByRole('alert')).toContainText('at most half');
    await expect(page.locator('#results')).toBeHidden();
});

test('incomplete route data never becomes a success-shaped itinerary', async ({ page }) => {
    await mockCapabilities(page);
    await page.route('**/v1/trip/travel?**', route => route.fulfill({ json: { paths: [] } }));
    await page.goto('/');
    await fillJourney(page);
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.getByRole('alert')).toContainText('incomplete route data');
    await expect(page.locator('#results')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Find my route' })).toBeEnabled();
});

test('canceling a slow request restores the planner without showing a stale response', async ({ page }) => {
    await mockCapabilities(page);
    let release;
    let fulfill;
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/v1/trip/travel?**', async route => {
        fulfill = route;
        await held;
    });
    await page.goto('/');
    await fillJourney(page);
    const pending = page.waitForRequest('**/v1/trip/travel?**');
    await page.getByRole('button', { name: 'Find my route' }).click();
    await pending;
    await page.getByRole('button', { name: 'Cancel request' }).click();
    await expect(page.locator('#request-status')).toHaveText('Request canceled.');
    await expect(page.getByRole('button', { name: 'Find my route' })).toBeEnabled();
    release();
    await fulfill.fulfill({ json: journey() });
    await expect(page.locator('#results')).toBeHidden();
});

test('place names are rendered as text, not executable markup', async ({ page }) => {
    await mockCapabilities(page);
    const malicious = '<img src=x onerror="window.bad=true">';
    const result = journey();
    result.intermediates[0].address = { ...stop, name: malicious };
    await page.route('**/v1/trip/travel?**', route => route.fulfill({ json: result }));
    await page.goto('/');
    await fillJourney(page);
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.locator('#itinerary')).toContainText(malicious);
    expect(await page.evaluate(() => window.bad)).toBeUndefined();
    expect(await page.locator('#itinerary img').count()).toBe(0);
});

test('mobile and desktop layouts fit the viewport and inputs have accessible labels', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Starting from')).toBeVisible();
    await expect(page.getByLabel('Going to')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await page.getByRole('button', { name: 'Explore a sample walk' }).click();
    await expect(page.locator('#results')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test('journey ideas fill editable inputs without spending live provider requests', async ({ page }) => {
    let requests = 0;
    page.on('request', request => { if (request.url().includes('/v1/trip/travel')) requests++; });
    await page.goto('/');
    await page.getByRole('button', { name: 'A walk in Verona', exact: true }).click();
    await expect(page.getByLabel('Starting from')).toHaveValue('Piazza Bra, Verona, Italy');
    await expect(page.locator('input[name=profile][value=foot]')).toBeChecked();
    await expect(page.getByLabel('Suggested stops')).toHaveValue('1');
    await expect(page.locator('#request-status')).toContainText('Find my route');
    await page.getByRole('button', { name: 'Trento to Verona', exact: true }).click();
    await expect(page.getByLabel('Starting from')).toHaveValue('Trento, Italy');
    await expect(page.locator('input[name=profile][value=car]')).toBeChecked();
    expect(requests).toBe(0);
});

test('sharing copies the displayed itinerary and mode rather than changed form inputs', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: async value => { window.copiedItinerary = value; } }, configurable: true
        });
    });
    await mockCapabilities(page);
    await page.route('**/v1/trip/travel?**', route => route.fulfill({ json: journey() }));
    await page.goto('/');
    await fillJourney(page, 'bike');
    await page.getByRole('button', { name: 'Find my route' }).click();
    await expect(page.locator('#results')).toBeVisible();
    await page.locator('input[name=profile][value=foot]').check();
    await page.getByRole('button', { name: 'Share itinerary' }).click();
    await expect(page.locator('#request-status')).toContainText('Navigation link copied');
    const url = new URL(await page.evaluate(() => window.copiedItinerary));
    expect(url.searchParams.get('travelmode')).toBe('bicycling');
    expect(url.searchParams.get('waypoints')).toBe('45.89,11.04');
});

test('canceling native sharing is not reported as a route failure', async ({ page }) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'share', {
            value: async () => { throw new DOMException('Canceled', 'AbortError'); }, configurable: true
        });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Explore a sample walk' }).click();
    await page.getByRole('button', { name: 'Share itinerary' }).click();
    await expect(page.locator('#request-status')).toHaveText('Sharing canceled.');
    await expect(page.getByRole('alert')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Share itinerary' })).toBeEnabled();
});

test('keyboard users can select a travel mode and submit a route', async ({ page }) => {
    await mockCapabilities(page);
    await page.route('**/v1/trip/travel?**', route => route.fulfill({ json: journey() }));
    await page.goto('/');
    await page.getByLabel('Starting from').fill('Trento');
    await page.getByLabel('Going to').fill('Verona');
    await page.locator('input[name=profile][value=foot]').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('input[name=profile][value=foot]')).toBeChecked();
    await page.getByRole('button', { name: 'Find my route' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#route-kind')).toHaveText('Walking route');
    await expect(page.locator('#request-status')).toContainText('ready');
});

test('missing map JavaScript leaves a usable itinerary and explicit map notice', async ({ page }) => {
    await page.route('**/vendor/leaflet/leaflet.js', route => route.abort());
    await page.goto('/');
    await expect(page.locator('#map-notice')).toContainText('interactive map could not load');
    await page.getByRole('button', { name: 'Explore a sample walk' }).click();
    await expect(page.locator('#itinerary li')).toHaveCount(3);
    await expect(page.getByRole('link', { name: 'Open navigation' })).toHaveAttribute('href', /maps/);
});

test('narrow screens keep customer controls readable and touch targets usable', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/');
    expect(await page.getByLabel('Starting from').evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
    const preset = await page.getByRole('button', { name: 'A walk in Verona', exact: true }).boundingBox();
    expect(preset.height).toBeGreaterThanOrEqual(44);
    await page.getByRole('button', { name: 'Explore a sample walk' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('customer privacy information and search descriptions are available without planning', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('EasyTrip | Plan routes with interesting stops');
    await expect(page.locator('meta[name=description]')).toHaveAttribute('content', /driving, cycling, and walking/);
    await page.getByText('Your journey, your choice', { exact: true }).click();
    await expect(page.locator('#privacy')).toContainText('GraphHopper');
    await expect(page.locator('#privacy')).toContainText('No analytics trackers');
});
