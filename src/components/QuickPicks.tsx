import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Loader2, Plus, Sparkles, X } from 'lucide-react';
import { tcpPing } from '../lib/nativeBridge';
import { apiFetch } from '../lib/api';
import { QUICK_PICKS, QUICK_PICK_TONES, type QuickPick } from '../lib/quickPicks';
import type { ScanSiteResult, Site } from '../types';

interface QuickPicksProps {
  sites: Site[];
  darkMode: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
  onSitesChanged: () => void;
  onOpenCatalog: () => void;
  /** Результаты последнего замера — показываем доступность и пинг в чипах. */
  results?: ScanSiteResult[];
}

/**
 * Быстрый выбор сервисов: то, что уже добавлено, висит компактными чипами прямо
 * под главной кнопкой, остальное раскрывается по «Добавить сервис».
 * Любой чип можно убрать — сервис удаляется из каталога.
 */
export const QuickPicks: React.FC<QuickPicksProps> = ({
  sites,
  darkMode,
  showToast,
  onSitesChanged,
  onOpenCatalog,
  results = [],
}) => {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const byDomain = useMemo(() => {
    const map = new Map<string, Site>();
    sites.forEach((s) => map.set(s.domain.replace(/^www\./, '').toLowerCase(), s));
    return map;
  }, [sites]);

  const resultByDomain = useMemo(() => {
    const map = new Map<string, ScanSiteResult>();
    results.forEach((r) => map.set(r.domain.replace(/^www\./, '').toLowerCase(), r));
    return map;
  }, [results]);

  const added = useMemo(
    () =>
      QUICK_PICKS.map((pick) => ({
        pick,
        site: byDomain.get(pick.domain.replace(/^www\./, '').toLowerCase()),
      })).filter((x): x is { pick: QuickPick; site: Site } => Boolean(x.site)),
    [byDomain]
  );

  const notAdded = useMemo(
    () => QUICK_PICKS.filter((pick) => !byDomain.has(pick.domain.replace(/^www\./, '').toLowerCase())),
    [byDomain]
  );

  const handleAdd = async (pick: QuickPick) => {
    if (busy) return;
    setBusy(pick.id);
    try {
      await apiFetch('/api/sites', {
        method: 'POST',
        body: JSON.stringify({
          name: pick.name,
          domain: pick.domain,
          probe_url: pick.probeUrl,
          category: pick.category,
          marker_role: pick.role,
          description: `${pick.hint}. Добавлено из быстрого выбора 4 ноября 2026.${
            pick.caveat ? ` ${pick.caveat}` : ''
          }`,
        }),
      });
      showToast('success', `${pick.name} добавлен — попадёт в следующий замер`);
      onSitesChanged();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Не удалось добавить сервис');
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (pick: QuickPick, site: Site) => {
    if (busy) return;
    setBusy(pick.id);
    try {
      await apiFetch(`/api/sites/${site.id}`, { method: 'DELETE' });
      showToast('info', `${pick.name} убран из каталога`);
      onSitesChanged();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Не удалось убрать сервис');
    } finally {
      setBusy(null);
    }
  };

  // Запоминаем выбранные сервисы: каталог в APK локальный и при перезапуске
  // мог не содержать добавленные ранее карточки — восстанавливаем их сами.
  useEffect(() => {
    const raw = localStorage.getItem('pulsenet_quick_ids');
    if (!raw) return;
    let ids: string[] = [];
    try {
      ids = JSON.parse(raw) as string[];
    } catch {
      return;
    }
    const present = new Set(added.map((a) => a.pick.id));
    const missing = QUICK_PICKS.filter((pick) => ids.includes(pick.id) && !present.has(pick.id));
    if (missing.length === 0) return;
    missing.reduce(
      (chain, pick) =>
        chain.then(async () => {
          try {
            await apiFetch('/api/sites', {
              method: 'POST',
              body: JSON.stringify({
                name: pick.name,
                domain: pick.domain,
                probe_url: pick.probeUrl,
                category: pick.category,
                marker_role: pick.role,
                description: `${pick.hint}. Восстановлено из быстрого выбора 5 ноября 2026.`,
              }),
            });
          } catch {
            // одну не удалось — остальные всё равно пробуем
          }
        }),
      Promise.resolve() as Promise<unknown>
    ).then(() => onSitesChanged());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem('pulsenet_quick_ids', JSON.stringify(added.map((a) => a.pick.id)));
  }, [added.map((a) => a.pick.id).join(',')]);

  const [gamePing, setGamePing] = useState<Record<string, { ok: boolean; ms: number | null }>>({});
  const gameIds = added.filter((a) => a.pick.gameHost).map((a) => a.pick.id).join(',');

  useEffect(() => {
    if (!gameIds) return;
    let alive = true;
    added
      .filter((a) => a.pick.gameHost)
      .forEach(async ({ pick }) => {
        const res = await tcpPing(pick.gameHost as string, pick.gamePort || 9339);
        if (!alive) return;
        setGamePing((prev) => ({ ...prev, [pick.id]: { ok: res.ok, ms: res.latency_ms } }));
      });
    return () => {
      alive = false;
    };
  }, [gameIds]);

  const chip = darkMode
    ? 'bg-slate-900/70 border-slate-800 text-slate-200'
    : 'bg-white border-slate-200 text-slate-700';

  return (
    <div className="mt-3">
      {/* Мои сервисы — крупные карточки со статусом и пингом */}
      <div
        className={`rounded-2xl border p-3 ${
          darkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-white border-slate-200 shadow-sm'
        }`}
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-[11px] uppercase tracking-wider font-bold text-slate-400">
            Мои сервисы · {added.length}
          </span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-sky-500/40 bg-sky-500/10 text-sky-400 text-[11px] font-bold active:scale-95"
          >
            {expanded ? <ChevronDown className="w-3 h-3 rotate-180" /> : <Plus className="w-3 h-3" />}
            {expanded ? 'Свернуть' : 'Добавить'}
          </button>
        </div>

        {added.length === 0 ? (
          <p className="text-[11px] text-slate-500 py-1">
            Пока пусто — нажмите «Добавить» и выберите сервисы, за которыми хотите следить.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {added.map(({ pick, site }) => {
              const r = resultByDomain.get(pick.domain.replace(/^www\./, '').toLowerCase());
              const tone =
                !r || r.status === 'blocked'
                  ? { dot: 'bg-rose-400', text: 'text-rose-400', label: r ? 'заблокирован' : 'не проверялся' }
                  : r.status === 'slow'
                  ? { dot: 'bg-amber-400', text: 'text-amber-400', label: 'медленно' }
                  : { dot: 'bg-emerald-400', text: 'text-emerald-400', label: pick.caveat ? 'сайт открыт' : 'работает' };
              return (
                <div
                  key={pick.id}
                  className={`relative rounded-2xl border px-2.5 py-2.5 ${
                    darkMode ? 'bg-slate-950/60 border-slate-800' : 'bg-slate-50 border-slate-200'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleRemove(pick, site)}
                    disabled={busy === pick.id}
                    className="absolute top-1.5 right-1.5 p-1 rounded-full text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 active:scale-90"
                    aria-label={`Убрать ${pick.name}`}
                  >
                    {busy === pick.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                  </button>

                  <div className="flex items-center gap-1.5 pr-5">
                    <span className="text-base leading-none">{pick.emoji}</span>
                    <span className="text-xs font-bold truncate">{pick.name}</span>
                  </div>

                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${tone.dot}`} />
                    <span className={`text-[11px] font-semibold ${tone.text}`}>{tone.label}</span>
                    <span className="ml-auto text-[10px] font-mono text-slate-500">
                      {r?.latency_ms != null ? `${r.latency_ms} мс` : '—'}
                    </span>
                  </div>

                  {pick.gameHost && (
                    <p className="mt-1 text-[9.5px] leading-tight font-semibold text-slate-400">
                      {gamePing[pick.id]
                        ? gamePing[pick.id].ok
                          ? `игровой сервер: ${gamePing[pick.id].ms} мс (TCP ${pick.gamePort || 9339})`
                          : 'игровой сервер недоступен — нужен VPN'
                        : 'проверяем игровой сервер…'}
                    </p>
                  )}
                  {pick.caveat && (
                    <p className="mt-1 text-[9px] leading-tight text-slate-500">
                      доступность сайта, не игрового сервера
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Раскрывающаяся сетка */}
      {expanded && (
        <div className="mt-3 rounded-2xl border p-3" style={{ borderColor: 'transparent' }}>
          <div className="flex items-center gap-2 mb-2.5">
            <Sparkles className="w-3.5 h-3.5 text-sky-400" />
            <span className="text-[11px] font-bold">Популярное</span>
            <button
              type="button"
              onClick={onOpenCatalog}
              className="ml-auto text-[11px] text-sky-400 hover:underline"
            >
              свой сайт →
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {notAdded.map((pick) => {
              const tone = QUICK_PICK_TONES[pick.tone] || QUICK_PICK_TONES.sky;
              const isBusy = busy === pick.id;
              return (
                <button
                  key={pick.id}
                  type="button"
                  disabled={isBusy}
                  onClick={() => handleAdd(pick)}
                  title={pick.caveat || pick.hint}
                  className={`text-left rounded-xl border p-2.5 bg-gradient-to-br ${tone} active:scale-[0.98] transition-transform`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-base leading-none">{pick.emoji}</span>
                    <span className={`text-[11px] font-bold truncate ${darkMode ? 'text-white' : 'text-slate-900'}`}>
                      {pick.name}
                    </span>
                    <span className="ml-auto shrink-0">
                      {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                    </span>
                  </div>
                  <div className="text-[10px] mt-0.5 opacity-75 line-clamp-1">{pick.hint}</div>
                </button>
              );
            })}

            {notAdded.length === 0 && (
              <div className="col-span-2 sm:col-span-3 flex items-center gap-1.5 text-[11px] text-emerald-400 py-1">
                <Check className="w-3.5 h-3.5" /> Все сервисы из списка уже в каталоге
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
