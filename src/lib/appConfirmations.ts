import type { AppConfirmation, VpnProfile } from '../types';

export interface ConfirmationMatch {
  confirmation: AppConfirmation;
  matchedBy: 'node_ip' | 'ip';
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

  // Для прямого подключения не переносим отзыв с VPN даже при совпадении IP.
  if (!profile || !ip) return null;
  const byIp = newest(service.filter((item) => item.profile_id != null && cleanIp(item.exit_ip) === ip));
  return byIp ? { confirmation: byIp, matchedBy: 'ip' } : null;
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
    const latency = profile.latency_ms != null && Number.isFinite(profile.latency_ms)
      ? Math.max(0, profile.latency_ms)
      : 600;
    const statusScore = profile.status === 'online' ? 20 : profile.status === 'blocked' ? -100 : 0;
    const score = Math.round(works * 110 - failures * 90 + (works / Math.max(1, latest.length)) * 40 - Math.min(latency, 1200) / 25 + statusScore);
    return { profile, works, failures, score };
  })
    .filter((item) => item.works > 0)
    .sort((a, b) =>
      b.works - a.works ||
      a.failures - b.failures ||
      b.score - a.score ||
      (a.profile.latency_ms ?? Infinity) - (b.profile.latency_ms ?? Infinity)
    );
}
