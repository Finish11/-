import type { AppConfirmation, VpnProfile } from '../types';

export interface ConfirmationMatch {
  confirmation: AppConfirmation;
  matchedBy: 'node_ip' | 'node' | 'ip';
  /** Отзыв оставлен на этом узле, но выходной IP с тех пор изменился. */
  ipChanged?: boolean;
}

/** Блокировки меняются каждый день: отзыв не может держать узел зелёным вечно. */
export const CONFIRMATION_FRESH_DAYS = 7;
export const CONFIRMATION_STALE_DAYS = 30;

export type ConfirmationFreshness = 'fresh' | 'aging' | 'stale' | 'unknown';

const DAY_MS = 86_400_000;

export function confirmationAgeDays(confirmedAt: string | null | undefined, now = Date.now()): number | null {
  if (!confirmedAt) return null;
  const at = Date.parse(confirmedAt);
  if (!Number.isFinite(at)) return null;
  // Часы устройства могут отставать: будущее считаем «сейчас», а не минусом.
  return Math.max(0, (now - at) / DAY_MS);
}

export function confirmationFreshness(confirmedAt: string | null | undefined, now = Date.now()): ConfirmationFreshness {
  const days = confirmationAgeDays(confirmedAt, now);
  if (days == null) return 'unknown';
  if (days <= CONFIRMATION_FRESH_DAYS) return 'fresh';
  return days <= CONFIRMATION_STALE_DAYS ? 'aging' : 'stale';
}

/** Вес отзыва в рейтинге: свежий решает, старый только подсказывает. */
export function confirmationWeight(confirmedAt: string | null | undefined, now = Date.now()): number {
  const freshness = confirmationFreshness(confirmedAt, now);
  if (freshness === 'fresh') return 1;
  if (freshness === 'aging') return 0.6;
  if (freshness === 'stale') return 0.25;
  return 0.5;
}

export function confirmationAgeLabel(confirmedAt: string | null | undefined, now = Date.now()): string {
  const days = confirmationAgeDays(confirmedAt, now);
  if (days == null) return 'дата отзыва неизвестна';
  if (days < 1) return 'подтверждено сегодня';
  const whole = Math.floor(days);
  if (whole === 1) return 'подтверждено вчера';
  if (whole < 30) return `подтверждено ${whole} дн. назад`;
  const months = Math.floor(whole / 30);
  return `подтверждено больше ${months === 1 ? 'месяца' : `${months} месяцев`} назад`;
}

export function confirmationNodeKey(profile: Pick<VpnProfile, 'id'> | null): string {
  return profile ? `vpn:${profile.id}` : 'direct';
}

const cleanIp = (ip: string | null | undefined): string =>
  ip && ip !== '—' ? ip.trim().toLowerCase() : '';

const newest = (items: AppConfirmation[]): AppConfirmation | undefined =>
  [...items].sort((a, b) => b.confirmed_at.localeCompare(a.confirmed_at))[0];

/**
 * Ручной результат привязан к узлу и внешнему IP. Если другой узел выдаёт тот
 * же IP, подтверждение можно показать как совпадение по IP — но не приписывать
 * этому узлу отдельный голос в рейтинге.
 */
export function findAppConfirmation(
  confirmations: AppConfirmation[],
  serviceId: string,
  profile: Pick<VpnProfile, 'id'> | null,
  exitIp: string | null | undefined
): ConfirmationMatch | null {
  const ip = cleanIp(exitIp);
  const nodeKey = confirmationNodeKey(profile);
  const service = confirmations.filter((item) => item.service_id === serviceId);
  const exact = newest(service.filter((item) => item.node_key === nodeKey && cleanIp(item.exit_ip) === ip));
  if (exact) return { confirmation: exact, matchedBy: 'node_ip' };

  // Узел выбрал сам пользователь — это его утверждение о маршруте. Многие
  // VPN-провайдеры меняют выходной IP при каждом подключении, поэтому отзыв не
  // должен исчезать из карточки только из-за смены адреса.
  if (profile) {
    const byNode = newest(service.filter((item) => item.node_key === nodeKey && item.profile_id === profile.id));
    if (byNode) return { confirmation: byNode, matchedBy: 'node', ipChanged: Boolean(ip) && cleanIp(byNode.exit_ip) !== ip };
  }

  // Для прямого подключения не переносим отзыв с VPN даже при совпадении IP.
  if (!profile || !ip) return null;
  const byIp = newest(service.filter((item) => item.profile_id != null && cleanIp(item.exit_ip) === ip));
  return byIp ? { confirmation: byIp, matchedBy: 'ip' } : null;
}

export type ConfirmationTone = 'ok' | 'warn' | 'bad';

export interface ConfirmationStatus {
  tone: ConfirmationTone;
  label: string;
  /** Отзыв больше не описывает текущий маршрут — нужна перепроверка. */
  recheck: boolean;
  reason: string;
}

/**
 * Что показывать в карточке приложения.
 *
 * Раньше смена выходного IP никак не меняла карточку: отзыв находился «по узлу»
 * и продолжал светиться зелёным, хотя в VPN-клиенте человек уже переключил узел.
 * Теперь смена выхода — это отдельное состояние «перепроверьте», а не прежний
 * зелёный статус.
 */
export function confirmationStatus(match: ConfirmationMatch, now = Date.now()): ConfirmationStatus {
  const { confirmation, matchedBy, ipChanged } = match;
  const freshness = confirmationFreshness(confirmation.confirmed_at, now);
  if (matchedBy === 'ip') {
    return {
      tone: 'warn', recheck: true,
      label: 'отзыв другого узла с тем же IP',
      reason: 'Отзыв оставлен на другом узле, совпал только внешний IP. Выберите свой узел и перепроверьте приложение.',
    };
  }
  if (ipChanged) {
    return {
      tone: 'warn', recheck: true,
      label: confirmation.works ? 'работало · выход сменился, перепроверьте' : 'не работало · выход сменился',
      reason: `Отзыв оставлен на выходном IP ${confirmation.exit_ip || 'неизвестном'}, сейчас выход другой. В VPN-клиенте, вероятно, включён другой узел — отметьте результат заново.`,
    };
  }
  if (confirmation.works && freshness === 'stale') {
    return {
      tone: 'warn', recheck: true,
      label: 'приложение работало · отзыв давний',
      reason: 'Блокировки меняются: отзыв старше месяца ничего не гарантирует.',
    };
  }
  if (!confirmation.works) {
    return { tone: 'bad', recheck: false, label: 'приложение не работает · ваш отзыв', reason: '' };
  }
  return {
    tone: 'ok', recheck: false,
    label: freshness === 'aging'
      ? `приложение работает · ${confirmationAgeLabel(confirmation.confirmed_at, now)}`
      : 'приложение работает · подтверждено',
    reason: '',
  };
}

export interface RouteChange {
  fromIp: string;
  toIp: string;
  /** VPN-клиент тот же — значит внутри клиента сменился узел, а не приложение. */
  sameClient: boolean;
}

/**
 * Смена выходного IP при том же VPN-клиенте. Android не раскрывает чужой конфиг,
 * поэтому это единственный честный признак, что человек переключил узел.
 *
 * Выключение VPN — не «смена узла»: это возврат на прямой маршрут. Раньше такой
 * случай попадал в тот же детектор, и человек, выключив VPN, видел устрашающее
 * «выход сменился» вместо честного «снова напрямую».
 */
export function detectExitChange(
  before: { ip?: string; vpnPackage?: string } | null | undefined,
  after: { ip?: string; vpnPackage?: string } | null | undefined
): RouteChange | null {
  const from = cleanIp(before?.ip);
  const to = cleanIp(after?.ip);
  if (!from || !to || from === to) return null;
  const beforeClient = (before?.vpnPackage || '').trim();
  const afterClient = (after?.vpnPackage || '').trim();
  // Клиент исчез или появился: маршрут сменился целиком, это не переключение
  // узла внутри одного клиента. Такое состояние показываем отдельно.
  if (!beforeClient !== !afterClient) return null;
  return { fromIp: from, toIp: to, sameClient: beforeClient === afterClient };
}

export type RouteTransition = 'node_switched' | 'vpn_off' | 'vpn_on' | 'network_switched' | null;

/**
 * Что именно произошло с маршрутом. Нужен, чтобы не показывать один и тот же
 * текст на три разных события: смену узла, выключение VPN и смену сети.
 */
export function routeTransition(
  before: { ip?: string; vpnPackage?: string } | null | undefined,
  after: { ip?: string; vpnPackage?: string } | null | undefined
): RouteTransition {
  const from = cleanIp(before?.ip);
  const to = cleanIp(after?.ip);
  if (!from || !to || from === to) return null;
  const hadVpn = Boolean((before?.vpnPackage || '').trim());
  const hasVpn = Boolean((after?.vpnPackage || '').trim());
  if (hadVpn && !hasVpn) return 'vpn_off';
  if (!hadVpn && hasVpn) return 'vpn_on';
  return hadVpn ? 'node_switched' : 'network_switched';
}

/**
 * Узел, который хранится в настройках маршрута, больше не отражает реальность.
 *
 * Пользователь выключил VPN, а приложение продолжало считать выбранным узел
 * «NLAMS Основной» — и отзыв, оставленный на прямом подключении, не находился.
 * Возврат на прямой маршрут обязан происходить сам.
 */
export function routeSelectionMismatch(
  selectedProfileId: number | null,
  facts: { vpnPackage?: string; systemVpn: boolean; nativeApp: boolean },
): boolean {
  if (selectedProfileId == null) return false;
  // В браузере VPN системы не видно: выбор пользователя не перепроверяем.
  if (!facts.nativeApp) return false;
  // VPN-клиент включён — узел остаётся выбором человека, даже если IP сменился.
  return !facts.systemVpn;
}

/** Отпечаток маршрута: клиент + выходной IP. По нему запоминаем выбранный узел. */
export function routeFingerprint(vpnPackage: string | undefined, exitIp: string | null | undefined): string {
  const pkg = (vpnPackage || '').trim().toLowerCase();
  const ip = cleanIp(exitIp);
  return pkg && ip ? `${pkg}|${ip}` : '';
}

export interface NodeSuggestion {
  profile: VpnProfile;
  source: 'remembered' | 'server_ip';
  reason: string;
}

/**
 * Автоопределение активного узла. Android не раскрывает чужой конфиг, поэтому
 * используем два честных признака: прошлый выбор пользователя для этой пары
 * «клиент + IP» и совпадение выходного IP с адресом сервера узла.
 */
export function suggestActiveNode(
  profiles: VpnProfile[],
  facts: { vpnPackage?: string; exitIp?: string; remembered?: Record<string, number> },
): NodeSuggestion | null {
  const fingerprint = routeFingerprint(facts.vpnPackage, facts.exitIp);
  if (fingerprint && facts.remembered) {
    const id = facts.remembered[fingerprint];
    const profile = profiles.find((item) => item.id === id);
    if (profile) return { profile, source: 'remembered', reason: 'Вы выбирали этот узел для того же клиента и IP' };
  }
  const ip = cleanIp(facts.exitIp);
  if (!ip) return null;
  const byServer = profiles.find((profile) => cleanIp(profile.server_ip) === ip);
  if (byServer) return { profile: byServer, source: 'server_ip',
    reason: `Выходной IP совпадает с адресом сервера «${byServer.name}». Это признак, а не доказательство: сверьте имя в клиенте.` };
  return null;
}

export interface ConfirmedNodeRecommendation {
  profile: VpnProfile;
  works: number;
  failures: number;
  score: number;
  /** Сколько отзывов свежее недели — старые не должны выглядеть как гарантия. */
  freshWorks: number;
}

/** Рейтинг использует только отзывы, оставленные непосредственно для этого узла. */
export function recommendConfirmedNodes(
  profiles: VpnProfile[],
  confirmations: AppConfirmation[],
  now: number = Date.now()
): ConfirmedNodeRecommendation[] {
  return profiles.map((profile) => {
    const own = confirmations.filter((item) =>
      item.profile_id === profile.id && item.node_key === confirmationNodeKey(profile)
    );
    // Один сервис = один последний отзыв, старые IP не завышают рейтинг.
    const latestByService = new Map<string, AppConfirmation>();
    for (const item of [...own].sort((a, b) => a.confirmed_at.localeCompare(b.confirmed_at))) {
      latestByService.set(item.service_id, item);
    }
    const latest = [...latestByService.values()];
    const works = latest.filter((item) => item.works).length;
    const failures = latest.length - works;
    const weightedWorks = latest.filter((item) => item.works)
      .reduce((sum, item) => sum + confirmationWeight(item.confirmed_at, now), 0);
    const weightedFailures = latest.filter((item) => !item.works)
      .reduce((sum, item) => sum + confirmationWeight(item.confirmed_at, now), 0);
    const freshWorks = latest.filter((item) => item.works
      && confirmationFreshness(item.confirmed_at, now) === 'fresh').length;
    const comparable = profile.latency_kind === 'tcp_connect' && profile.latency_route === 'direct'
      && profile.latency_trusted === true && profile.latency_ms != null && Number.isFinite(profile.latency_ms);
    const latency = comparable ? Math.max(0, profile.latency_ms!) : 600;
    const statusScore = profile.status === 'online' ? 20 : profile.status === 'blocked' ? -100 : 0;
    const score = Math.round(weightedWorks * 110 - weightedFailures * 90
      + (weightedWorks / Math.max(1, latest.length)) * 40 - Math.min(latency, 1200) / 25 + statusScore);
    return { profile, works, failures, score, freshWorks };
  })
    .filter((item) => item.works > 0)
    .sort((a, b) =>
      b.works - a.works ||
      b.freshWorks - a.freshWorks ||
      a.failures - b.failures ||
      b.score - a.score ||
      (a.profile.latency_trusted ? a.profile.latency_ms ?? Infinity : Infinity) - (b.profile.latency_trusted ? b.profile.latency_ms ?? Infinity : Infinity)
    );
}

/** Совпадают системный маршрут, свежий IP, выбранный узел и VPN-клиент. */
export function confirmationRouteStillValid(
  before: { networkKey: string; exitIp: string; nodeKey: string; vpnPackage?: string },
  after: { networkKey: string; exitIp: string; nodeKey: string; vpnPackage?: string }
): boolean {
  return Boolean(after.exitIp) && before.networkKey === after.networkKey
    && before.exitIp === after.exitIp && before.nodeKey === after.nodeKey
    && (before.vpnPackage || '') === (after.vpnPackage || '');
}

/**
 * Значимая часть маршрута для отзыва: транспорт, VPN, клиент и выходной IP.
 * Системный sequence меняется при любом переподтверждении сети (например, когда
 * открывается другое приложение), и сам по себе не означает смену маршрута.
 */
export function routeIdentity(networkKey: string): string {
  const parts = networkKey.split('|');
  // networkSnapshotKey: connected|kind|vpn|package[|sequence]
  return parts.length >= 4 ? parts.slice(0, 4).join('|') : networkKey;
}
