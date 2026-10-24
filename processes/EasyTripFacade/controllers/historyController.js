'use strict';

const url = require('url');
const mongoose = require('mongoose');
const model = require('../models/users');
const User = (mongoose.models && mongoose.models.User) ? mongoose.models.User : mongoose.model('User',model);

const { INTERESTS, PROFILES } = require('../../../common/dataStructures');
const { cleanWrtStruct, arrayToStr } = require('../../../common/functions');

let MSG = {
    badRequest: "Bad Request", //Error code: 400
    serverError: "Server error", //Error code: 500
}

module.exports.saveTrip = async (req, res) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
    res.setHeader('Access-Control-Allow-Credentials', true);

        const tripInfo = req.body;
        let isSafe,actualParams;

        User.findById(req.loggedUser.user_id, (err, user) => {
          if (err) {
              //console.log(err);
              res.status(500).json({
                  error: MSG.serverError
              });
          } else {
            isSafe = tripInfo.route != undefined && tripInfo.type != undefined && tripInfo.parameters != undefined;
            actualParams = new Set(["interest"]);

            if (isSafe) {
                tripInfo.parameters.interest = tripInfo.parameters.interest != undefined
                                                ? (Array.isArray(tripInfo.parameters.interest)
                                                    ? tripInfo.parameters.interest
                                                    : [tripInfo.parameters.interest])
                                                : [];
                
                if (tripInfo.parameters.weather != undefined) {
                    if (typeof tripInfo.parameters.weather == "boolean") {
                        actualParams.add("weather");
                    } else {
                        delete tripInfo.parameters.weather;
                    }
                }
                if (tripInfo.parameters.bikes != undefined) {
                    if (typeof tripInfo.parameters.bikes == "boolean") {
                        actualParams.add("bikes");
                    } else {
                        delete tripInfo.parameters.bikes;
                    }
                }
                if (tripInfo.parameters.interest.length) {
                    if (!(tripInfo.parameters.interest = cleanWrtStruct(tripInfo.parameters.interest,INTERESTS)).length) {
                        tripInfo.parameters.interest = [];
                    }
                }
                switch (tripInfo.type) {
                    case "destination":
                        isSafe = tripInfo.parameters.address != undefined;
                        if (isSafe) actualParams.add("address");
                        break;
                    case "travel":
                        isSafe = tripInfo.parameters.start != undefined && tripInfo.parameters.end != undefined;
                        if (isSafe) {
                            actualParams.add("start");
                            actualParams.add("end");
                        }
                        if (isSafe && tripInfo.parameters.limit != undefined) {
                            if (tripInfo.parameters.interest.length
                                    && !isNaN(tripInfo.parameters.limit = parseInt(tripInfo.parameters.limit)) && tripInfo.parameters.limit >= 0 && tripInfo.parameters.limit <= 8) {
                                actualParams.add("limit");
                            } else {
                                delete tripInfo.parameters.limit;
                            }
                        }
                        if (isSafe && tripInfo.parameters.minDistance != undefined) {
                            if (actualParams.has("limit")
                                    && !isNaN(tripInfo.parameters.minDistance = parseFloat(tripInfo.parameters.minDistance)) != NaN
                                    && tripInfo.parameters.minDistance >= 0) {
                                actualParams.add("minDistance");
                            } else {
                                delete tripInfo.parameters.minDistance;
                            }
                        }
                        if (isSafe && tripInfo.parameters.maxDetour != undefined) {
                            if (actualParams.has("minDistance")
                                    && !isNaN(tripInfo.parameters.maxDetour = parseFloat(tripInfo.parameters.maxDetour)) != NaN
                                    && tripInfo.parameters.maxDetour >= 0 && tripInfo.parameters.maxDetour <= tripInfo.parameters.minDistance/2) {
                                actualParams.add("maxDetour");
                            } else {
                                delete tripInfo.parameters.maxDetour;
                            }
                        }
                        if (isSafe && tripInfo.parameters.profile != undefined) {
                            if (actualParams.has("limit")
                                    && PROFILES[tripInfo.parameters.profile] != undefined) {
                                actualParams.add("profile");
                            } else {
                                delete tripInfo.parameters.profile;
                            }
                        }
                        break;
                    default:
                        isSafe = false;
                        break;
                }
            }

            if (isSafe && isCorrect(Object.keys(tripInfo.parameters),actualParams)) {

                tripInfo.dateTime = new Date().toISOString();

                user.history.push(tripInfo);
                user.save((err, updatedUser) => {
                    if(err) {
                        //console.log(err);
                        res.status(500).json({
                            error: MSG.serverError
                        });
                    } else {
                        res.status(200).json(updatedUser.history[updatedUser.history.length-1]);
                    }
                });
            } else {
                res.status(400).json({
                    error: MSG.badRequest
                });
            }
        }
    });

}

module.exports.getTrips = async (req, res) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
    res.setHeader('Access-Control-Allow-Credentials', true);

    const strLimit = req.query.limit;
    const strOffset = req.query.offset;

    let history = {};
    let mergedHistory,strAllParams,param,tmpTrip;
    User.findById(req.loggedUser.user_id,{_id: 0, history: 1},(err,docs) => {
        if (err) {
            //console.log(err);
            res.status(500).json({
                error: MSG.serverError
            });
        } else {
            mergedHistory = docs.history;
            mergedHistory.sort((a,b) => {
                let dateA = new Date(a.dateTime);
                let dateB = new Date(b.dateTime);
                return dateA < dateB ? 1 : (dateA > dateB ? -1 : 0);
            });
            for (const trip of mergedHistory) {
                tmpTrip = trip.toObject();
                strAllParams = "";
                for (const key of Object.keys(tmpTrip.parameters)) {
                    param = tmpTrip.parameters[key];
                    if (Array.isArray(param)) {
                        strAllParams += arrayToStr(param,"&" + key + "=",true);
                    } else if (param != undefined) {
                        strAllParams += "&" + key + "=" + param;
                    }
                }
                tmpTrip.url = tmpTrip.route + "/" + tmpTrip.type + "?" + strAllParams;
                if (history[tmpTrip.type] == undefined) {
                    history[tmpTrip.type] = [tmpTrip];
                } else {
                    history[tmpTrip.type].push(tmpTrip);
                }
            }
            for (const type of Object.keys(history)) {
                history[type] = cut(history[type],strOffset,strLimit);
            }
            res.status(200).json({
                history: history
            });
        }
    });
}

module.exports.deleteTrip = async (req, res) => {

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
    res.setHeader('Access-Control-Allow-Credentials', true);

    const id = req.params.id;

    User.findByIdAndUpdate(req.loggedUser.user_id,{
        $pull: {
            history: {_id: id},
        }
    },(err,doc) => {
        if (err) {
            //console.log(err);
            res.status(500).json({
                error: MSG.serverError
            });
        } else {
            res.status(200).json({});
        }
    });
}

function cut(array,strOffset,strLimit) {

    let tmpN;
    let arrayLength = array.length;
    let offset = (strOffset != undefined && !isNaN(tmpN = parseInt(strOffset)) && tmpN >= 0 && tmpN < arrayLength) ? tmpN : 0;
    let limit = (strLimit != undefined && !isNaN(tmpN = parseInt(strLimit)) && tmpN > 0 && (offset + tmpN) <= arrayLength) ? tmpN : arrayLength-offset;
    if (offset != 0 || limit != arrayLength) {
        array = array.slice(offset,offset+limit);
    }

    return array;
}

function isCorrect(toCheck,checker) {

    let right = true;
    let i = 0;
    if (toCheck.length == checker.size) {
        do {
            right = checker.has(toCheck[i]);
        } while (right && ++i < toCheck.length);
    } else {
        right = false;
    }

    return right;
}
