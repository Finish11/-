import type { AppConfirmation, VpnProfile } from '../types';

export interface ConfirmationMatch {
  confirmation: AppConfirmation;
  matchedBy: 'node_ip' | 'node' | 'ip';
  /** Отзыв оставлен на этом узле, но выходной IP с тех пор изменился. */
  ipChanged?: boolean;
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
}

/** Рейтинг использует только отзывы, оставленные непосредственно для этого узла. */
export function recommendConfirmedNodes(
  profiles: VpnProfile[],
  confirmations: AppConfirmation[]
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
    const comparable = profile.latency_kind === 'tcp_connect' && profile.latency_route === 'direct'
      && profile.latency_trusted === true && profile.latency_ms != null && Number.isFinite(profile.latency_ms);
    const latency = comparable ? Math.max(0, profile.latency_ms!) : 600;
    const statusScore = profile.status === 'online' ? 20 : profile.status === 'blocked' ? -100 : 0;
    const score = Math.round(works * 110 - failures * 90 + (works / Math.max(1, latest.length)) * 40 - Math.min(latency, 1200) / 25 + statusScore);
    return { profile, works, failures, score };
  })
    .filter((item) => item.works > 0)
    .sort((a, b) =>
      b.works - a.works ||
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
