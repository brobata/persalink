module.exports = {
  apps: [
    {
      name: 'persalink',
      script: 'apps/server/dist/apps/server/src/main/index.js',
      cwd: __dirname,
      instances: 1,
      // fork, not cluster: one process owns the tmux PTY bridges and the
      // in-memory client map — cluster mode's IPC proxy adds nothing here.
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
