const path = require('node:path');

const runtimeDir = process.env.VALORANT_UPLOAD_RELEASE_DIR || __dirname;

module.exports = {
  apps: [
    {
      name: 'valorant-upload',
      script: path.join(runtimeDir, 'server.js'),
      cwd: runtimeDir,
      instances: 1,
      exec_mode: 'fork',
      wait_ready: true,
      listen_timeout: 20000,
      kill_timeout: 10000,
      restart_delay: 3000,
      max_restarts: 5,
      min_uptime: 15000,
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        DOTENV_CONFIG_PATH:
          process.env.DOTENV_CONFIG_PATH || '/var/www/valorant-upload/.env',
        SITE_DEPLOY_VERSION: process.env.SITE_DEPLOY_VERSION || '',
      },
    },
  ],
};
