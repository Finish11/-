import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, ExternalLink, GripVertical, Info, Loader2, Plus, Smartphone, Sparkles, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { isNativeApp, openInstalledApp as launchInstalledApp, tcpPing } from '../lib/nativeBridge';
import { apiFetch } from '../lib/api';
import { QUICK_PICKS, type QuickPick } from '../lib/quickPicks';
import { confirmationNodeKey, findAppConfirmation, type ConfirmationMatch } from '../lib/appConfirmations';
import type { AppConfirmation, ClientConnectionInfo, ScanSiteResult, Site, VpnProfile } from '../types';
import { Sheet } from './ui/Sheet';
import { Button, Chip, EmptyState, Notice } from './ui/kit';

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
  connection: ClientConnectionInfo | null;
  profiles: VpnProfile[];
  confirmations: AppConfirmation[];
  onConfirmationSaved: (confirmation: AppConfirmation) => void;
}

const norm = (domain: string) => domain.replace(/^www\./, '').toLowerCase();
const DOMAIN_ALIASES: Record<string, string[]> = {
  telegram: ['web.telegram.org', 'telegram.org'],
  whatsapp: ['web.whatsapp.com', 'whatsapp.com'],
};
const quickDomains = (pick: QuickPick) => DOMAIN_ALIASES[pick.id] || [pick.domain];
const findQuickValue = <T,>(map: Map<string, T>, pick: QuickPick): T | undefined => {
  for (const domain of quickDomains(pick)) {
    const value = map.get(norm(domain));
    if (value) return value;
  }
  return undefined;
};
const ORDER_KEY = 'pulsenet_quick_order';

function loadQuickOrder(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

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

function statusVisual(r?: ScanSiteResult, scanning?: boolean, confirmation?: ConfirmationMatch | null): Visual {
  if (scanning) {
    return { bg: 'var(--surface-2)', fg: 'var(--text-dim)', label: 'проверяем', emojiBg: 'transparent' };
  }
  if (confirmation) {
    return confirmation.confirmation.works
      ? {
          bg: 'rgb(var(--success) / 0.12)',
          fg: 'rgb(var(--success))',
          label: confirmation.matchedBy === 'ip' ? 'приложение работает · по этому IP' : 'приложение работает · подтверждено',
          emojiBg: 'transparent',
        }
      : {
          bg: 'rgb(var(--danger) / 0.1)',
          fg: 'rgb(var(--danger))',
          label: confirmation.matchedBy === 'ip' ? 'приложение не работает · по этому IP' : 'приложение не работает · ваш отзыв',
          emojiBg: 'transparent',
        };
  }
  if (!r) {
    return {
      bg: 'var(--surface-2)',
      fg: 'var(--text-muted)',
      label: 'не проверялся',
      emojiBg: 'transparent',
    };
  }
  if (r.access_scope === 'provider_region_ru') {
    return {
      bg: 'rgb(var(--danger) / 0.08)',
      fg: 'rgb(var(--danger))',
      label: 'ограничено сервисом в RU',
      emojiBg: 'transparent',
    };
  }
  if (r.access_scope === 'app_unconfirmed') {
    return {
      bg: 'rgb(var(--warning) / 0.08)',
      fg: 'rgb(var(--warning))',
      label: 'приложение не подтверждено',
      emojiBg: 'transparent',
    };
  }
  if (r.intercepted) {
    return {
      bg: 'rgb(var(--warning) / 0.1)',
      fg: 'rgb(var(--warning))',
      label: 'ответ не распознан',
      emojiBg: 'transparent',
    };
  }
  if (r.access_scope === 'web_only') {
    return {
      bg: 'rgb(var(--warning) / 0.07)',
      fg: 'rgb(var(--warning))',
      label: r.status === 'slow' ? 'сайт медленный · приложение?' : 'страница открыта · приложение?',
      emojiBg: 'transparent',
    };
  }
  if (r.status === 'blocked') {
    return {
      bg: 'rgb(var(--danger) / 0.1)',
      fg: 'rgb(var(--danger))',
      label: 'не открыт',
      emojiBg: 'transparent',
    };
  }
  if (!r.proof || r.proof === 'endpoint' || r.proof === 'opaque') {
    return {
      bg: 'rgb(var(--warning) / 0.08)',
      fg: 'rgb(var(--warning))',
      label: !r.proof || r.proof === 'opaque'
        ? 'ответ без проверки'
        : r.status === 'slow' ? 'адрес отвечает медленно' : 'только адрес отвечает',
      emojiBg: 'transparent',
    };
  }
  if (r.status === 'slow') {
    return {
      bg: 'rgb(var(--warning) / 0.1)',
      fg: 'rgb(var(--warning))',
      label: 'страница открыта медленно',
      emojiBg: 'transparent',
    };
  }
  return {
    bg: 'rgb(var(--success) / 0.09)',
    fg: 'rgb(var(--success))',
    label: 'страница открыта',
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
  connection,
  profiles,
  confirmations,
  onConfirmationSaved,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>(loadQuickOrder);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ pick: QuickPick; result?: ScanSiteResult } | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [openingApp, setOpeningApp] = useState(false);
  const [savingConfirmation, setSavingConfirmation] = useState(false);

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

  const added = useMemo(() => {
    const rank = new Map(order.map((id, index) => [id, index]));
    return QUICK_PICKS.map((pick) => ({ pick, site: findQuickValue(byDomain, pick) }))
      .filter((x): x is { pick: QuickPick; site: Site } => Boolean(x.site))
      .sort((a, b) => {
        const ar = rank.get(a.pick.id) ?? Number.MAX_SAFE_INTEGER;
        const br = rank.get(b.pick.id) ?? Number.MAX_SAFE_INTEGER;
        return ar - br || QUICK_PICKS.indexOf(a.pick) - QUICK_PICKS.indexOf(b.pick);
      });
  }, [byDomain, order]);

  const notAdded = useMemo(
    () => QUICK_PICKS.filter((pick) => !findQuickValue(byDomain, pick)),
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

  useEffect(() => {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(order));
    } catch {
      // приватный режим
    }
  }, [order]);

  const reorder = (sourceId: string, targetId: string) => {
    if (!sourceId || sourceId === targetId) return;
    setOrder(() => {
      const ids = added.map((a) => a.pick.id);
      const from = ids.indexOf(sourceId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) return ids;
      ids.splice(from, 1);
      ids.splice(to, 0, sourceId);
      return ids;
    });
  };

  const moveBy = (id: string, delta: number) => {
    const ids = added.map((a) => a.pick.id);
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + delta));
    if (from >= 0 && from !== to) reorder(id, ids[to]);
  };

  /* ---------- TCP-пинг игровых серверов ---------- */
  const [gamePing, setGamePing] = useState<Record<string, { ok: boolean; ms: number | null; unsupported?: boolean }>>({});
  const gameIds = added.filter((a) => a.pick.gameHost).map((a) => a.pick.id).join(',');

  useEffect(() => {
    if (!gameIds) return;
    let alive = true;
    added
      .filter((a) => a.pick.gameHost)
      .forEach(async ({ pick }) => {
        if (!isNativeApp()) {
          if (alive) {
            setGamePing((prev) => ({
              ...prev,
              [pick.id]: { ok: false, ms: null, unsupported: true },
            }));
          }
          return;
        }
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

  const vpnActive = Boolean(connection?.vpn_detected && connection.vpn_source === 'system');
  const activeProfile = vpnActive ? profiles.find((profile) => Boolean(profile.is_primary)) || null : null;
  const activeIp = connection?.ip && connection.ip !== '—' ? connection.ip : '';
  const matchFor = (pick: QuickPick, profile = activeProfile) =>
    findAppConfirmation(confirmations, pick.id, profile, activeIp);

  const openDetails = (pick: QuickPick, result?: ScanSiteResult) => {
    setSelected({ pick, result });
    setSelectedProfileId(activeProfile?.id ?? null);
    setAwaitingConfirmation(false);
  };

  const selectedProfile = selectedProfileId == null
    ? null
    : profiles.find((profile) => profile.id === selectedProfileId) || null;
  const selectedMatch = selected ? matchFor(selected.pick, selectedProfile) : null;

  const handleOpenApp = async (pick: QuickPick) => {
    if (!pick.packageNames?.length) return;
    if (!isNativeApp()) {
      showToast('info', 'Запуск установленных приложений доступен в Android APK');
      return;
    }
    setOpeningApp(true);
    try {
      const result = await launchInstalledApp(pick.packageNames);
      if (!result.opened) {
        showToast('warning', `${pick.name} не найден среди установленных приложений`);
        return;
      }
      setAwaitingConfirmation(true);
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : 'Не удалось открыть приложение');
    } finally {
      setOpeningApp(false);
    }
  };

  const saveConfirmation = async (works: boolean) => {
    if (!selected) return;
    setSavingConfirmation(true);
    try {
      const response = await apiFetch<{ confirmation: AppConfirmation }>('/api/app-confirmations', {
        method: 'POST',
        body: JSON.stringify({
          service_id: selected.pick.id,
          domain: selected.pick.domain,
          node_key: confirmationNodeKey(selectedProfile),
          profile_id: selectedProfile?.id ?? null,
          profile_name: selectedProfile?.name || 'Прямое подключение',
          exit_ip: activeIp,
          works,
        }),
      });
      onConfirmationSaved(response.confirmation);
      setAwaitingConfirmation(false);
      showToast(
        works ? 'success' : 'warning',
        `${selected.pick.name}: результат сохранён для ${selectedProfile?.name || 'прямого подключения'}`
      );
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : 'Не удалось сохранить подтверждение');
    } finally {
      setSavingConfirmation(false);
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
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {added.map(({ pick, site }) => {
            const r = findQuickValue(resultByDomain, pick);
            const v = statusVisual(r, scanning, matchFor(pick));
            const game = gamePing[pick.id];
            return (
              <div
                key={pick.id}
                data-quick-id={pick.id}
                className="relative min-w-0 rounded-2xl border p-2.5 transition-opacity"
                style={{ borderColor: 'var(--line)', background: v.bg, opacity: draggingId === pick.id ? 0.55 : 1 }}
              >
                <div className="flex items-center justify-between gap-1">
                  <BrandBadge id={pick.id} size={30} />
                  <div className="flex items-center -mr-1">
                    <button
                      type="button"
                      className="p-1.5 rounded-full text-muted tap cursor-grab active:cursor-grabbing"
                      style={{ touchAction: 'none' }}
                      aria-label={`Переместить ${pick.name}. Стрелки также меняют порядок`}
                      title="Перетащите карточку на новое место"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setDraggingId(pick.id);
                      }}
                      onPointerMove={(e) => {
                        if (draggingId !== pick.id) return;
                        const target = document
                          .elementFromPoint(e.clientX, e.clientY)
                          ?.closest<HTMLElement>('[data-quick-id]')
                          ?.dataset.quickId;
                        if (target) reorder(pick.id, target);
                      }}
                      onPointerUp={(e) => {
                        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        }
                        setDraggingId(null);
                      }}
                      onPointerCancel={() => setDraggingId(null)}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                          e.preventDefault();
                          moveBy(pick.id, e.key === 'ArrowUp' ? -2 : -1);
                        }
                        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                          e.preventDefault();
                          moveBy(pick.id, e.key === 'ArrowDown' ? 2 : 1);
                        }
                      }}
                    >
                      <GripVertical className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(pick, site)}
                      disabled={busy === pick.id}
                      className="p-1.5 rounded-full text-muted hover:text-[rgb(var(--danger))] tap"
                      aria-label={`Убрать ${pick.name}`}
                    >
                      {busy === pick.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <X className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => openDetails(pick, r)}
                  className="mt-2 flex items-center gap-1 max-w-full text-left tap"
                  aria-label={`Подробнее о проверке ${pick.name}`}
                >
                  <span className="text-[12px] font-bold truncate pr-1">{pick.name}</span>
                  <Info className="w-3 h-3 shrink-0 text-muted" />
                </button>

                <div className="mt-1 flex items-start gap-1.5">
                  <span
                    className="mt-1 w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: v.fg, opacity: scanning ? 0.5 : 1 }}
                  />
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => openDetails(pick, r)}
                      className="block text-left text-[10.5px] leading-tight font-semibold break-words tap"
                      style={{ color: v.fg }}
                    >
                      {v.label}
                    </button>
                    {r?.latency_ms != null && (
                      <span className="block mt-0.5 text-[10px] font-mono text-muted tabular-nums">
                        {r.latency_ms} мс
                      </span>
                    )}
                  </div>
                </div>

                {pick.gameHost && !scanning && (
                  <div className="mt-1 text-[9px] font-semibold text-muted truncate">
                    {game
                      ? game.unsupported
                        ? 'игровой TCP — только в APK'
                        : game.ok
                        ? `игра TCP ${game.ms != null && game.ms < 1 ? '<1' : game.ms} мс`
                        : 'игровой TCP не проходит'
                      : 'игровой сервер…'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {added.length > 0 && (
        <p className="mt-2 text-[10px] leading-snug text-muted">
          Нажмите на карточку: можно открыть приложение и подтвердить его работу. Результат
          запоминается для выбранного VPN-узла и внешнего IP и используется в рекомендациях.
        </p>
      )}

      {/* ---------- Что именно доказала проверка ---------- */}
      <Sheet
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected?.pick.name || 'Проверка сервиса'}
        subtitle="Сайт и приложение — не одно и то же"
        size="sm"
        icon={<Info className="w-5 h-5" style={{ color: 'rgb(var(--accent))' }} />}
      >
        {selected && (
          <div className="space-y-3">
            <div
              className="rounded-2xl border p-3.5"
              style={{ borderColor: 'var(--line)', background: statusVisual(selected.result, scanning, selectedMatch).bg }}
            >
              <div className="text-[14px] font-extrabold" style={{ color: statusVisual(selected.result, scanning, selectedMatch).fg }}>
                {statusVisual(selected.result, scanning, selectedMatch).label}
              </div>
              <div className="text-[11px] font-mono text-muted mt-1">{selected.pick.domain}</div>
            </div>
            <p className="text-[12.5px] leading-relaxed text-dim">
              {selected.result?.note || selected.pick.caveat || selected.pick.hint}
            </p>
            {selected.result?.intercepted && (
              <Notice tone="warn">
                «Ответ не распознан» означает неожиданный HTML, антибот-проверку или заглушку.
                Это не доказательство взлома и не достоверный вердикт о приложении.
              </Notice>
            )}
            <div className="rounded-2xl border p-3 space-y-2.5" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
              <div className="text-[12px] font-bold">Проверить именно приложение</div>
              {vpnActive && profiles.length > 0 ? (
                <label className="block text-[11px] text-dim">
                  Узел, который сейчас включён в VPN-клиенте
                  <select
                    value={selectedProfileId ?? ''}
                    onChange={(event) => setSelectedProfileId(event.target.value ? Number(event.target.value) : null)}
                    className="mt-1.5 w-full rounded-xl border px-3 py-2 text-[12px] outline-none"
                    style={{ borderColor: 'var(--line)', background: 'var(--surface)', color: 'var(--text)' }}
                  >
                    <option value="">Не указан / прямой маршрут</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profile.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="text-[11px] text-dim">Маршрут: прямое подключение{activeIp ? ` · IP ${activeIp}` : ''}</div>
              )}
              {selectedMatch && (
                <Notice tone={selectedMatch.confirmation.works ? 'ok' : 'bad'}>
                  {selectedMatch.confirmation.works ? 'Вы подтвердили: приложение работает.' : 'Вы отметили: приложение не работает.'}
                  {' '}{selectedMatch.matchedBy === 'ip' ? 'Совпадение найдено по внешнему IP, не по названию узла. ' : ''}
                  {selectedMatch.confirmation.profile_name} · {new Date(selectedMatch.confirmation.confirmed_at).toLocaleString('ru-RU')}
                </Notice>
              )}
              {awaitingConfirmation && (
                <Notice tone="info">
                  Приложение открыто. Вернитесь после проверки входа, сообщения, видео или игры и отметьте фактический результат.
                </Notice>
              )}
              {selected.pick.packageNames && (
                <Button
                  variant="soft"
                  block
                  loading={openingApp}
                  icon={<Smartphone className="w-4 h-4" />}
                  onClick={() => void handleOpenApp(selected.pick)}
                >
                  Открыть приложение
                </Button>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="primary"
                  disabled={savingConfirmation}
                  icon={<ThumbsUp className="w-4 h-4" />}
                  onClick={() => void saveConfirmation(true)}
                >
                  Работает
                </Button>
                <Button
                  variant="outline"
                  disabled={savingConfirmation}
                  icon={<ThumbsDown className="w-4 h-4" />}
                  onClick={() => void saveConfirmation(false)}
                >
                  Не работает
                </Button>
              </div>
              <p className="text-[10px] leading-snug text-muted">
                Это ваше ручное подтверждение, а не автоматический тест аккаунта. Его можно изменить после следующей проверки.
              </p>
            </div>
            <Notice tone="info">
              Сетевая проба проверяет сайт отдельно. Запуск приложения сам по себе не доказывает
              работу входа, сообщений, звонков или видео — поэтому итог подтверждаете вы.
            </Notice>
            {selected.result?.source_url && (
              <a
                href={selected.result.source_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-[12px] font-bold tap"
                style={{ borderColor: 'rgb(var(--accent) / 0.35)', color: 'rgb(var(--accent))' }}
              >
                Официальный источник <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
            <Button variant="primary" block onClick={() => setSelected(null)}>Понятно</Button>
          </div>
        )}
      </Sheet>

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
