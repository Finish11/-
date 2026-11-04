import React, { useMemo, useState } from 'react';
import { Check, ChevronDown, Loader2, Plus, Sparkles, X } from 'lucide-react';
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

  const chip = darkMode
    ? 'bg-slate-900/70 border-slate-800 text-slate-200'
    : 'bg-white border-slate-200 text-slate-700';

  return (
    <div className="mt-3">
      {/* Мои сервисы — компактные чипы под кнопкой */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
          Мои сервисы
        </span>

        {added.map(({ pick, site }) => (
          <span
            key={pick.id}
            className={`inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-full border text-[11px] font-semibold ${chip}`}
            title={pick.caveat || `${pick.domain} · пинг последнего замера: ${site.last_latency_ms ?? '—'} мс`}
          >
            <span>{pick.emoji}</span>
            {pick.name}
            {(() => {
              const r = resultByDomain.get(pick.domain.replace(/^www\./, '').toLowerCase());
              if (!r) return null;
              return (
                <span
                  className={`ml-0.5 font-mono text-[10px] ${
                    r.status === 'ok'
                      ? 'text-emerald-400'
                      : r.status === 'slow'
                      ? 'text-amber-400'
                      : 'text-rose-400'
                  }`}
                  title={r.status === 'blocked' ? 'Недоступен в последнем замере' : 'Доступен'}
                >
                  {r.latency_ms != null ? `${r.latency_ms}мс` : '×'}
                </span>
              );
            })()}
            <button
              type="button"
              onClick={() => handleRemove(pick, site)}
              disabled={busy === pick.id}
              className="p-1 rounded-full text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 active:scale-90"
              aria-label={`Убрать ${pick.name}`}
            >
              {busy === pick.id ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <X className="w-3 h-3" />
              )}
            </button>
          </span>
        ))}

        {added.length === 0 && (
          <span className="text-[11px] text-slate-500">пока пусто — добавьте свои ниже</span>
        )}

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 pl-2 pr-2.5 py-1 rounded-full border border-sky-500/40 bg-sky-500/10 text-sky-400 text-[11px] font-bold active:scale-95"
        >
          {expanded ? <ChevronDown className="w-3 h-3 rotate-180" /> : <Plus className="w-3 h-3" />}
          {expanded ? 'Свернуть' : 'Добавить сервис'}
        </button>
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
