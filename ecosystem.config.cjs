// pm2 process definition for Lift-Off.
//
//   npm run build && pm2 start ecosystem.config.cjs
//
// The UI/API server also serves the built React app from web/dist, so a single
// process is all you need in production.

module.exports = {
  apps: [
    {
      name: 'liftoff',
      cwd: __dirname,
      script: 'server/dist/index.js',
      interpreter: 'node',
      node_args: '--enable-source-maps',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      watch: false,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: '4000',
      },
    },
  ],
};
