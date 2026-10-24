'use strict';

require('dotenv').config();
process.env.EASYTRIP_GUEST_ONLY = 'true';

const { OSM_PORT, POINT_PORT, PATH_PORT, FACADE_PORT } = require('./common/dataStructures');

function startGuest() {
    const services = [
        ['OSM tools', require('./processes/OSMTools/service'), OSM_PORT, '127.0.0.1'],
        ['Point search', require('./processes/pointSearch/service'), POINT_PORT, '127.0.0.1'],
        ['Path search', require('./processes/pathSearch/service'), PATH_PORT, '127.0.0.1'],
        ['EasyTrip', require('./processes/EasyTripFacade/service'), process.env.PORT || FACADE_PORT, '0.0.0.0']
    ];
    for (const [name, , port] of services) {
        if (!/^\d+$/.test(String(port)) || Number(port) > 65535) {
            throw new Error(`${name} requires a valid TCP port.`);
        }
    }
    return services.map(([name, app, port, host]) => {
        const server = app.listen(Number(port), host, () => {
            console.log(`${name} listening on ${host}:${server.address().port}`);
        });
        return server;
    });
}

if (require.main === module) {
    const servers = startGuest();
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            for (const server of servers) server.close();
            const timeout = setTimeout(() => {
                for (const server of servers) server.closeAllConnections();
            }, 10000);
            timeout.unref();
        });
    }
}

module.exports = startGuest;
