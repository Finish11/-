import React, { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Plus, Sparkles, TriangleAlert } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { QUICK_PICKS, QUICK_PICK_TONES, type QuickPick } from '../lib/quickPicks';
import type { Site } from '../types';

interface QuickPicksProps {
  sites: Site[];
  darkMode: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
  onSitesChanged: () => void;
  /** Компактный режим — сетка в две колонки без описаний. */
  compact?: boolean;
}

/**
 * «Быстрый выбор»: популярные сервисы (AI-чаты, мессенджеры, YouTube, игры),
 * которые добавляются в каталог одним тапом и сразу участвуют в замерах.
 */
export const QuickPicks: React.FC<QuickPicksProps> = ({
  sites,
  darkMode,
  showToast,
  onSitesChanged,
  compact = false,
}) => {
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const knownDomains = useMemo(
    () => new Set(sites.map((s) => s.domain.replace(/^www\./, '').toLowerCase())),
    [sites]
  );

  useEffect(() => {
    const next = new Set<string>();
    for (const pick of QUICK_PICKS) {
      if (knownDomains.has(pick.domain.replace(/^www\./, '').toLowerCase())) next.add(pick.id);
    }
    setAdded(next);
  }, [knownDomains]);

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
      setAdded((prev) => new Set(prev).add(pick.id));
      showToast('success', `${pick.name} добавлен в каталог — попадёт в следующий замер`);
      onSitesChanged();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Не удалось добавить сервис');
    } finally {
      setBusy(null);
    }
  };

  const card = darkMode ? 'bg-slate-900/60 border-slate-800/80' : 'bg-white border-slate-200';

  return (
    <div className={`rounded-3xl border p-4 sm:p-5 ${card}`}>
      <div className="flex items-start gap-2.5">
        <div className="w-9 h-9 rounded-xl bg-sky-500/15 border border-sky-400/30 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-sky-400" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-bold">Быстрый выбор сервисов</h3>
          <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
            Добавьте то, чем пользуетесь: сервисы попадут в каталог и будут проверяться при
            каждом замере — удобно сверять, что открывается с VPN, а что без.
          </p>
        </div>
      </div>

      <div className={`grid gap-2 mt-3 ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'}`}>
        {QUICK_PICKS.map((pick) => {
          const isAdded = added.has(pick.id);
          const isBusy = busy === pick.id;
          const tone = QUICK_PICK_TONES[pick.tone] || QUICK_PICK_TONES.sky;
          return (
            <button
              key={pick.id}
              type="button"
              disabled={isAdded || isBusy}
              onClick={() => handleAdd(pick)}
              title={pick.caveat || pick.hint}
              className={`relative text-left rounded-2xl border p-3 transition-all active:scale-[0.98] ${
                isAdded
                  ? darkMode
                    ? 'border-emerald-500/30 bg-emerald-500/10'
                    : 'border-emerald-300 bg-emerald-50'
                  : `bg-gradient-to-br ${tone} hover:brightness-110`
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg leading-none">{pick.emoji}</span>
                <span
                  className={`text-xs font-bold truncate ${
                    isAdded ? 'text-emerald-400' : darkMode ? 'text-white' : 'text-slate-900'
                  }`}
                >
                  {pick.name}
                </span>
                <span className="ml-auto shrink-0">
                  {isAdded ? (
                    <Check className="w-4 h-4 text-emerald-400" />
                  ) : isBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin opacity-70" />
                  ) : (
                    <Plus className="w-4 h-4 opacity-70" />
                  )}
                </span>
              </div>
              {!compact && (
                <div className="text-[10px] mt-1 opacity-80 leading-snug line-clamp-2">
                  {isAdded ? 'Уже в каталоге' : pick.hint}
                </div>
              )}
              {pick.caveat && !isAdded && !compact && (
                <TriangleAlert className="absolute bottom-1.5 right-1.5 w-3 h-3 opacity-50" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
