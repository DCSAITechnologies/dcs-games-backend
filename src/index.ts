// DCS Games — platform backend (api.games.dcsai.ai)
// Express + Supabase. CORS is applied BEFORE the routers (the ordering bug we hit
// on DCS Rank: mounting a router before cors() strips CORS headers on its responses).
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { publicRouter } from './routes/public.js';
import { authRouter } from './routes/auth.js';
import { playerRouter } from './routes/player.js';
import { studioRouter } from './routes/studio.js';
import { atlasRouter } from './routes/atlas.js';
import { dbReady } from './lib/supabase.js';

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://games.dcsai.ai,https://studio.games.dcsai.ai,https://atlas.games.dcsai.ai,http://localhost:3000,http://localhost:5173,http://localhost:5500'
).split(',').map((s) => s.trim());

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);               // curl / health / mobile
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));              // generation prompts; bump if base64 assets land
app.set('trust proxy', 1);

app.get('/health', (_req: Request, res: Response) =>
  res.json({ ok: true, service: 'dcs-games-backend', db: dbReady() ? 'supabase' : 'not_provisioned', ts: new Date().toISOString() }));

// Routers (all AFTER cors)
app.use('/api/public', publicRouter);
app.use('/api/auth', authRouter);       // signup/login/me — mounted BEFORE the player gate (no token yet)
app.use('/api', playerRouter);          // /api/me, /api/leaderboard, /api/market, /api/profile, …
app.use('/api/studio', studioRouter);
app.use('/api/atlas', atlasRouter);

app.use((_req: Request, res: Response) => res.status(404).json({ ok: false, error: 'not_found' }));
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err && /CORS/.test(err.message)) return res.status(403).json({ ok: false, error: 'cors_blocked' });
  console.error('[dcs-games] error', err);
  return res.status(500).json({ ok: false, error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`[dcs-games-backend] listening on :${PORT} · db=${dbReady() ? 'supabase' : 'not_provisioned'}`);
  console.log(`  allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
