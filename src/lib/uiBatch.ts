/**
 * Склейка частых обновлений интерфейса.
 *
 * Проверка сайтов уходит залпом до 64 проб. В браузере React сам склеивает
 * обновления, пришедшие в одной задаче, — там склейка не нужна (замеры A/B это
 * подтвердили). Но в APK каждый ответ нативного моста приходит отдельной
 * задачей, и без склейки список результатов перерисовывается до 64 раз за
 * секунду.
 *
 * Здесь обновления складываются в одно на такт: первое показывается сразу,
 * остальные — не чаще одного раза в интервал, последнее обязательно
 * применяется через `flush()`. Данные не теряются: применяется всегда самый
 * свежий снимок, а не очередь устаревших.
 */
export interface UiBatch<T> {
  /** Положить свежий снимок; интерфейс обновится не чаще раза в интервал. */
  push(value: T): void;
  /** Применить отложенное немедленно (конец проверки, отмена, уход с экрана). */
  flush(): void;
  /** Забыть отложенное, ничего не применяя. */
  cancel(): void;
}

export function createUiBatch<T>(apply: (value: T) => void, intervalMs = 120, now: () => number = () => Date.now()): UiBatch<T> {
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastApplied = Number.NEGATIVE_INFINITY;

  const clear = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
  };

  const commit = () => {
    clear();
    if (!pending) return;
    const { value } = pending;
    pending = null;
    lastApplied = now();
    apply(value);
  };

  return {
    push(value) {
      pending = { value };
      const since = now() - lastApplied;
      // Первое обновление — сразу, чтобы прогресс не «замерзал» на старте.
      if (since >= intervalMs) { commit(); return; }
      if (timer === undefined) timer = setTimeout(commit, Math.max(0, intervalMs - since));
    },
    flush: commit,
    cancel() { clear(); pending = null; },
  };
}