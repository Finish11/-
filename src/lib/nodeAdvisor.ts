import type { ScanRecord, VpnProfile } from '../types';

/**
 * Подбор узла под результат замера.
 *
 * Идея простая и честная: у нас нет туннеля, поэтому мы не можем «переключиться
 * и проверить». Зато мы знаем, что именно не открылось, и знаем тип протокола
 * каждого узла — а разные протоколы по-разному проходят конкретные фильтры:
 *
 *  - подмена TLS на нейтральных сайтах  → нужен Reality / Trojan (маскировка под чужой TLS)
 *  - сайты РФ не открываются вовсе      → скорее всего нужен каскад через РФ (whitelist_bypass)
 *  - медленно, но открывается           → Hysteria2 / QUIC-протоколы (меньше страдают от шейпинга)
 *  - порт 443 занят фильтром            → узлы на нестандартных портах
 *
 * Итог: список из 3 узлов с оценкой и человеческим объяснением «почему он».
 */

export interface NodeRecommendation {
  profile: VpnProfile;
  /** 0..100 — насколько узел подходит именно этой проблеме */
  score: number;
  /** Короткое «почему» */
  why: string;
}

export type ProblemKind =
  | 'white_list' // белые списки: работает только Рунет
  | 'dpi_tls' // фильтрация/подмена TLS
  | 'throttle' // замедление
  | 'cdn_block' // недоступны CDN/дата-центры
  | 'no_problem'; // всё открыто — рекомендация не нужна

const PROTO_WEIGHT: Record<string, { weight: number; note: string }> = {
  reality: { weight: 34, note: 'Reality маскирует TLS под чужой сайт — его сложнее распознать' },
  'vless + reality': { weight: 34, note: 'Reality маскирует TLS под чужой сайт' },
  trojan: { weight: 24, note: 'Trojan выглядит как обычный HTTPS' },
  'trojan-grpc': { weight: 24, note: 'Trojan поверх gRPC хорошо проходит фильтры' },
  hysteria2: { weight: 20, note: 'Hysteria2 работает по QUIC — меньше страдает от шейпинга' },
  tuic: { weight: 18, note: 'TUIC на QUIC обходит часть ограничений скорости' },
  'tuic v5': { weight: 18, note: 'TUIC на QUIC обходит часть ограничений скорости' },
  amneziawg: { weight: 16, note: 'AmneziaWG — WireGuard с обфускацией' },
  shadowsocks: { weight: 8, note: 'Shadowsocks работает, но без маскировки TLS' },
  'shadowsocks-2022': { weight: 10, note: 'Shadowsocks-2022 устойчивее к детекту' },
  vmess: { weight: 8, note: 'VMess без маскировки чаще замечают' },
  wireguard: { weight: 2, note: 'Чистый WireGuard легко определяется' },
  openvpn: { weight: 0, note: 'OpenVPN часто блокируется по сигнатурам' },
};

const protocolScore = (profile: VpnProfile): { weight: number; note: string } => {
  const key = (profile.protocol || '').toLowerCase();
  const exact = PROTO_WEIGHT[key];
  if (exact) return exact;
  const partial = Object.entries(PROTO_WEIGHT).find(([k]) => key.includes(k));
  return partial ? partial[1] : { weight: 6, note: 'Обычный протокол без маскировки' };
};

/** Русское имя протокола для списка рекомендаций. */
function protocolLabel(profile: VpnProfile): string {
  const key = (profile.protocol || '').toLowerCase();
  if (key.includes('reality')) return 'Reality';
  if (key.includes('trojan')) return 'Trojan';
  if (key.includes('hysteria')) return 'Hysteria2';
  if (key.includes('tuic')) return 'TUIC';
  if (key.includes('amnezia')) return 'AmneziaWG';
  if (key.includes('shadow')) return 'Shadowsocks';
  if (key.includes('vmess')) return 'VMess';
  if (key.includes('wireguard')) return 'WireGuard';
  if (key.includes('openvpn')) return 'OpenVPN';
  return 'VLESS';
}

/** Сеть/провайдер в одну строку: «селектел.ру · Reality». */
const shortHost = (profile: VpnProfile): string =>
  (profile.host || '').replace(/^www\./, '').slice(0, 22);

export function nodeSubtitle(profile: VpnProfile): string {
  const parts = [shortHost(profile), protocolLabel(profile)].filter(Boolean);
  if (profile.whitelist_bypass) parts.push('рос. вход');
  return parts.join(' · ');
}

/** Бедные данные подписки: и хост, и страна, и пинг одинаковые у всех. */
export function looksSynthetic(profiles: VpnProfile[]): boolean {
  if (profiles.length < 3) return false;
  const uniq = (pick: (p: VpnProfile) => string) => new Set(profiles.map(pick)).size;
  const hosts = uniq((p) => p.host || '');
  const lat = uniq((p) => String(p.latency_ms ?? ''));
  return hosts <= 1 || lat <= 1;
}

/** Что именно случилось в замере — по процентам и статусам. */
export function detectProblem(scan: ScanRecord): ProblemKind {
  const intercepted = (scan.results || []).filter((r) => (r as { intercepted?: boolean }).intercepted).length;
  const blockedNeutral = (scan.results || []).filter(
    (r) => r.marker_role === 'global_neutral' && r.status === 'blocked'
  ).length;
  const ruBad = scan.ru_ok_pct < 50;

  if (scan.verdict === 'WHITELIST_ACTIVE' || (ruBad && blockedNeutral > 0)) return 'white_list';
  if (intercepted > 0) return 'dpi_tls';
  if (scan.verdict === 'DPI_THROTTLING') return 'throttle';
  if (scan.verdict === 'SEVERE_RESTRICTIONS' || blockedNeutral >= 3) return 'cdn_block';
  if (scan.verdict === 'OPEN_INTERNET') return 'no_problem';
  return 'dpi_tls';
}

export const PROBLEM_TEXT: Record<ProblemKind, { title: string; hint: string }> = {
  white_list: {
    title: 'Включены белые списки',
    hint: 'Зарубежные адреса не открываются вовсе. Помогает каскад через российский сервер или Reality-узел с российским входом.',
  },
  dpi_tls: {
    title: 'Фильтрация TLS',
    hint: 'Соединение подменяется или сбрасывается. Нужен протокол с маскировкой: Reality или Trojan.',
  },
  throttle: {
    title: 'Замедление',
    hint: 'Сайты открываются, но медленно. Лучше подходят QUIC-протоколы (Hysteria2, TUIC).',
  },
  cdn_block: {
    title: 'Недоступны CDN и дата-центры',
    hint: 'Режутся подсети крупных провайдеров. Помогают узлы на нестандартных портах и Reality.',
  },
  no_problem: {
    title: 'Ограничений не видно',
    hint: 'Всё открывается напрямую — VPN для проверки не нужен.',
  },
};

export function recommendNodes(
  scan: ScanRecord | null,
  profiles: VpnProfile[],
  limit = 3
): NodeRecommendation[] {
  if (!profiles.length) return [];
  const problem = scan ? detectProblem(scan) : 'dpi_tls';
  if (problem === 'no_problem') return [];

  // Максимум, который узел может набрать для этой проблемы — для нормировки
  const cap =
    problem === 'white_list'
      ? 30 + 30 + 6 + 26 + 18 + 16 + 4 + 3
      : 30 + 34 + 18 + 16 + 4 + 3;

  const list = profiles.filter((p) => p.status !== 'blocked');
  if (!list.length) return [];

  const scored = list.map((profile) => {
    const proto = protocolScore(profile);
    let score = 30;
    const reasons: string[] = [];

    // Протокол под проблему
    if (problem === 'dpi_tls' || problem === 'cdn_block') score += proto.weight;
    else if (problem === 'throttle') {
      score += /hysteria|tuic|quic/i.test(profile.protocol) ? 34 : proto.weight / 2;
    } else if (problem === 'white_list') {
      score += profile.whitelist_bypass ? 30 : 6;
      if (/реаль|reality/i.test(profile.protocol)) score += 6;
      if (/russia|росси|ru-|каскад|whitelist/i.test(profile.name)) score += 26;
    }

    // Реальная доступность узла: замер важнее теории
    if (profile.status === 'online') score += 18;
    else if (profile.status === 'degraded') score += 4;
    if (profile.latency_ms != null) {
      if (profile.latency_ms < 80) score += 16;
      else if (profile.latency_ms < 150) score += 10;
      else if (profile.latency_ms < 300) score += 4;
      else score -= 6;
      reasons.push(`${profile.latency_ms} мс`);
    }
    if ((profile.uptime_pct ?? 0) >= 99) score += 4;

    // Основной узел — приятный бонус: он уже выбран пользователем
    if (profile.is_primary) score += 3;

    if (problem === 'white_list' && /russia|росси|ru-|каскад/i.test(profile.name)) {
      reasons.unshift('российский вход');
    }
    reasons.push(proto.note);

    // Потолок оценки зависит от типа проблемы: иначе у сильных узлов
    // все оценки упираются в 99 и разница между ними пропадает.
    const raw = Math.max(1, Math.min(cap, score));
    return {
      profile,
      score: Math.max(1, Math.min(99, Math.round((raw / cap) * 99))),
      why: reasons.filter(Boolean).slice(0, 2).join(' · '),
    };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
