'use strict';

const express = require('express');
const apiV1 = express.Router();

const tripRouter = require('./apiV1/trip');
const tripController = require('../controllers/tripController');

// middleware that tracks request
apiV1.use(function timeLog(req, res, next) {
  console.log(`Requested ${req.method} ${req.path} Time: ${Date.now()}`);
	next();
});

apiV1.use('/trip', tripRouter);
if (process.env.EASYTRIP_GUEST_ONLY !== 'true') {
  apiV1.use('/history', require('./apiV1/history'));
}
apiV1.get('/status', tripController.status);

module.exports = apiV1;