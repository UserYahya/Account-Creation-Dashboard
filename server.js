require('dotenv').config();
const { loadConfig } = require('./src/config');
const { createApp } = require('./src/app');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`CRITICAL: ${err.message}`);
  process.exit(1);
}

if (config.mockLoginIgnored) {
  console.error('ENABLE_MOCK_LOGIN is ignored because NODE_ENV=production.');
}
if (config.mockLogin) {
  console.warn('Mock login is ENABLED (local testing only). Anyone can log in as an admin via /login.');
}

const { app, start, close } = createApp(config);
start();

const server = app.listen(config.port, () => {
  console.log(`Event Dashboard is running on http://localhost:${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  server.close(() => {
    close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
