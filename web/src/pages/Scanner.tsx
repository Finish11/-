import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Activity, ArrowRight, Check, ChevronRight, CircleStop, FileText, Globe2, Info, Laptop, LoaderCircle, LockKeyhole, MapPin, Radar, RotateCcw, Share2, ShieldCheck, Wifi, Zap } from 'lucide-react'
import { usePulse } from '../lib/context'
import { scanSites } from '../lib/scanner'
import type { NetworkReport, ProbeResult, SiteGroup } from '../lib/types'
import { buildReport, percentage } from '../lib/utils'
import { PageHeader, StatusBadge } from '../components/ui'

export function Scanner() {
  const { sites, disabledSites, recordResult, saveReport, openReport, shareReport, notify } = usePulse()
  const [scope, setScope] = useState<'quick' | 'full'>('quick')
  const [region, setRegion] = useState('')
  const [operator, setOperator] = useState('')
  const [vpn, setVpn] = useState(false)
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState<'idle' | 'running' | 'done' | 'cancelled'>('idle')
  const [results, setResults] = useState<ProbeResult[]>([])
  const [total, setTotal] = useState(0)
  const [report, setReport] = useState<NetworkReport | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const controller = useRef<AbortController | null>(null)
  const allowedSites = sites.filter(site => !disabledSites.includes(site.id))
  const priorities = ['ya.ru', 'gosuslugi.ru', 'vk.com', 'ozon.ru', 'google.com', 'ru.wikipedia.org', 'github.com', 'cloudflare.com', 'web.telegram.org', 'youtube.com', 'discord.com', 'web.whatsapp.com']
  const quickSites = (['ru', 'global', 'services'] as SiteGroup[]).flatMap(group => allowedSites.filter(site => site.group === group).sort((a, b) => (priorities.includes(a.domain) ? 0 : 1) - (priorities.includes(b.domain) ? 0 : 1)).slice(0, 4))
  const selectedSites = scope === 'quick' ? quickSites : allowedSites
  const running = phase === 'running'
  const progress = total ? Math.round(results.length / total * 100) : 0

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => { controller.current?.abort(); window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])

  const startScan = async () => {
    if (!selectedSites.length || running) return
    const runController = new AbortController()
    controller.current = runController
    setTotal(selectedSites.length)
    setResults([])
    setReport(null)
    setPhase('running')
    const measured = await scanSites(selectedSites, runController.signal, result => { setResults(previous => [...previous, result]); recordResult(result) })
    if (controller.current !== runController || runController.signal.aborted) return
    const completed = buildReport(measured, region, operator, vpn, note)
    setReport(completed)
    saveReport(completed)
    setPhase('done')
    notify('Проверка завершена. Результат сохранён в вашей истории.')
  }

  const stopScan = () => { controller.current?.abort(); controller.current = null; setPhase('cancelled'); notify('Проверка остановлена. Неполный замер не добавлен в историю.', 'info') }

  return <div className="page scanner-page"><PageHeader title="Проверить сеть" description="Посмотрите на интернет с точки зрения вашего устройства." actions={<Link to="/history" className="button secondary"><FileText size={16} />История замеров</Link>} />
    <div className="scan-layout"><section className="panel scan-settings"><div className="panel-heading"><div><span className="step-label">ШАГ 01</span><h2>Настройте проверку</h2><p>Никакой регистрации и скрытого сбора данных</p></div><span className="heading-icon"><Radar size={20} /></span></div>
      <div className="scan-settings-body"><label className="field-label">Глубина проверки</label><div className="scan-scope-options"><button disabled={running} onClick={() => setScope('quick')} className={`scope-card ${scope === 'quick' ? 'selected' : ''}`} aria-pressed={scope === 'quick'}><span className="scope-icon"><Zap size={19} /></span><strong>Быстрая</strong><small>{quickSites.length} ресурсов · до 20 сек.</small><span className="scope-radio">{scope === 'quick' && <i />}</span></button><button disabled={running} onClick={() => setScope('full')} className={`scope-card ${scope === 'full' ? 'selected' : ''}`} aria-pressed={scope === 'full'}><span className="scope-icon"><Globe2 size={19} /></span><strong>Полная</strong><small>{allowedSites.length} ресурсов · до 90 сек.</small><span className="scope-radio">{scope === 'full' && <i />}</span></button></div>
        <div className="form-grid"><label className="form-field">Город / регион <span>необязательно</span><input disabled={running} value={region} onChange={event => setRegion(event.target.value)} placeholder="Например, Москва" maxLength={100} /></label><label className="form-field">Оператор <span>необязательно</span><select disabled={running} value={operator} onChange={event => setOperator(event.target.value)}><option value="">Не указан</option><option>МТС</option><option>МегаФон</option><option>Билайн</option><option>T2</option><option>Ростелеком</option><option>Дом.ру</option><option>Yota</option><option>Другой оператор</option></select></label></div>
        <label className="checkbox-field vpn-checkbox"><input type="checkbox" checked={vpn} onChange={event => setVpn(event.target.checked)} disabled={running} /><span><strong>Я использую VPN</strong><small>Проверка будет отражать доступность через ваш туннель</small></span><ShieldCheck size={19} /></label>
        <label className="form-field">Заметка к замеру <span>необязательно</span><textarea value={note} onChange={event => setNote(event.target.value)} rows={3} maxLength={1000} disabled={running} placeholder="Например: мобильный интернет, дома, вечер" /></label>
        {!online && <div className="notice amber-notice"><Info size={17} /><p>Браузер сообщает, что устройство не подключено к интернету. Проверьте соединение.</p></div>}
        {!selectedSites.length && <div className="notice amber-notice"><Info size={17} /><p>Нет выбранных ресурсов. Включите хотя бы один сайт в каталоге.</p></div>}
        {running ? <button className="button secondary full-width" onClick={stopScan}><CircleStop size={17} />Остановить проверку</button> : <button className="button primary full-width scan-start" disabled={!selectedSites.length} onClick={() => { void startScan() }}>{phase === 'done' || phase === 'cancelled' ? <RotateCcw size={18} /> : <Radar size={18} />}{phase === 'done' || phase === 'cancelled' ? 'Проверить ещё раз' : 'Начать проверку'}</button>}
        <p className="private-note"><LockKeyhole size={12} />Результат сохранится только в этом браузере</p><Link className="scan-catalog-link" to="/sites">Настроить список ресурсов <ArrowUpRightIcon /></Link>
      </div></section>
      <section className={`panel scan-result-panel ${running ? 'scan-is-running' : ''}`}><div className="panel-heading"><div><span className="step-label">ШАГ 02</span><h2>{running ? 'Слушаем пульс сети' : phase === 'done' ? 'Проверка завершена' : phase === 'cancelled' ? 'Проверка остановлена' : 'Всё готово к проверке'}</h2><p>{running ? 'Отправляем запросы прямо из вашего браузера' : phase === 'done' ? 'Ваш снимок доступности интернета' : 'Узнайте, какие ресурсы отвечают прямо сейчас'}</p></div>{phase === 'done' && <span className="heading-icon"><Check size={20} /></span>}</div>
        {(phase === 'idle' || (phase === 'running' && results.length === 0)) && <div className="scan-visual"><div className={`radar-visual ${running ? 'radar-active' : ''}`}><span /><span /><span /><i /><div><Activity size={37} strokeWidth={1.6} /></div><b className="radar-point one" /><b className="radar-point two" /><b className="radar-point three" /></div><h3>{running ? 'Соединяемся с ресурсами…' : 'Один замер. Полная ясность.'}</h3><p>{running ? 'Первый ответ появится через несколько секунд' : 'Нажмите «Начать проверку», чтобы увидеть результат'}</p><div className="connection-flow"><span><Laptop size={15} />Ваш браузер</span><ChevronRight size={14} /><span><Globe2 size={15} />{selectedSites.length} ресурсов</span></div></div>}
        {(running || phase === 'cancelled') && <div className="scan-progress-block"><div><span>{running && <LoaderCircle size={14} className="spinning" />}{running ? 'Проверяем доступность' : 'Замер не сохранён'}</span><strong>{results.length} / {total}</strong></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div></div>}
        {report && <div className="scan-completed"><StatusBadge status={report.status} /><div className="scan-score">{percentage(report.available, report.total)}<span>%</span></div><p>ресурсов ответили на запрос</p><div className="scan-summary-row"><span><strong>{report.available}</strong>ответили</span><span><strong>{report.total - report.available}</strong>без ответа</span><span><strong>{report.latency ?? '—'}<small> мс</small></strong>HTTP-отклик</span></div><div className="scan-complete-actions"><button className="button secondary" onClick={() => openReport(report)}><FileText size={16} />Детали</button><button className="button primary" onClick={() => shareReport(report)}><Share2 size={16} />Поделиться</button></div></div>}
        {results.length > 0 && <div className="live-results"><div className="live-results-title">РЕЗУЛЬТАТЫ ПО РЕСУРСАМ {running && <span className="live-label"><i />Проверка идёт</span>}</div><div className="result-scroll">{results.map(result => <div className="probe-row" key={result.siteId}><span className={`probe-dot ${result.status}`} /><div><strong>{result.name}</strong><small>{result.domain}</small></div><span className={`probe-result ${result.status}`}>{result.status === 'unknown' ? 'Нет ответа' : `${result.latency} мс`}</span></div>)}</div></div>}
      </section>
    </div><div className="scanner-notes"><div><Wifi size={19} /><div><h3>Проверка с вашей точки</h3><p>Запросы идут с вашего устройства, а не с удалённого сервера. IP-адрес мы не определяем.</p></div></div><div><Info size={19} /><div><h3>Не каждый таймаут — блокировка</h3><p>CORS, защита сайта и нагрузка могут влиять на результат. <Link to="/about#methodology">Подробнее о методике</Link></p></div></div><div><MapPin size={19} /><div><h3>Регион — только по желанию</h3><p>Геолокация не запрашивается. Город и оператор заполняются вами вручную.</p></div></div></div>
  </div>
}

function ArrowUpRightIcon() { return <ArrowRight size={13} /> }
