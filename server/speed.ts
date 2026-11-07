import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import express from 'express';

/**
 * Точки замера скорости на своём сервере — чтобы не зависеть от публичных
 * лимитов Cloudflare. Отдаём несжимаемые случайные байты, принимаем тело и
 * подтверждаем размер: клиент считает скорость только по подтверждённым байтам.
 */
const BLOCK = 262144;
const BLOCKS = Array.from({ length: 4 }, () => crypto.randomBytes(BLOCK));
export const SPEED_LIMITS = {
  maxDownloadBytes: 64 * 1024 * 1024,
  maxUploadBytes: 16 * 1024 * 1024,
  requestsPerMinute: 600,
  bytesPerHour: 4 * 1024 * 1024 * 1024,
};

interface Bucket { window: number; requests: number; hour: number; bytes: number }
const buckets = new Map<string, Bucket>();

function allow(ip: string, bytes: number): { ok: boolean; retryAfter?: number; error?: string } {
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const hour = Math.floor(now / 3_600_000);
  const bucket = buckets.get(ip) || { window: minute, requests: 0, hour, bytes: 0 };
  if (bucket.window !== minute) { bucket.window = minute; bucket.requests = 0; }
  if (bucket.hour !== hour) { bucket.hour = hour; bucket.bytes = 0; }
  bucket.requests += 1;
  bucket.bytes += bytes;
  buckets.set(ip, bucket);
  if (buckets.size > 5000) {
    for (const [key, value] of buckets) if (value.window < minute - 2 && value.hour < hour) buckets.delete(key);
  }
  if (bucket.requests > SPEED_LIMITS.requestsPerMinute) return { ok: false, retryAfter: 60, error: 'Слишком много запросов замера' };
  if (bucket.bytes > SPEED_LIMITS.bytesPerHour) return { ok: false, retryAfter: 3600, error: 'Часовой объём трафика замера исчерпан' };
  return { ok: true };
}

function cors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Encoding', 'identity');
}

export function registerSpeedEndpoints(app: Express): void {
  app.options('/api/speed/*', (req: Request, res: Response) => { cors(res); res.status(204).end(); });

  app.get('/api/speed/ping', (req: Request, res: Response) => {
    cors(res);
    const verdict = allow(req.ip || 'local', 0);
    if (!verdict.ok) { res.setHeader('Retry-After', String(verdict.retryAfter)); res.status(429).json({ error: verdict.error }); return; }
    res.status(204).end();
  });

  app.get('/api/speed/down', (req: Request, res: Response) => {
    cors(res);
    const requested = Number(req.query.bytes ?? 1024 * 1024);
    const total = Math.max(0, Math.min(SPEED_LIMITS.maxDownloadBytes, Number.isFinite(requested) ? Math.floor(requested) : 1024 * 1024));
    const verdict = allow(req.ip || 'local', total);
    if (!verdict.ok) { res.setHeader('Retry-After', String(verdict.retryAfter)); res.status(429).json({ error: verdict.error }); return; }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(total));
    let sent = 0;
    let index = 0;
    let closed = false;
    res.on('close', () => { closed = true; });
    const pump = () => {
      while (!closed && sent < total) {
        const size = Math.min(BLOCK, total - sent);
        const block = BLOCKS[index++ % BLOCKS.length];
        sent += size;
        const ok = res.write(size === BLOCK ? block : block.subarray(0, size));
        if (!ok) { res.once('drain', pump); return; }
      }
      if (!closed) res.end();
    };
    pump();
  });

  app.post('/api/speed/up', express.raw({ type: () => true, limit: SPEED_LIMITS.maxUploadBytes }), (req: Request, res: Response) => {
    cors(res);
    const received = Buffer.isBuffer(req.body) ? req.body.length : 0;
    const verdict = allow(req.ip || 'local', received);
    if (!verdict.ok) { res.setHeader('Retry-After', String(verdict.retryAfter)); res.status(429).json({ error: verdict.error }); return; }
    res.json({ ok: true, received });
  });
}
