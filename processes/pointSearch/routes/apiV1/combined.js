'use strict';

const express = require('express');
const router = express.Router();

const combinedHandler = require('../../controllers/combinedController');

router.get('/about', combinedHandler.getCombined);

module.exports = router;
