'use strict';

module.exports = function createBudget() {
    let minuteStart = Date.now();
    let dayStart = minuteStart;
    let minuteRequests = 0;
    let dayRequests = 0;
    return () => {
        const now = Date.now();
        if (now - minuteStart >= 60000 || now < minuteStart) {
            minuteStart = now;
            minuteRequests = 0;
        }
        if (now - dayStart >= 86400000 || now < dayStart) {
            dayStart = now;
            dayRequests = 0;
        }
        if (minuteRequests >= 30 || dayRequests >= 400) {
            const error = new Error('The application routing request budget is exhausted.');
            error.status = 429;
            error.statusCode = 429;
            throw error;
        }
        minuteRequests++;
        dayRequests++;
    };
};
