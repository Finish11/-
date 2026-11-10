import LZString from 'lz-string'
import type { NetworkReport, ProbeResult, ReportStatus, SiteGroup, VpnNode } from './types'

export const STATUS_META: Record<ReportStatus, { label: string; tone: string }> = {
  stable: { label: 'Стабильно', tone: 'green' },
  partial: { label: 'Частичный доступ', tone: 'amber' },
  limited: { label: 'Мало ответов', tone: 'orange' },
  offline: { label: 'Почти нет ответов', tone: 'red' },
}

export function formatDate(date: string, withTime = false): string {
  const value = new Date(date)
  if (Number.isNaN(value.getTime())) return 'Дата не указана'
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: 'short', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }),
  }).format(value)
}

export function percentage(available: number, total: number): string {
  if (!total) return '0'
  return (available / total * 100).toLocaleString('ru-RU', { maximumFractionDigits: 1 })
}

export function downloadFile(filename: string, content: string, type = 'application/json'): void {
  const blob = new Blob([type.includes('csv') ? '\ufeff' + content : content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function exportReports(reports: NetworkReport[]): void {
  const quote = (value: unknown) => {
    let text = String(value ?? '')
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`
    return `"${text.replaceAll('"', '""')}"`
  }
  const rows = [['Отчёт', 'Дата', 'Регион', 'Оператор', 'Ответили', 'Всего', 'Отклик, мс', 'Источник', 'Примечание'],
    ...reports.map(r => [r.title, r.date, r.region, r.operator, r.available, r.total, r.latency, r.source, r.note])]
  downloadFile('pulsenet-reports.csv', rows.map(row => row.map(quote).join(';')).join('\r\n'), 'text/csv;charset=utf-8')
}

export function publicPayload(report: NetworkReport) {
  return {
    version: 1, id: report.id, title: report.title, date: report.date, region: report.region,
    operator: report.operator, status: report.status, total: report.total, available: report.available,
    slow: report.slow, latency: report.latency, note: report.note, vpn: report.vpn,
    groups: report.groups, results: report.results,
    demo: report.source === 'demo',
  }
}

export function encodeReport(report: NetworkReport): string {
  return LZString.compressToEncodedURIComponent(JSON.stringify(publicPayload(report)))
}

export function decodeReport(encoded: string): NetworkReport | null {
  if (encoded.length > 45000) return null
  try {
    const unpacked = LZString.decompressFromEncodedURIComponent(encoded)
    return unpacked ? parseReportJson(unpacked) : null
  } catch { return null }
}

function parseReportJson(json: string): NetworkReport | null {
  if (json.length > 150000) return null
  try {
    const r = JSON.parse(json)
    const validStatus = ['stable', 'partial', 'limited', 'offline'].includes(r.status)
    if (r.version !== 1 || typeof r.title !== 'string' || !validStatus || typeof r.date !== 'string' || Number.isNaN(Date.parse(r.date))) return null
    if (!Number.isInteger(r.total) || r.total < 1 || r.total > 1000 || !Number.isInteger(r.available) || r.available < 0 || r.available > r.total) return null
    const text = (v: unknown, max: number) => typeof v === 'string' ? v.slice(0, max) : ''
    const results: ProbeResult[] = Array.isArray(r.results) ? r.results.slice(0, 200).filter((s: ProbeResult) => s && typeof s.name === 'string' && typeof s.domain === 'string' && ['ru', 'global', 'services'].includes(s.group) && ['ok', 'slow', 'unknown'].includes(s.status)).map((s: ProbeResult) => ({
      siteId: text(s.siteId, 100), name: text(s.name, 120), domain: text(s.domain, 253), group: s.group,
      status: s.status, latency: typeof s.latency === 'number' && s.latency >= 0 && s.latency < 120000 ? Math.round(s.latency) : null,
    })) : []
    const groups = r.groups && ['ru', 'global', 'services'].every(key => typeof r.groups[key] === 'number' && r.groups[key] >= 0 && r.groups[key] <= 100)
      ? { ru: r.groups.ru, global: r.groups.global, services: r.groups.services } : undefined
    return {
      id: text(r.id, 100) || crypto.randomUUID(), title: text(r.title, 160), date: r.date,
      region: text(r.region, 100) || 'Не указан', operator: text(r.operator, 100) || 'Не указан',
      status: r.status, total: r.total, available: r.available, slow: Number.isInteger(r.slow) ? Math.max(0, Math.min(r.slow, r.available)) : 0,
      latency: typeof r.latency === 'number' && r.latency >= 0 && r.latency < 120000 ? Math.round(r.latency) : null,
      source: r.demo === true ? 'demo' : 'shared', note: text(r.note, 2000), vpn: r.vpn === true, groups, results,
    }
  } catch { return null }
}

export function reportLink(report: NetworkReport): string {
  return `${window.location.origin}/reports#report=${encodeURIComponent(encodeReport(report))}`
}

export async function loadCommunityReports(signal?: AbortSignal): Promise<NetworkReport[]> {
  const response = await fetch('/data/reports.json', {
    headers: { Accept: 'application/json' }, signal, cache: 'no-cache', credentials: 'omit', redirect: 'error',
  })
  if (!response.ok) throw new Error('Не удалось загрузить отчёты с сервера сайта. Попробуйте обновить ленту.')
  const text = await response.text()
  if (text.length > 2000000) throw new Error('Файл отчётов превышает допустимый размер.')
  let data
  try { data = JSON.parse(text) } catch { throw new Error('Сервер вернул некорректный JSON отчётов.') }
  if (!data || data.version !== 1 || !Array.isArray(data.reports) || data.reports.length > 100) throw new Error('Некорректный формат файла отчётов: ожидаются version: 1 и массив reports, не более 100 записей.')
  const ids = new Set<string>()
  return data.reports.map((entry: unknown): NetworkReport => {
    const report = parseReportJson(JSON.stringify(entry))
    if (!report || ids.has(report.id)) throw new Error('В файле отчётов есть некорректные или повторяющиеся записи.')
    ids.add(report.id)
    return { ...report, source: report.source === 'demo' ? 'demo' : 'community' }
  }).sort((a: NetworkReport, b: NetworkReport) => Number(a.source === 'demo') - Number(b.source === 'demo') || Date.parse(b.date) - Date.parse(a.date))
}

export function buildReport(results: ProbeResult[], region: string, operator: string, vpn: boolean, note: string): NetworkReport {
  const available = results.filter(r => r.status !== 'unknown')
  const latencies = available.flatMap(r => r.latency === null ? [] : [r.latency])
  const ratio = results.length ? available.length / results.length : 0
  const groups = Object.fromEntries((['ru', 'global', 'services'] as SiteGroup[]).map(group => {
    const filtered = results.filter(r => r.group === group)
    return [group, filtered.length ? Math.round(filtered.filter(r => r.status !== 'unknown').length / filtered.length * 100) : 0]
  })) as Record<SiteGroup, number>
  return {
    id: crypto.randomUUID(), title: `Проверка сети${region.trim() ? ` · ${region.trim()}` : ''}`,
    date: new Date().toISOString(), region: region.trim() || 'Не указан', operator: operator || 'Не указан',
    status: ratio >= 0.9 ? 'stable' : ratio >= 0.5 ? 'partial' : ratio > 0.05 ? 'limited' : 'offline',
    total: results.length, available: available.length, slow: results.filter(r => r.status === 'slow').length,
    latency: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    source: 'local', note, vpn, groups, results,
  }
}

function decodeBase64(text: string): string {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
  return new TextDecoder().decode(Uint8Array.from(atob(normalized), c => c.charCodeAt(0)))
}

export function parseVpnNodes(input: string): { nodes: VpnNode[]; errors: number } {
  let text = input.trim()
  if (!text.includes('://')) {
    try { text = decodeBase64(text.replace(/\s/g, '')) } catch { return { nodes: [], errors: 1 } }
  }
  const nodes: VpnNode[] = []
  let errors = 0
  const protocols: Record<string, string> = { vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', ss: 'Shadowsocks', hysteria2: 'Hysteria2', hy2: 'Hysteria2', tuic: 'TUIC', wireguard: 'WireGuard', wg: 'WireGuard' }
  for (const line of text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 100)) {
    try {
      const protocol = line.split('://')[0].toLowerCase()
      if (!protocols[protocol]) throw new Error('Unsupported protocol')
      let host = '', port = 443, name = '', label = protocols[protocol]
      if (protocol === 'vmess') {
        const parsed = JSON.parse(decodeBase64(line.slice(8)))
        host = String(parsed.add || ''); port = Number(parsed.port); name = String(parsed.ps || host)
      } else {
        let link = line
        if (protocol === 'ss' && !line.includes('@')) {
          const [part, tag] = line.slice(5).split('#')
          link = `ss://${decodeBase64(part)}${tag ? '#' + tag : ''}`
        }
        const url = new URL(link)
        host = url.hostname; port = Number(url.port || (protocol === 'wg' || protocol === 'wireguard' ? 51820 : 443))
        try { name = decodeURIComponent(url.hash.slice(1)) || host } catch { name = host }
        if (protocol === 'vless' && url.searchParams.get('security') === 'reality') label = 'VLESS Reality'
      }
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid host')
      nodes.push({ id: crypto.randomUUID(), name: name.slice(0, 120), host: host.slice(0, 253), port, protocol: label, location: 'Локация не указана', country: '', demo: false, status: 'unverified', latency: null })
    } catch { errors++ }
  }
  return { nodes, errors }
}
