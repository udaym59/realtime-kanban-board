// Rate limit for write routes. 60/min per IP matches SPEC §7.
// Attached to POST/PATCH/DELETE routes; read routes stay unlimited for the
// portfolio demo. If you ship this behind a proxy (Koyeb does TLS termination
// upstream), set `trust proxy` in server.ts so req.ip reflects X-Forwarded-For.

import { rateLimit } from 'express-rate-limit';

export const writeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'rate-limited' },
});
