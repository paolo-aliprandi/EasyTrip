'use strict';

// Browser checks must not load the developer's private credentials or database.
delete process.env.GRAPHHOPPER_KEY;
delete process.env.WEATHER_API_KEY;
process.env.EASYTRIP_GUEST_ONLY = 'true';
require('../processes/EasyTripFacade/service').listen(12449, '127.0.0.1');
