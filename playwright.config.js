'use strict';

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './test',
    testMatch: 'ui.spec.js',
    fullyParallel: true,
    use: {
        baseURL: 'http://127.0.0.1:12449',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure'
    },
    projects: [
        { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
        { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
        { name: 'safari', use: { ...devices['iPhone 13'] } }
    ],
    webServer: {
        command: 'node test/ui-server.js',
        url: 'http://127.0.0.1:12449',
        reuseExistingServer: false
    }
});
