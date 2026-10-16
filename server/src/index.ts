import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { initAuth, requireAuth } from './auth.js';
import { IS_PROD, PORT, WEB_DIST, ensureDirs } from './config.js';
import { HttpError, requireAdmin } from './guards.js';
import { authRouter } from './routes/auth.js';
import { deploymentsRouter } from './routes/deployments.js';
import { settingsRouter } from './routes/settings.js';
import { sitesRouter } from './routes/sites.js';
import { usersRouter } from './routes/users.js';
import { queueDepth } from './runner.js';
import { failStuckDeployments, prunePasswordResets } from './store.js';

ensureDirs();
initAuth();
prunePasswordResets();

const recovered = failStuckDeployments();
if (recovered > 0) {
  console.log(
    `[liftoff] Marked ${recovered} interrupted deployment(s) as failed.`,
  );
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

if (!IS_PROD) {
  // The Vite dev server runs on a different origin than the API.
  app.use(
    cors({
      origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
      credentials: true,
    }),
  );
}

app.get('/api/system/health', (_req, res) => {
  res.json({
    ok: true,
    queueDepth: queueDepth(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.use('/api/auth', authRouter);
app.use('/api/sites', requireAuth, sitesRouter);
app.use('/api/deployments', requireAuth, deploymentsRouter);
app.use('/api/users', requireAuth, requireAdmin, usersRouter);
app.use('/api/settings', requireAuth, requireAdmin, settingsRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Serve the built React app when it exists (production / `npm run build`).
if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
  app.use(express.static(WEB_DIST, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .type('text/plain')
      .send(
        'Lift-Off API is running.\n\nNo web build found. Run `npm run build`, or use `npm run dev` for the UI.',
      );
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) {
    console.error('[liftoff] Unhandled error:', error);
  }
  const message = error instanceof Error ? error.message : 'Internal server error';
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`[liftoff] API listening on http://localhost:${PORT}`);
  if (!IS_PROD) {
    console.log('[liftoff] UI dev server: http://localhost:5173');
  }
});
