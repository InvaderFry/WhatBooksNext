import type { NextFunction, Request, Response } from 'express';

/**
 * Request checks for a login-free local app (PLAN.md §6.3). Any website the owner visits can
 * send requests to 127.0.0.1, so:
 *  - the Host header must be this app's own (blocks DNS rebinding);
 *  - state-changing requests must be JSON (forces a browser preflight, which we never answer
 *    with CORS headers) and must not carry a foreign Origin;
 *  - GET/HEAD never change anything (enforced by the routes, not here).
 */
export function requestGuard(opts: { port: number; devPorts?: number[] }) {
  const ports = [opts.port, ...(opts.devPorts ?? [])];
  const allowedHosts = new Set(ports.flatMap((p) => [`localhost:${p}`, `127.0.0.1:${p}`]));
  const allowedOrigins = new Set(
    ports.flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]),
  );

  return (req: Request, res: Response, next: NextFunction) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts.has(host)) {
      res.status(403).json({ error: 'Request refused: unexpected Host header.' });
      return;
    }
    if (req.method === 'OPTIONS') {
      // No CORS, ever: a preflight from another site simply fails.
      res.status(403).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) {
        res.status(403).json({ error: 'Request refused: it came from another website.' });
        return;
      }
      // Check the declared type itself (req.is() ignores it when there is no body, e.g. DELETE):
      // a cross-site request can only set application/json after a preflight we never answer.
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') {
        res.status(415).json({ error: 'Requests that change data must be sent as JSON.' });
        return;
      }
    }
    next();
  };
}

/** Headers that stop the app being framed or sniffed, and keep pages to their own origin. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
}
