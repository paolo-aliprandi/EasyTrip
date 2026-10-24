'use strict';

const { strToPoint, pointObjCompleteNames, pointArrayToObj, parseBoolean } = require("../../../common/functions");
const { PROFILES } = require("../../../common/dataStructures");
const providerRequest = require('../../../common/graphhopper');

const geolib = require('geolib');

let MSG = {
    badRequest: "Bad Request", //Error code: 400
    serverError: "Server error", //Error code: 500
    notFound: "Data not found", //Error code: 404
}

function providerFailure(res, error) {
    console.error('Routing provider failed:', error.name);
    res.status(error.status || 502).json({
        error: error.status === 429
            ? 'GraphHopper request limit reached. Wait before trying again or check your account limits.'
            : 'Routing provider is unavailable.'
    });
}

module.exports.geocode = async (req, res) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
    res.setHeader('Access-Control-Allow-Credentials', true);

    let address = req.query.address; //Controlli su Injection
    let limit = req.query.limit;
    let closestToStr = req.query.closestTo;
    let onlyPlacesStr = req.query.onlyPlaces;

    let onlyPlaces = false;
    let closest = {
        details: undefined,
        dist: Number.MAX_SAFE_INTEGER
    };
    let closestPlace = {
        details: undefined,
        dist: Number.MAX_SAFE_INTEGER
    };
    let tmpPoint,closestTo,currentDist;
    if (typeof address === "string" && address.trim().length > 0 && address.length <= 300
            && (limit == undefined || Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 10)
            && (closestToStr == undefined || (tmpPoint = strToPoint(closestToStr)) != null && tmpPoint.length == 2 && (closestTo = pointArrayToObj(tmpPoint)) != null)
            && (onlyPlacesStr == undefined || closestTo != undefined && (onlyPlaces = parseBoolean(onlyPlacesStr)) != null)) {
        const query = new URLSearchParams({ q: address.trim() });
        if (limit != undefined) query.set('limit', limit);
        return providerRequest('geocode', query).then(response => {
            if (Array.isArray(response.hits) && response.hits.length > 0) {
                if (closestTo != undefined) {
                    for (const result of response.hits) {
                        currentDist = geolib.getDistance(closestTo,pointObjCompleteNames(result.point));
                        if (currentDist < closest.dist) {
                            closest.dist = currentDist;
                            closest.details = result;
                        }
                        if (onlyPlaces && result.osm_key == "place" && currentDist < closestPlace.dist) {
                            closestPlace.dist = currentDist;
                            closestPlace.details = result;
                        }
                    }
                    res.status(200).json({
                        hits: [onlyPlaces && closestPlace.details != undefined ? closestPlace.details : closest.details]
                    });
                } else {
                    res.status(200).json(response);
                }
            } else {
                res.status(404).json({
                    error: MSG.notFound
                });
            }
        })
        .catch(err => {
            providerFailure(res, err);
        });
    } else {
        res.status(400).json({
            error: MSG.badRequest
        });
    }
};

module.exports.route = async (req, res) => {
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
    res.setHeader('Access-Control-Allow-Credentials', true);

    let strPoints = req.query.point;
    let profile = req.query.profile;
    let shortAnswer = req.query.shortAnswer;
    
    let right = true;
    let points;
    let i = 0;
    if (strPoints != undefined && Array.isArray(strPoints) && strPoints.length >= 2
     && (profile == undefined || PROFILES[profile] != undefined)
     && (shortAnswer == undefined || shortAnswer === 'true' || shortAnswer === 'false')) {
        points = Array(strPoints.length);
        while (right && i < strPoints.length) {
            if (typeof strPoints[i] !== "string") {
                right = false;
                break;
            }
            points[i] = strToPoint(strPoints[i]);
            right = points[i] != null && points[i].length === 2
                && Math.abs(points[i][0]) <= 90 && Math.abs(points[i][1]) <= 180;
            i++;
        }
    } else {
        right = false;
    }

    if (right) {
        const query = new URLSearchParams({ profile: profile || 'car', points_encoded: 'false' });
        strPoints.forEach(point => query.append('point', point));
        if (shortAnswer === 'true') {
            query.set('instructions', 'false');
            query.set('calc_points', 'false');
        }
        return providerRequest('route', query).then(response => res.status(200).json(response))
        .catch(err => {
            providerFailure(res, err);
        });
    } else {
        res.status(400).json({
            error: MSG.badRequest
        });
    }
};