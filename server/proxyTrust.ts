/**
 * Кому верить в заголовке X-Forwarded-For. Значение `true` доверяет любому клиенту:
 * так IP-лимит общего API обходится подделанным заголовком. По умолчанию доверяем
 * только reverse proxy на том же хосте (loopback), остальным — нет.
 * Число = количество доверенных прокси в цепочке, строка = список адресов/подсетей.
 */
export function resolveTrustProxy(value: string | undefined): string | number | boolean {
  const raw = (value ?? '').trim();
  if (!raw) return 'loopback';
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  return raw;
}
