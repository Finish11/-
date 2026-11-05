import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Loader2, Plus, Sparkles, X } from 'lucide-react';
import { tcpPing } from '../lib/nativeBridge';
import { apiFetch } from '../lib/api';
import { QUICK_PICKS, type QuickPick } from '../lib/quickPicks';
import type { ScanSiteResult, Site } from '../types';
import { Sheet } from './ui/Sheet';
import { Button, Chip, EmptyState } from './ui/kit';

interface QuickPicksProps {
  sites: Site[];
  darkMode: boolean;
  showToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void;
  onSitesChanged: () => void;
  onOpenCatalog: () => void;
  /** Результаты последнего замера — статус и пинг прямо в карточке. */
  results?: ScanSiteResult[];
  /** Пока идёт замер — показываем «проверяем…» вместо старых цифр. */
  scanning?: boolean;
}

const norm = (domain: string) => domain.replace(/^www\./, '').toLowerCase();

interface Visual {
  bg: string;
  fg: string;
  label: string;
  emojiBg: string;
}

/** Логотип сервиса: буква-монограмма на узнаваемом цвете (без внешних картинок). */
const BRAND: Record<string, { letter: string; from: string; to: string; fg?: string }> = {
  chatgpt: { letter: 'AI', from: '#10a37f', to: '#0d8a6a' },
  claude: { letter: 'C', from: '#d97757', to: '#b45c3f' },
  gemini: { letter: 'G', from: '#4285f4', to: '#9b72cb' },
  telegram: { letter: 'T', from: '#2aabee', to: '#229ed9' },
  whatsapp: { letter: 'W', from: '#25d366', to: '#1da851' },
  youtube: { letter: '▶', from: '#ff0000', to: '#c40000' },
  brawlstars: { letter: 'B', from: '#f59e0b', to: '#d97706' },
};

const BrandBadge: React.FC<{ id: string; size?: number }> = ({ id, size = 34 }) => {
  const brand = BRAND[id] || { letter: '•', from: '#64748b', to: '#475569' };
  return (
    <span
      className="grid place-items-center shrink-0 font-black rounded-[0.7rem]"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(145deg, ${brand.from}, ${brand.to})`,
        color: brand.fg || '#fff',
        boxShadow: `0 6px 16px -8px ${brand.from}`,
      }}
      aria-hidden="true"
    >
      {brand.letter}
    </span>
  );
};

function statusVisual(r?: ScanSiteResult, scanning?: boolean): Visual {
  if (scanning) {
    return { bg: 'var(--surface-2)', fg: 'var(--text-dim)', label: 'проверяем', emojiBg: 'transparent' };
  }
  if (!r) {
    return {
      bg: 'var(--surface-2)',
      fg: 'var(--text-muted)',
      label: 'не проверялся',
      emojiBg: 'transparent',
    };
  }
  if (r.status === 'blocked') {
    return {
      bg: 'rgb(var(--danger) / 0.1)',
      fg: 'rgb(var(--danger))',
      label: 'недоступен',
      emojiBg: 'transparent',
    };
  }
  if (r.status === 'slow') {
    return {
      bg: 'rgb(var(--warning) / 0.1)',
      fg: 'rgb(var(--warning))',
      label: 'медленно',
      emojiBg: 'transparent',
    };
  }
  return {
    bg: 'rgb(var(--success) / 0.09)',
    fg: 'rgb(var(--success))',
    label: 'работает',
    emojiBg: 'transparent',
  };
}

export const QuickPicks: React.FC<QuickPicksProps> = ({
  sites,
  showToast,
  onSitesChanged,
  onOpenCatalog,
  results = [],
  scanning = false,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const byDomain = useMemo(() => {
    const map = new Map<string, Site>();
    sites.forEach((s) => map.set(norm(s.domain), s));
    return map;
  }, [sites]);

  const resultByDomain = useMemo(() => {
    const map = new Map<string, ScanSiteResult>();
    results.forEach((r) => map.set(norm(r.domain), r));
    return map;
  }, [results]);

  const added = useMemo(
    () =>
      QUICK_PICKS.map((pick) => ({ pick, site: byDomain.get(norm(pick.domain)) })).filter(
        (x): x is { pick: QuickPick; site: Site } => Boolean(x.site)
      ),
    [byDomain]
  );

  const notAdded = useMemo(
    () => QUICK_PICKS.filter((pick) => !byDomain.has(norm(pick.domain))),
    [byDomain]
  );

  /* ---------- восстановление ранее выбранных сервисов ---------- */
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

    let cancelled = false;
    (async () => {
      for (const pick of missing) {
        try {
          await apiFetch('/api/sites', {
            method: 'POST',
            body: JSON.stringify({
              name: pick.name,
              domain: pick.domain,
              probe_url: pick.probeUrl,
              category: pick.category,
              marker_role: pick.role,
              description: `${pick.hint}. Восстановлено из быстрого выбора.`,
            }),
          });
        } catch {
          // один не восстановился — не мешаем остальным
        }
      }
      if (!cancelled) onSitesChanged();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('pulsenet_quick_ids', JSON.stringify(added.map((a) => a.pick.id)));
    } catch {
      // приватный режим
    }
  }, [added.map((a) => a.pick.id).join(',')]);

  /* ---------- TCP-пинг игровых серверов ---------- */
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

  /* ---------- добавление и удаление ---------- */
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
          description: `${pick.hint}.${pick.caveat ? ` ${pick.caveat}` : ''}`,
        }),
      });
      showToast('success', `${pick.name} добавлен — попадёт в следующий замер`);
      onSitesChanged();
      if (notAdded.length <= 1) setExpanded(false);
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

  return (
    <section>
      <div className="flex items-center justify-between gap-2 px-1 mb-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <h3 className="text-[13px] font-bold uppercase tracking-wider text-muted">Мои сервисы</h3>
          {added.length > 0 && <span className="text-[11px] text-muted">{added.length}</span>}
        </div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full accent-soft text-[11.5px] font-bold tap"
        >
          <Plus className="w-3 h-3" />
          Добавить
        </button>
      </div>

      {added.length === 0 ? (
        <div
          className="rounded-2xl border px-4 py-5 text-center"
          style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
        >
          <p className="text-[12.5px] text-dim leading-relaxed">
            Пока пусто. Добавьте сервисы, за которыми хотите следить — ChatGPT, YouTube, Telegram,
            игры и другие.
          </p>
          <Button
            variant="primary"
            size="sm"
            className="mt-3"
            icon={<Sparkles className="w-3.5 h-3.5" />}
            onClick={() => setExpanded(true)}
          >
            Выбрать сервисы
          </Button>
        </div>
      ) : (
        <div className="chip-rail -mx-1 px-1">
          {added.map(({ pick, site }) => {
            const r = resultByDomain.get(norm(pick.domain));
            const v = statusVisual(r, scanning);
            const game = gamePing[pick.id];
            return (
              <div
                key={pick.id}
                className="relative w-[9.5rem] rounded-2xl border p-2.5"
                style={{ borderColor: 'var(--line)', background: v.bg }}
              >
                <button
                  type="button"
                  onClick={() => handleRemove(pick, site)}
                  disabled={busy === pick.id}
                  className="absolute top-1 right-1 p-1.5 rounded-full text-muted hover:text-[rgb(var(--danger))] tap"
                  aria-label={`Убрать ${pick.name}`}
                >
                  {busy === pick.id ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <X className="w-3 h-3" />
                  )}
                </button>

                <BrandBadge id={pick.id} size={30} />

                <div className="mt-2 text-[12px] font-bold truncate pr-1">{pick.name}</div>

                <div className="mt-1 flex items-center gap-1.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: v.fg, opacity: scanning ? 0.5 : 1 }}
                  />
                  <span className="text-[10.5px] font-semibold truncate" style={{ color: v.fg }}>
                    {v.label}
                  </span>
                  <span className="ml-auto text-[10px] font-mono text-muted tabular-nums shrink-0">
                    {r?.latency_ms != null ? `${r.latency_ms}` : '—'}
                  </span>
                </div>

                {pick.gameHost && !scanning && (
                  <div className="mt-1 text-[9px] font-semibold text-muted truncate">
                    {game
                      ? game.ok
                        ? `игра TCP ${game.ms} мс`
                        : 'игра недоступна'
                      : 'игровой сервер…'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ---------- Выбор сервисов ---------- */}
      <Sheet
        open={expanded}
        onClose={() => setExpanded(false)}
        title="Добавить сервис"
        subtitle="Один тап — и сервис участвует в замерах"
        size="md"
        icon={
          <div className="w-9 h-9 rounded-xl grid place-items-center accent-soft">
            <Sparkles className="w-4 h-4" />
          </div>
        }
        footer={
          <>
            <Button variant="ghost" size="md" block onClick={onOpenCatalog} icon={<ChevronRight className="w-4 h-4" />}>
              Свой сайт в каталоге
            </Button>
            <Button variant="primary" size="md" block onClick={() => setExpanded(false)}>
              Готово
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          {notAdded.length === 0 ? (
            <EmptyState
              icon={<Check className="w-5 h-5" />}
              title="Все сервисы добавлены"
              text="Можно убрать любой сервис, нажав на крестик на карточке."
            />
          ) : (
            notAdded.map((pick) => {
              const isBusy = busy === pick.id;
              return (
                <button
                  key={pick.id}
                  type="button"
                  disabled={isBusy}
                  onClick={() => handleAdd(pick)}
                  className="w-full flex items-center gap-3 p-2.5 rounded-2xl border text-left tap"
                  style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
                >
                  <BrandBadge id={pick.id} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-bold truncate">{pick.name}</div>
                    <div className="text-[11px] text-dim truncate">{pick.hint}</div>
                  </div>
                  {isBusy ? (
                    <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  ) : (
                    <Plus className="w-4 h-4 shrink-0 text-muted" />
                  )}
                </button>
              );
            })
          )}

          {added.length > 0 && (
            <div className="pt-2">
              <div className="text-[11px] font-bold uppercase tracking-wider text-muted mb-1.5">
                Уже добавлены
              </div>
              <div className="flex flex-wrap gap-1.5">
                {added.map(({ pick, site }) => (
                  <Chip key={pick.id} onClick={() => handleRemove(pick, site)} title={`Убрать ${pick.name}`}>
                    <BrandBadge id={pick.id} size={16} />
                    {pick.name}
                    <X className="w-3 h-3 opacity-60" />
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>
      </Sheet>
    </section>
  );
};
