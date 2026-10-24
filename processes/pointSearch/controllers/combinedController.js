'use strict';

let MSG = {
    badRequest: "Bad Request", //Error code: 400
    serverError: "Server error", //Errorr code: 500
}

const request = require('../../../common/http');

const fetch = (...args) =>
	import('node-fetch').then(({default: fetch}) => fetch(...args));

module.exports.getCombined = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
    res.setHeader('Access-Control-Allow-Credentials', true);


      async function getDataFromWeatherEndpoint() {
      try {
        const response = await request('http://localhost:12346/v1/weather/forecast?city='+req.query.city);
        const responseBody = JSON.parse(response);
        return responseBody;
        } catch (error) {
          //console.error(error);
        }
      }

      async function getDataFromPOIEndpoint() {
      try {
        const response = await request('http://localhost:12346/v1/poi/get?city='+req.query.city);
        const responseBody = JSON.parse(response);
        //console.log(response);
        return responseBody;
        } catch (error) {
          //console.error(error);
        }
      }

      async function getDataFromBikeEndpoint() {
      try {
        const response = await request("https://api.citybik.es/v2/networks");
        const responseBody = JSON.parse(response);
        var result=0;
        responseBody.networks.forEach((item, i) => {

          if (responseBody.networks[i].location.city === req.query.city) {
            result=responseBody.networks[i];
          }
        });
        return result;
        } catch (error) {
          //console.error(error);
        }
      }

      const weatherResponse = await getDataFromWeatherEndpoint();
      const poiResponse = await getDataFromPOIEndpoint();
      const bikeResponse = await getDataFromBikeEndpoint();

      res.status(200).json({
          success: true,
          message: weatherResponse.message+" and these are the point of interests you cannot visit anything "+" but this is the bike sharing service available: "+bikeResponse.name
      });


};
