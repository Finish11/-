import type { ProbeResult, Site } from './types'

export async function probeSite(site: Site, signal?: AbortSignal): Promise<ProbeResult> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = window.setTimeout(() => controller.abort(), 6500)
  const start = performance.now()
  const result: ProbeResult = { siteId: site.id, name: site.name, domain: site.domain, group: site.group, status: 'unknown', latency: null }
  try {
    const probeUrl = new URL(site.probeUrl)
    probeUrl.searchParams.set('_pulse', String(Date.now()))
    // An opaque response confirms that the browser received a response; its
    // HTTP status and page content cannot be inspected in no-cors mode.
    await fetch(probeUrl, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal })
    result.latency = Math.round(performance.now() - start)
    result.status = result.latency > 1200 ? 'slow' : 'ok'
  } catch {
    result.status = 'unknown'
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
  return result
}

export async function scanSites(sites: Site[], signal: AbortSignal, onResult: (result: ProbeResult) => void): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  let cursor = 0
  async function worker() {
    while (cursor < sites.length && !signal.aborted) {
      const site = sites[cursor++]
      const result = await probeSite(site, signal)
      if (signal.aborted) return
      results.push(result)
      onResult(result)
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, sites.length) }, () => worker()))
  return results
}
