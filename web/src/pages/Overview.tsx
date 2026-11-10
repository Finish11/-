import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDownRight, ArrowRight, ArrowUpRight, CalendarDays, ChevronDown, FileText, Globe2, LockKeyholeOpen, Radar, Radio, ShieldCheck, Timer, TrendingUp } from 'lucide-react'
import { usePulse } from '../lib/context'
import { DEMO_REPORTS } from '../lib/data'
import type { Period } from '../lib/types'
import { percentage } from '../lib/utils'
import { NetworkGraphic } from '../components/NetworkGraphic'
import { NetworkChart } from '../components/NetworkChart'
import { PageHeader, ReportTable } from '../components/ui'

function Sparkline({ variant = 0, color = '#83bba1' }: { variant?: number; color?: string }) {
  const paths = ['M1 33 8 26 15 29 22 21 29 23 36 14 43 17 50 12 57 14 64 6 71 10 78 6 85 8 94 1', 'M1 8 8 12 15 6 22 14 29 10 36 20 43 15 50 25 57 20 64 29 71 24 78 31 85 27 94 31', 'M1 33 9 33 9 26 24 26 24 21 39 21 39 17 54 17 54 11 69 11 69 6 84 6 84 2 94 2', 'M1 30 8 27 15 29 22 25 29 26 36 19 43 22 50 15 57 18 64 11 71 13 78 7 85 9 94 3']
  return <svg className="stat-sparkline" viewBox="0 0 96 39" fill="none" aria-hidden="true"><path d={paths[variant]} stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function ServiceStatus() {
  const { siteResults, sites } = usePulse()
  const services = [
    { name: 'Яндекс', domain: 'ya.ru', symbol: 'Я', className: 'yandex', demoLatency: 37 },
    { name: 'Google', domain: 'google.com', symbol: 'G', className: 'google', demoLatency: 82 },
    { name: 'Telegram', domain: 'web.telegram.org', symbol: '➤', className: 'telegram', demoLatency: 95 },
    { name: 'GitHub', domain: 'github.com', symbol: '⌘', className: 'github', demoLatency: 76 },
    { name: 'YouTube', domain: 'youtube.com', symbol: '▶', className: 'youtube', demoLatency: 1240 },
  ]
  const hasMeasurements = services.some(service => { const site = sites.find(s => s.domain === service.domain); return site && siteResults[site.id] })
  return <section className="panel service-panel"><div className="panel-heading"><div><h2>Статус сервисов</h2><p>{hasMeasurements ? 'Последние проверки с вашего устройства' : 'Контрольные точки · пример данных'}</p></div><Link to="/sites" className="icon-button" aria-label="Открыть все ресурсы"><ArrowUpRight size={18} /></Link></div><div className="service-list">{services.map(service => {
    const site = sites.find(s => s.domain === service.domain)
    const result = site ? siteResults[site.id] : undefined
    const state = result?.status ?? (hasMeasurements ? 'unverified' : service.demoLatency > 1200 ? 'slow' : 'ok')
    return <Link to={`/sites?q=${encodeURIComponent(service.name)}`} className="service-row" key={service.name}><span className={`service-logo ${service.className}`}>{service.symbol}</span><span className="service-name">{service.name}<small>{service.domain}</small></span><span className={`service-state ${state}`}><i />{state === 'ok' ? 'Доступен' : state === 'slow' ? 'Замедление' : state === 'unknown' ? 'Нет ответа' : 'Не проверен'}</span></Link>
  })}</div><Link to="/sites" className="panel-bottom-link">Все {sites.length} ресурсов <ArrowRight size={15} /></Link></section>
}

export function Overview() {
  const { localReports, publicReports, communityCount, sites } = usePulse()
  const [period, setPeriod] = useState<Period>('24h')
  const current = localReports[0] || publicReports.find(report => report.source === 'community') || DEMO_REPORTS[2]
  const isDemo = current.source === 'demo'
  const isCommunity = current.source === 'community'
  return <div className="page overview-page"><PageHeader title="Обзор сети" description="Независимый мониторинг. Открытые данные. Общая картина." actions={<><label className="period-select"><CalendarDays size={15} /><select aria-label="Период обзора" value={period} onChange={event => setPeriod(event.target.value as Period)}><option value="24h">За 24 часа</option><option value="7d">За 7 дней</option><option value="30d">За 30 дней</option></select><ChevronDown size={13} /></label><Link to="/scan" className="button primary"><Radar size={17} />Проверить сеть</Link></>} />
    <section className="overview-hero"><div className="hero-copy"><div className="hero-eyebrow"><span />ИНТЕРНЕТ, КОТОРЫЙ ВИДНО</div><h2>Держим руку<br />на пульсе сети.</h2><p>Проверяйте соединение. Делитесь результатами.<br className="desktop-break" /> Вместе мы видим больше.</p><Link to="/about">Как это работает <ArrowUpRight size={15} /></Link></div><NetworkGraphic /><span className="hero-corner-label"><ShieldCheck size={12} />Открытый исходный код</span></section>
    <div className="section-overline"><span><i className={`tiny-dot ${isDemo ? '' : 'is-live'}`} />{isDemo ? 'ДЕМОНСТРАЦИОННЫЙ ОБЗОР' : isCommunity ? 'ПОСЛЕДНИЙ ОПУБЛИКОВАННЫЙ ЗАМЕР' : 'ВАШ ПОСЛЕДНИЙ ЗАМЕР'}</span><Link to={isDemo ? '/about#data' : isCommunity ? '/reports' : '/history'}>{isDemo ? 'О данных' : isCommunity ? 'Все отчёты' : 'История проверок'} <ArrowUpRight size={11} /></Link></div>
    <div className="stats-grid"><section className="stat-card featured-stat"><div className="stat-top"><span>Доступность сайтов</span><span className="stat-icon"><Globe2 size={17} /></span></div><div className="stat-value">{percentage(current.available, current.total)}<span>%</span></div><div className="stat-bottom"><span><TrendingUp size={13} />{current.available} из {current.total} отвечают</span><Sparkline /></div></section>
      <section className="stat-card"><div className="stat-top"><span>Средний отклик</span><span className="stat-icon"><Timer size={17} /></span></div><div className="stat-value">{current.latency ?? '—'}<span>мс</span></div><div className="stat-bottom"><span><ArrowDownRight size={13} />{isDemo ? 'HTTP-ответ · пример' : isCommunity ? 'Из публичного отчёта' : 'Из вашего браузера'}</span><Sparkline variant={1} color="#97ad9e" /></div></section>
      <Link to="/sites" className="stat-card interactive-card"><div className="stat-top"><span>Ресурсов в каталоге</span><span className="stat-icon"><Radio size={17} /></span></div><div className="stat-value">{sites.length}<span className="stat-unit-small">сайтов</span></div><div className="stat-bottom"><span><i className="tiny-dot is-live" />3 группы проверки</span><Sparkline variant={2} color="#a6aea9" /></div></Link>
      <Link to="/reports" className="stat-card interactive-card"><div className="stat-top"><span>Публичные отчёты</span><span className="stat-icon"><FileText size={17} /></span></div><div className="stat-value">{publicReports.length}<span className="stat-unit-small">отчётов</span></div><div className="stat-bottom"><span>{communityCount > 0 ? `${communityCount} от сообщества` : `Демо-примеров: ${publicReports.length}`}<ArrowUpRight size={12} /></span><Sparkline variant={3} color="#a9a1c6" /></div></Link>
    </div>
    <div className="dashboard-middle"><NetworkChart period={period} setPeriod={setPeriod} reports={localReports} /><ServiceStatus /></div>
    <section className="panel public-panel"><div className="panel-heading"><div className="public-heading"><span className="heading-icon"><FileText size={18} /></span><div><h2>Публичные отчёты <span className="count-pill">{publicReports.length}</span></h2><p>Результаты, которые может увидеть каждый</p></div></div><Link to="/reports" className="text-link">Все отчёты <ArrowUpRight size={15} /></Link></div><ReportTable reports={publicReports.slice(0, 3)} compact /><div className="public-panel-footer"><span><LockKeyholeOpen size={13} />Открыты для всех. Без регистрации.</span><Link to={localReports.length ? '/history' : '/scan'}>Поделиться замером <ArrowRight size={14} /></Link></div></section>
  </div>
}
