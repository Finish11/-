/**
 * base64 без зависимостей от окружения.
 *
 * Раньше разбор подписок использовал `Buffer.from(...)` — он есть в Node на
 * сервере, но его НЕТ в WebView Android. Любая base64-подписка в APK падала
 * с ReferenceError, а ошибка выглядела как «ничего не нашлось». Здесь чистая
 * реализация: работает и в браузере, и на сервере, и в WebView.
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < CHARS.length; i += 1) map[CHARS[i]] = i;
  // URL-безопасный алфавит
  map['-'] = 62;
  map['_'] = 63;
  return map;
})();

function toBytes(input: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(input);
  // Крайний случай: считаем строку latin1
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) out[i] = input.charCodeAt(i) & 0xff;
  return out;
}

/** Кодирует UTF-8 строку в base64 (стандартный алфавит). */
export function encodeBase64(input: string): string {
  const bytes = toBytes(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = bytes[i + 1];
    const b3 = bytes[i + 2];
    out += CHARS[b1 >> 2];
    out += CHARS[((b1 & 3) << 4) | ((b2 ?? 0) >> 4)];
    out += b2 === undefined ? '=' : CHARS[((b2 & 15) << 2) | ((b3 ?? 0) >> 6)];
    out += b3 === undefined ? '=' : CHARS[b3 & 63];
  }
  return out;
}

/** Убирает пробелы/переводы строк и добивает padding. */
export function normalizeBase64(input: string): string {
  const cleaned = input.replace(/[\s\r\n]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = cleaned.length % 4;
  return pad === 0 ? cleaned : cleaned + '='.repeat(4 - pad);
}

function decodeToBytes(input: string): Uint8Array | null {
  const clean = normalizeBase64(input).replace(/=+$/, '');
  if (!clean) return new Uint8Array(0);
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const val = LOOKUP[clean[i]];
    if (val === undefined) return null;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/**
 * Декодирует base64 в UTF-8 строку. Возвращает '' если это не base64.
 * Не бросает исключений — парсер подписок не должен падать из-за одного узла.
 */
export function decodeBase64(input: string): string {
  const bytes = decodeToBytes(input);
  if (!bytes) return '';
  try {
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    let str = '';
    for (let i = 0; i < bytes.length; i += 1) str += String.fromCharCode(bytes[i]);
    return str;
  } catch {
    return '';
  }
}

/** Похоже ли строку на base64-блок (а не на список ссылок). */
export function looksLikeBase64(text: string): boolean {
  const t = text.trim();
  if (t.length < 24) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  // Внутри не должно быть пробелов-разделителей слов: только base64-алфавит и переносы
  return /^[A-Za-z0-9+/_=\r\n\s]+$/.test(t);
}
