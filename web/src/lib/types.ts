export type SiteGroup = 'ru' | 'global' | 'services'
export type ProbeStatus = 'ok' | 'slow' | 'unknown'
export type ReportStatus = 'stable' | 'partial' | 'limited' | 'offline'
export type ReportSource = 'demo' | 'local' | 'community' | 'shared'

export interface Site {
  id: string
  name: string
  domain: string
  probeUrl: string
  group: SiteGroup
  custom?: boolean
}

export interface ProbeResult {
  siteId: string
  name: string
  domain: string
  group: SiteGroup
  status: ProbeStatus
  latency: number | null
}

export interface NetworkReport {
  id: string
  title: string
  date: string
  region: string
  operator: string
  status: ReportStatus
  total: number
  available: number
  slow: number
  latency: number | null
  source: ReportSource
  note: string
  vpn: boolean
  groups?: Record<SiteGroup, number>
  results?: ProbeResult[]
  githubUrl?: string
  author?: string
}

export interface VpnNode {
  id: string
  name: string
  host: string
  port: number
  protocol: string
  location: string
  country: string
  demo: boolean
  status: 'online' | 'degraded' | 'offline' | 'unverified'
  latency: number | null
  primary?: boolean
}

export type Period = '24h' | '7d' | '30d'
