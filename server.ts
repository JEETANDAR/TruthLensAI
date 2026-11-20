import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'path';

dotenv.config();

function resolveServerPort(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--port=')) {
      const parsed = Number(arg.slice('--port='.length));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } else if (arg === '--port' && i + 1 < args.length) {
      const parsed = Number(args[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  if (process.env.npm_config_port) {
    const parsed = Number(process.env.npm_config_port);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const envPort = Number(process.env.PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  return 3000;
}

const app = express();
const PORT = resolveServerPort();

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

let ready = false;
let initError: unknown = null;

app.get('/api/health', (_req, res) => {
  if (initError) {
    res.status(500).json({ status: 'error', service: 'TruthLens AI', timestamp: new Date().toISOString() });
    return;
  }
  res.json({
    status: ready ? 'ok' : 'initializing',
    service: 'TruthLens AI',
    timestamp: new Date().toISOString(),
  });
});

const readyPromise = (async () => {
  const [{ ensureDirectories }, { getDb }, { initializeSystemDefaults }, { apiRouter }] = await Promise.all([
    import('./server/config.ts'),
    import('./server/db/database.ts'),
    import('./server/db/seed.ts'),
    import('./server/routes/api.ts'),
  ]);

  ensureDirectories();
  getDb();
  await initializeSystemDefaults();

  app.use('/api', apiRouter);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ...(disableHmr ? { hmr: false, ws: false, watch: null } : {}),
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.message : 'Internal server error';
    console.error('Express route error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: msg });
    }
  });

  ready = true;
})().catch((err) => {
  initError = err;
  console.error('Failed to start TruthLens AI server:', err);
  process.exit(1);
});

app.use(async (req, _res, next) => {
  if (ready || req.path === '/api/health') {
    next();
    return;
  }
  try {
    await readyPromise;
    next();
  } catch (err) {
    next(err);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection in TruthLens AI server:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in TruthLens AI server:', err);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`TruthLens AI server listening on http://0.0.0.0:${PORT}`);
});

server.on('error', (err) => {
  console.error(`TruthLens AI server failed to listen on port ${PORT}:`, err);
  process.exit(1);
});
