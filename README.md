# EasyTrip
A guest trip planner for driving, cycling, and walking. Discover interesting
places along the way, customize your stops, and share an itinerary with your
travel companions. No account is needed for guest planning.

## Features
* Interactive routes with distance, travel time, and editable stops.
* Bounded interest-based town suggestions and identity-linked POI information.
* Mobile-friendly planning, keyboard controls, and itinerary sharing.
* An explicitly labeled sample walk to explore before configuring live routing.
* Legacy account, trip history, weather, and bike-sharing APIs from the original
  Service Design and Engineering project.

## Quick start: guest planner

Install Node.js 22 or newer and run `npm ci`. Copy `.env.example` to `.env` if
you do not already have one, set `GRAPHHOPPER_KEY`, then run `npm run start:guest`.
Open **http://localhost:12349**. No database or Google OAuth setup is needed for
this mode. Without a routing key, the saved sample walk still works.

## Legacy full server
Use Node.js 22 or newer. Copy `.env.example` to `.env`, configure a MongoDB
connection, a random `TOKEN_SECRET`, and Google OAuth credentials for the existing
authentication service. Never commit `.env`.

Set the Google OAuth client's authorized redirect URI to
`http://localhost:12345/v1/users/auth/google/callback`.

### Dependecies intallation
```
npm install
```
### Server start
```
npm start
```

### Guest trip planner

Open **http://localhost:12349** after starting the server. The guest planner is
served by the existing facade, with no separate frontend build or account needed
to plan a trip.

- Enter a start and destination, choose driving, cycling, or walking, and select
  interests and the maximum number of suggested stops.
- Inspect the route, distance, and travel time, remove stops, or search for a
  place and explicitly choose it to add it before the destination.
- Hover over an amber **i** marker, or tap it on mobile, for a real point of
  interest's photo, background, address, opening hours, and source links where
  available. Photo credits and licensing links are included.
- Choose a POI's name in the itinerary to zoom directly to its card, including
  when nearby map markers overlap.
- Open the resulting itinerary in Google Maps. The navigation service may
  recalculate the route; travel times exclude visits and live traffic.
- Use **Explore a sample walk** to view the saved Verona route from
  `docExamples/miniPath.json`. It is clearly labeled as a sample and is never
  substituted for a failed live search.

Live planning and place lookup require `GRAPHHOPPER_KEY`. An absent key produces
an explicit setup message, not a fabricated itinerary. `WEATHER_API_KEY` enables
optional weather; missing or failed weather does not invalidate a route.
Restart the server after changing environment variables.

Automatic stop discovery also uses the existing GraphHopper key. It requests
bounded, category-filtered POIs using representative search terms per interest
(for example, museums and attractions), rather than requiring a POI's name to
contain the nearest village's name. Results are checked
against the requested interests and geographic bounds, normalized to the
existing OSM element format, and deduplicated, with at most ten results per area,
before towns are ranked. The actual discovered POIs are passed to the guest UI;
they are not fetched a second time for each town.
No additional POI key is required. These lookups consume GraphHopper credits;
monitor account limits before public rollout. This is a limited geocoding
search, not an exhaustive POI database or a promise of a specific stop count.

Identical GraphHopper requests are coalesced and cached in memory for five
minutes, with at most 128 entries, to avoid spending credits on repeated searches.
Provider request limits are reported as HTTP 429 with an actionable message
rather than an unexplained 502. Caching does not increase the account's quota.
GraphHopper's free plan is non-commercial and has minute-level limits;
a public commercial SaaS needs an appropriate paid plan.

POI cards load metadata only when opened. The backend reads the exact OSM
node/way/relation, follows its Wikidata identifier for a description and photo,
and obtains the photo and attribution from Wikimedia Commons. Metadata is
coalesced and cached for an hour (one minute for partial failures), with at most
128 entries. Photos are never chosen merely because they are nearby. A missing
photo is explicitly labeled; metadata failures do not discard the route.
Opening hours are community-maintained, not a verified live opening status.

If suggested-stop discovery fails after a valid route is found, the planner
shows the real direct route with an explicit warning and no suggested stops.
It does not report the outage as "no matching stops" or invent stop data.
You can still add a custom stop using GraphHopper place search. A failure of
the route provider itself remains an error, not a sample or success response.

Stop search distance is a geographic search parameter, **not** a guaranteed
detour distance or time. It is the distance from a sampled route point to each
edge of the search square; the provider receives twice that value as the square
side. Samples are placed by cumulative route distance, not geometry-point
density, and duplicate suggested towns are removed.
The recommendation algorithm suggests towns
based on POIs. Nearby POI markers are not automatically added as route waypoints
and do not imply confirmed visits or access.

The former Angular 13 UI is a separate project at
https://github.com/EasyTripSDE/EasyTripGUI; it is not required for this guest planner.
The existing Google login callback still redirects to that UI on port 4200.
This change does not replace or harden the legacy authentication flow.

### Checks

```sh
npm test
npm run check
npx playwright install chromium webkit
npm run test:ui
```

Browser coverage includes desktop Chromium, mobile Chromium, and mobile WebKit.
GitHub Actions runs the syntax checks, unit/integration tests, production
dependency audit, and all browser projects on pushes and pull requests.

Browser checks use an isolated facade on port 12449 and mocked route responses.
They do not load local secrets, contact live route providers, or require MongoDB.
Map tiles are mocked in browser checks; the local application uses OpenStreetMap
tiles with attribution. Use appropriately provisioned routing, POI, and map-tile
services before a public rollout. The legacy `/v1/locations/nearbyCities`
endpoint still uses Overpass, but the guest planner and automatic stop
discovery no longer depend on it. A public Overpass instance is not a
production backend for a consumer SaaS.

### Public guest deployment

The repository includes a Render Blueprint. Create a Blueprint in your own
Render account using this repository and enter `GRAPHHOPPER_KEY` as a secret
when prompted. It uses the free web-service plan; check current hosting and
provider terms before launch. The service starts with `npm run start:guest`,
honors the hosting provider's `PORT`, and exposes `/healthz` for health checks.
Internal routing services bind only to loopback. Guest mode does not start
legacy authentication or require MongoDB, Google OAuth, or a signing secret.
The existing `npm start` behavior is unchanged.

[Deploy the guest planner on Render](https://render.com/deploy?repo=https://github.com/paolo-aliprandi/EasyTrip).
This requires signing into your own hosting account; a Blueprint file alone
does not make the application live. The Blueprint requests no database or
OAuth secrets.

Guest API traffic is limited per IP to 60 requests per minute, with 10 planning,
place-search, or route-edit requests per minute. The server trusts one reverse
proxy only on Render. Other reverse proxies need an explicitly reviewed trust
configuration before use. GraphHopper calls are paced at least 300 ms apart,
limited to 16 pending/in-flight requests, and capped at 30 requests per minute
and 400 per rolling day per server process. Cached/coalesced requests do not
spend this budget. A provider HTTP 429 pauses new uncached calls for one minute.
These are conservative application guardrails, not a promise that the current
provider plan supports those rates. They reset on restart and are not a
distributed quota system; do not scale instances without shared limits.
Provider minute limits still apply even when daily credits remain. Commercial
launch requires an appropriate GraphHopper plan and a capacity/load review.
Internal request logs omit query strings so searched addresses are not logged.

Do not upload `.env` or copy unrelated credentials to the hosting service.
Optionally set `WEATHER_API_KEY` in its environment to enable weather.
Verify live driving, cycling, walking, suggested stops, custom stop editing,
POI details, and provider-limit messages at the assigned HTTPS URL before
sharing it. Automated browser tests mock providers and cannot establish
production provider availability. Free hosting may sleep when idle.

The home page includes search and social-sharing descriptions, and
`robots.txt` excludes API endpoints. Set `PUBLIC_URL` to your permanent HTTPS
origin, or use Render's automatic `RENDER_EXTERNAL_URL`, to enable a canonical
home-page URL, social URL, and `/sitemap.xml`. After deployment, set the repository's
website to the real public URL, register that URL with search-engine webmaster
tools, and share useful, genuine example itineraries with relevant travel
communities. Submit the sitemap in the webmaster tools.
These measures support discovery but do not guarantee views; measure
search impressions, clicks, and completed plans before expanding promotion.
No visitor tracking or third-party analytics is enabled by default.

### Launch gates

Before inviting customers, verify the deployed HTTPS URL and monitoring,
configure adequate provider quotas and map-tile capacity, check applicable
provider terms, and exercise a real route with each travel mode and stop edits.
Weather needs a separate configured key. Automated tests verify its unavailable
and failure paths, not an unconfigured live weather service. Legacy OAuth and
database-dependent account flows are not part of the public guest deployment.
Search-based POI coverage varies by area and is not exhaustive; empty suggestions
must remain explicit rather than being replaced by invented stops.
The free hosting plan is a preview option, not an uptime commitment.

## Docker execution
Move the `docker-compose.yml` file out of the `EasyTrip` folder
Create the following structure:
 - `docker-compose.yml`
 - `EasyTrip` (the folder containing the code of the server)
 - `EasyTripGUI` (the folder containing the code relative to the angular project)

Execute the command:
```
docker-compose up --build
```

## Disclaimer

The service may not work because of outdated or expired API key. If you need assistance, open an issue :)
