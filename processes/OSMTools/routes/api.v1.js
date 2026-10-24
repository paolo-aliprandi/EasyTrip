'use strict';

const express = require('express');
const apiV1 = express.Router();

const routingAdapterRouter = require('./apiV1/routingAdapter');
const POIAdapter = require('./apiV1/POIAdapter');

// middleware that tracks request
apiV1.use(function timeLog(req, res, next) {
  console.log(`Requested ${req.method} ${req.path} Time: ${Date.now()}`);
	next();
});

apiV1.use('/routing', routingAdapterRouter);
apiV1.use('/locations', POIAdapter);

module.exports = apiV1;