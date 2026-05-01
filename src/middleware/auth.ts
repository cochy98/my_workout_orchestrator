import { Request, Response, NextFunction } from 'express';
import { validateToken, LaravelUser } from '../services/laravel.bridge';

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header.' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const user: LaravelUser = await validateToken(token);
    res.locals.user = user;
    res.locals.token = token;
    next();
  } catch (err: unknown) {
    const axiosErr = err as { response?: { status: number } };

    if (axiosErr.response?.status === 401) {
      res.status(401).json({ error: 'Invalid or expired token.' });
    } else {
      console.error('[Auth] Token validation failed:', err);
      res.status(502).json({ error: 'Unable to validate token with auth service.' });
    }
  }
}
