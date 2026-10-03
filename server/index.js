// snapcash.money — one service: static pages + JSON API.
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertConfig } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { loadSession, authRouter } from './auth.js';
import { applicantRouter } from './applicant.js';
import { adminRouter, ensureOwnerAdmin } from './admin.js';
import { storageMode } from './storage.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Railway terminates TLS in front of us
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"], // admin.html uses onclick= handlers
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  }));

  app.get('/healthz', async (req, res) => {
    try { await pool.query('select 1'); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });

  // Send www and the Railway default domain to the canonical address in production.
  const canonicalHost = new URL(config.appUrl).host;
  app.use((req, res, next) => {
    if (config.isProd && req.hostname && req.get('host') !== canonicalHost && req.path !== '/healthz'
        && (req.method === 'GET' || req.method === 'HEAD') && process.env.REDIRECT_TO_CANONICAL !== 'false') {
      return res.redirect(301, config.appUrl + req.originalUrl);
    }
    next();
  });

  // Requests that change something must come from our own pages (CSRF protection on top of SameSite cookies).
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    let ok = false;
    try { ok = !!origin && new URL(origin).host === req.get('host'); } catch { ok = false; }
    if (!ok) return res.status(403).json({ error: 'Cross-site request blocked.' });
    next();
  });

  app.use('/api', express.json({ limit: '100kb' }));
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.use(loadSession);
  app.use(authRouter);
  app.use(applicantRouter);
  app.use(adminRouter);

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use(express.static(publicDir, {
    extensions: ['html'],
    dotfiles: 'ignore',
    setHeaders(res, filePath) {
      // Pages, styles and scripts revalidate on every visit so a deploy shows up at once;
      // images change rarely and can be cached for a day.
      if (/\.(png|jpe?g|svg|ico|webp)$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=86400');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  app.use((req, res) => res.status(404).sendFile(path.join(publicDir, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error('[error]', req.method, req.path, err);
    const body = { error: status >= 500 ? 'Something went wrong on our side — please try again.' : err.message };
    if (err.step) body.step = err.step;
    res.status(status).json(body);
  });

  return app;
}

async function main() {
  const warnings = assertConfig();
  await migrate();
  await ensureOwnerAdmin();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[snapcash] listening on :${config.port} (${config.isProd ? 'production' : 'development'}, files: ${storageMode})`);
    for (const w of warnings) console.warn('[snapcash] ' + w);
  });
  const shutdown = () => { server.close(() => pool.end().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Housekeeping: clear out expired sessions and one-time codes daily.
  setInterval(() => {
    pool.query(`delete from sessions where expires_at < now() - interval '1 day'`).catch(() => {});
    pool.query(`delete from phone_otps where created_at < now() - interval '7 days'`).catch(() => {});
    pool.query(`delete from auth_tokens where created_at < now() - interval '30 days'`).catch(() => {});
  }, 24 * 3600 * 1000).unref();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error('[snapcash] failed to start:', err.message); process.exit(1); });
}
