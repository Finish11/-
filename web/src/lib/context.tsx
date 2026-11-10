import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { CATALOG, DEMO_REPORTS } from './data'
import type { NetworkReport, ProbeResult, Site } from './types'
import { loadCommunityReports } from './utils'

// The provider and its typed consumer hooks intentionally share this module.
// eslint-disable-next-line react-refresh/only-export-components
export function useStoredState<T>(key: string, fallback: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(`pulsenet-v2:${key}`)
      if (!saved) return fallback
      const parsed = JSON.parse(saved)
      if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback
      return parsed
    } catch { return fallback }
  })
  useEffect(() => {
    try { localStorage.setItem(`pulsenet-v2:${key}`, JSON.stringify(value)) }
    catch { window.dispatchEvent(new CustomEvent('pulsenet-storage-error')) }
  }, [key, value])
  return [value, setValue]
}

interface PulseContextValue {
  localReports: NetworkReport[]
  publicReports: NetworkReport[]
  communityCount: number
  communityState: 'loading' | 'ready' | 'error'
  communityError: string
  refreshCommunity: () => Promise<void>
  saveReport: (report: NetworkReport) => void
  deleteReport: (id: string) => void
  clearHistory: () => void
  sites: Site[]
  disabledSites: string[]
  toggleSite: (id: string) => void
  addSite: (site: Site) => void
  removeSite: (id: string) => void
  siteResults: Record<string, ProbeResult>
  recordResult: (result: ProbeResult) => void
  viewedReport: NetworkReport | null
  openReport: (report: NetworkReport | null) => void
  sharedReport: NetworkReport | null
  shareReport: (report: NetworkReport | null) => void
  toast: { message: string; tone: 'success' | 'info' | 'error' } | null
  notify: (message: string, tone?: 'success' | 'info' | 'error') => void
  dismissToast: () => void
}

const PulseContext = createContext<PulseContextValue | null>(null)

export function PulseProvider({ children }: { children: ReactNode }) {
  const [localReports, setLocalReports] = useStoredState<NetworkReport[]>('reports', [])
  const [customSites, setCustomSites] = useStoredState<Site[]>('sites', [])
  const [disabledSites, setDisabledSites] = useStoredState<string[]>('disabled-sites', [])
  const [siteResults, setSiteResults] = useStoredState<Record<string, ProbeResult>>('results', {})
  const [community, setCommunity] = useState<NetworkReport[] | null>(null)
  const [communityState, setCommunityState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [communityError, setCommunityError] = useState('')
  const [viewedReport, openReport] = useState<NetworkReport | null>(null)
  const [sharedReport, shareReport] = useState<NetworkReport | null>(null)
  const [toast, setToast] = useState<PulseContextValue['toast']>(null)
  const notify = useCallback((message: string, tone: 'success' | 'info' | 'error' = 'success') => setToast({ message, tone }), [])
  const refreshCommunity = useCallback(async () => {
    setCommunityState('loading')
    try {
      const reports = await loadCommunityReports()
      setCommunity(reports)
      setCommunityError('')
      setCommunityState('ready')
    } catch (error) {
      setCommunityError(error instanceof Error ? error.message : 'Публикации временно недоступны.')
      setCommunityState('error')
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadCommunityReports(controller.signal).then(reports => {
      if (controller.signal.aborted) return
      setCommunity(reports)
      setCommunityError('')
      setCommunityState('ready')
    }).catch(error => {
      if (controller.signal.aborted) return
      setCommunityError(error instanceof Error ? error.message : 'Публикации временно недоступны.')
      setCommunityState('error')
    })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5500)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    const handle = () => notify('Браузер не разрешил сохранить данные. Экспортируйте важные отчёты.', 'error')
    window.addEventListener('pulsenet-storage-error', handle)
    return () => window.removeEventListener('pulsenet-storage-error', handle)
  }, [notify])

  const publicReports = community ?? DEMO_REPORTS
  const value: PulseContextValue = {
    localReports, publicReports, communityCount: publicReports.filter(report => report.source === 'community').length,
    communityState, communityError, refreshCommunity,
    saveReport: report => setLocalReports(old => [report, ...old.filter(r => r.id !== report.id)].slice(0, 100)),
    deleteReport: id => setLocalReports(old => old.filter(r => r.id !== id)),
    clearHistory: () => { setLocalReports([]); setSiteResults({}); notify('Локальная история очищена') },
    sites: [...CATALOG, ...customSites], disabledSites,
    toggleSite: id => setDisabledSites(old => old.includes(id) ? old.filter(s => s !== id) : [...old, id]),
    addSite: site => setCustomSites(old => [...old, site]),
    removeSite: id => { setCustomSites(old => old.filter(s => s.id !== id)); setDisabledSites(old => old.filter(s => s !== id)) },
    siteResults, recordResult: result => setSiteResults(old => ({ ...old, [result.siteId]: result })),
    viewedReport, openReport, sharedReport, shareReport, toast, notify, dismissToast: () => setToast(null),
  }
  return <PulseContext.Provider value={value}>{children}</PulseContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePulse() {
  const context = useContext(PulseContext)
  if (!context) throw new Error('PulseProvider is missing')
  return context
}
