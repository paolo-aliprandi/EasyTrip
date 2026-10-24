'use strict';

const express = require('express');
const router = express.Router();

const eventHandler = require('../../controllers/tripController');
const poi = require('../../controllers/poiController');

router.get('/destination', eventHandler.destination);

router.get('/travel', eventHandler.travel);
router.get('/places', eventHandler.places);
router.get('/poi/:type/:id', poi.details);
router.post('/route', eventHandler.route);

module.exports = router;