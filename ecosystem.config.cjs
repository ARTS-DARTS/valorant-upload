module.exports = {
  apps: [
    {
      name: 'valorant-upload',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
      },
    },
  ],
};
