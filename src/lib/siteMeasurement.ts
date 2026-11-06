import type { ScanSiteResult, Site } from '../types';
import type { SiteProbeResult } from './siteProbe';

/** Единая проекция HTTP-пробы для каталога, сканера и одиночной проверки. */
export function siteResultFromProbe(site: Site, probe: SiteProbeResult, checkedAt = new Date().toISOString()): ScanSiteResult {
  const answered = probe.httpStatus != null;
  const networkStatus = probe.networkStatus ?? (answered ? (probe.latencyMs != null && probe.latencyMs > 1500 ? 'slow' : 'ok') : 'blocked');
  return {
    site_id: site.id, name: site.name, domain: site.domain, category: site.category, marker_role: site.marker_role,
    status: probe.verdict === 'ok' || probe.verdict === 'slow' ? probe.verdict : 'blocked',
    latency_ms: probe.verdict === 'ok' || probe.verdict === 'slow' ? probe.latencyMs : null,
    network_status: networkStatus, network_latency_ms: networkStatus === 'blocked' ? null : probe.latencyMs,
    network_proof: probe.proof ?? 'opaque', network_note: probe.reason, http_status: probe.httpStatus,
    probe_url: probe.probeUrl, checked_at: checkedAt, proof: probe.proof ?? 'opaque',
    intercepted: probe.verdict === 'intercepted',
    block_reason: probe.verdict === 'intercepted' ? 'throttled' : probe.verdict === 'blocked' ? (answered ? 'unknown' : 'network') : undefined,
    note: probe.reason,
  };
}
export function siteMeasurementPatch(result: ScanSiteResult): Partial<Site> {
  return { last_status: result.network_status ?? result.status, last_latency_ms: result.network_latency_ms ?? result.latency_ms,
    last_checked_at: result.checked_at ?? new Date().toISOString(), last_proof: result.network_proof ?? result.proof,
    last_note: result.network_note ?? result.note, last_http_status: result.http_status ?? null, last_probe_url: result.probe_url };
}
/** Поздний ответ старого замера не перетирает более свежую ручную проверку. */
export function mergeSiteMeasurement(site: Site, result: ScanSiteResult): Site {
  const patch = siteMeasurementPatch(result);
  if (site.last_checked_at && patch.last_checked_at && Date.parse(site.last_checked_at) > Date.parse(patch.last_checked_at)) return site;
  return { ...site, ...patch };
}
export function siteStatusLabel(site: Pick<Site, 'last_status' | 'last_proof' | 'last_http_status'>): string {
  if (site.last_status === 'unknown' || site.last_status === 'checking') return 'не проверялся';
  if (site.last_http_status != null && site.last_http_status >= 400) return `адрес ответил · HTTP ${site.last_http_status}`;
  if (site.last_proof === 'opaque') return 'ответ адреса · содержимое не проверено';
  if (site.last_proof === 'endpoint') return 'адрес отвечает · не проверка приложения';
  if (site.last_status === 'blocked') return 'нет подтверждённого ответа';
  return site.last_status === 'slow' ? 'страница открыта медленно' : 'страница открыта';
}
export function siteResultIsStale(site: Pick<Site, 'last_checked_at'>, now = Date.now()): boolean {
  return !site.last_checked_at || !Number.isFinite(Date.parse(site.last_checked_at)) || now - Date.parse(site.last_checked_at) > 10 * 60_000;
}
