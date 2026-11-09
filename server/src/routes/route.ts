import type { NextFunction, Request, Response } from 'express';

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
/** Wraps a handler: its return value is sent as JSON; a thrown error goes to the error handler. */
export const route =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).then((body) => {
      if (!res.headersSent) res.json(body ?? { ok: true });
    }, next);
  };
