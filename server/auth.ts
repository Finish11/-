import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db.ts';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  region: string;
  carrier: string;
  created_at: string;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
  sessionToken?: string;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const hashBuffer = crypto.scryptSync(password, salt, 64);
  const keyBuffer = Buffer.from(key, 'hex');
  if (hashBuffer.length !== keyBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, keyBuffer);
}

export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
  db.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).run(token, userId, now.toISOString(), expires.toISOString());
  return token;
}

export function getUserFromRequest(req: Request): { user: AuthUser; token: string } | null {
  let token: string | undefined;

  // 1. Custom headers (not stripped by cloud/iframe reverse proxies)
  const xSession = req.headers['x-session-token'] || req.headers['x-auth-token'];
  if (typeof xSession === 'string' && xSession.trim()) {
    token = xSession.trim();
  }

  // 2. Query string fallback (immune to any header filtering)
  if (!token && typeof req.query?._st === 'string' && req.query._st.trim()) {
    token = req.query._st.trim();
  }

  // 3. Standard Authorization header
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }
  }

  // 4. Cookie fallback
  if (!token && req.cookies?.pulsenet_token) {
    token = String(req.cookies.pulsenet_token).trim();
  }

  if (!token) return null;

  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.region, u.carrier, u.created_at, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token) as (AuthUser & { expires_at: string }) | undefined;

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }

  return {
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      region: row.region,
      carrier: row.carrier,
      created_at: row.created_at,
    },
    token,
  };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const session = getUserFromRequest(req);
  if (!session) {
    res.status(401).json({ error: 'Требуется авторизация' });
    return;
  }
  req.user = session.user;
  req.sessionToken = session.token;
  next();
}
