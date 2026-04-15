module.exports = {
  apps: [
    {
      name: 'persalink',
      script: 'apps/server/dist/apps/server/src/main/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
