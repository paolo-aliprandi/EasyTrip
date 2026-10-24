'use strict';

const express = require('express');
const apiV1 = express.Router();

const combinedRouter = require('./apiV1/combined');
const weatherRouter = require('./apiV1/weather');
const poiRouter = require('./apiV1/poi');
const bikesRouter = require('./apiV1/bikes');

// middleware that tracks request
apiV1.use(function timeLog(req, res, next) {
  console.log(`Requested ${req.method} ${req.path} Time: ${Date.now()}`);
	next();
});

apiV1.use('/combined', combinedRouter);
apiV1.use('/weather', weatherRouter);
apiV1.use('/poi', poiRouter);
apiV1.use('/bikes', bikesRouter);

module.exports = apiV1;
