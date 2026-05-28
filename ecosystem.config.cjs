// pm2 ecosystem config for the production backend.
//
// Usage on the Cloudways VM (after `npm run build` in both frontend/ and
// backend/):
//
//   pm2 start ecosystem.config.cjs --env production
//   pm2 save                  # persist for boot
//   pm2 startup               # generates the systemd hook (run the
//                             # printed command once as root)
//
// Deploys (after rsync / git pull a new revision):
//
//   cd frontend && npm ci && npm run build
//   cd ../backend && npm ci && npm run build
//   pm2 reload ecosystem.config.cjs --env production
//
// pm2 reload (vs restart) drains the process gracefully -- ongoing HTTP
// requests finish before the swap. WebSocket clients reconnect within
// ~5 seconds via ConnectionManager's backoff.

module.exports = {
  apps: [
    {
      name: 'newks-mdm-backend',
      script: './backend/dist/index.js',
      cwd: __dirname,
      instances: 1,                  // do not horizontally scale until we add
                                     // sticky-session / shared session store
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      // pm2 sets these in the child's process.env. They override anything in
      // .env loaded by dotenv (which is what we want -- platform-level config
      // wins over on-disk config).
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      // Other env vars (DATABASE_URL, JWT_SECRET, ENROLLMENT_SECRET,
      // ADMIN_USERNAME, ADMIN_PASSWORD on first boot) should be set via the
      // Cloudways Application Settings -> Environment Variables panel.
      // Do NOT commit secrets here.
    },
  ],
};
