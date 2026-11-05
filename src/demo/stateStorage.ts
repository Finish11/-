/** Формат резервных копий локального состояния APK. */

export interface StatePacket<T = unknown> {
  state: T;
  savedAtMs: number;
}

interface StateEnvelope {
  storage_version: 1;
  saved_at: string;
  state: unknown;
}

export function encodeStatePacket(state: unknown, now = new Date()): string {
  const envelope: StateEnvelope = {
    storage_version: 1,
    saved_at: now.toISOString(),
    state,
  };
  return JSON.stringify(envelope);
}

export function decodeStatePacket<T = unknown>(raw: string | null | undefined): StatePacket<T> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StateEnvelope>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.storage_version === 1 && value.state && typeof value.state === 'object') {
      const savedAtMs = new Date(String(value.saved_at || '')).getTime();
      return {
        state: value.state as T,
        savedAtMs: Number.isFinite(savedAtMs) ? savedAtMs : 0,
      };
    }
    // Совместимость с 1.5.x: там записывалось само состояние без конверта.
    return { state: value as T, savedAtMs: 0 };
  } catch {
    return null;
  }
}

/**
 * Preferences, файл и WebView могли сохраниться в разные моменты. Берём самую
 * свежую валидную копию, а не первую доступную. При равном времени приоритет у
 * более раннего аргумента (порядок задаёт вызывающий код).
 */
export function selectNewestState<T = unknown>(
  copies: Array<string | null | undefined>
): StatePacket<T> | null {
  let best: StatePacket<T> | null = null;
  for (const raw of copies) {
    const decoded = decodeStatePacket<T>(raw);
    if (decoded && (!best || decoded.savedAtMs > best.savedAtMs)) best = decoded;
  }
  return best;
}
