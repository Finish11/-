import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Activity, ArrowRight, ArrowUpRight, Bell, BookOpen, Check, ChevronRight, CircleHelp, Clock3, FileText, Github, Globe2, LayoutDashboard, LockKeyholeOpen, Menu, Radar, RefreshCw, ShieldCheck, TriangleAlert, X } from 'lucide-react'
import { PulseProvider, usePulse } from '../lib/context'
import { REPO_URL } from '../lib/data'
import { decodeReport, formatDate } from '../lib/utils'
import { Overview } from '../pages/Overview'
import { Scanner } from '../pages/Scanner'
import { Resources } from '../pages/Resources'
import { Reports } from '../pages/Reports'
import { Incidents } from '../pages/Incidents'
import { VpnMonitor } from '../pages/VpnMonitor'
import { History } from '../pages/History'
import { About } from '../pages/About'
import { EmptyState, Logo, Toast } from './ui'
import { ReportModals } from './ReportModals'

const navGroups = [
  { title: 'МОНИТОРИНГ', links: [{ to: '/', label: 'Обзор сети', icon: LayoutDashboard }, { to: '/scan', label: 'Проверить сеть', icon: Radar }, { to: '/sites', label: 'Каталог сайтов', icon: Globe2 }] },
  { title: 'СООБЩЕСТВО', links: [{ to: '/reports', label: 'Публичные отчёты', icon: FileText }, { to: '/incidents', label: 'Сбои и ограничения', icon: TriangleAlert }] },
  { title: 'ИНСТРУМЕНТЫ', links: [{ to: '/vpn', label: 'VPN-монитор', icon: ShieldCheck }, { to: '/history', label: 'История замеров', icon: Clock3 }] },
]

function Shell() {
  const { localReports, sites, communityState, communityError, refreshCommunity, openReport, notify } = usePulse()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [popover, setPopover] = useState<'notifications' | 'profile' | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const handledShare = useRef('')
  const currentGroup = navGroups.find(group => group.links.some(item => item.to === location.pathname))
  const currentPage = currentGroup?.links.find(item => item.to === location.pathname)?.label || (location.pathname === '/about' ? 'О проекте' : 'Страница не найдена')

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }) }, [location.pathname])
  useEffect(() => {
    const encoded = new URLSearchParams(location.hash.slice(1)).get('report') || searchParams.get('report')
    if (encoded && handledShare.current !== encoded) {
      handledShare.current = encoded
      const report = decodeReport(encoded)
      if (report) openReport(report)
      else notify('Ссылка на отчёт повреждена или содержит неподдерживаемые данные.', 'error')
    }
  }, [searchParams, location.hash, openReport, notify])
  useEffect(() => {
    if (!popover) return
    const close = (event: PointerEvent) => { if (!popoverRef.current?.contains(event.target as Node)) setPopover(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setPopover(null) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [popover])

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Перейти к содержимому</a>
    {mobileOpen && <button className="sidebar-backdrop" aria-label="Закрыть меню" onClick={() => setMobileOpen(false)} />}
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}><div className="sidebar-brand"><Link to="/" aria-label="Пульс сети — главная" onClick={() => setMobileOpen(false)}><Logo /></Link><button className="icon-button mobile-close" aria-label="Закрыть меню" onClick={() => setMobileOpen(false)}><X size={20} /></button></div>
      <div className="workspace-label"><span className="workspace-icon"><Globe2 size={17} /></span><span>Открытая платформа<small>Видеть. Проверять. Делиться.</small></span><span className="workspace-dot" /></div>
      <nav className="main-nav" aria-label="Основная навигация">{navGroups.map(group => <div className="nav-group" key={group.title}><p className="nav-group-title">{group.title}</p>{group.links.map(item => <NavLink to={item.to} end={item.to === '/'} key={item.to} onClick={() => setMobileOpen(false)} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><item.icon size={18} strokeWidth={1.7} /><span>{item.label}</span>{item.to === '/sites' && <span className="nav-count">{sites.length}</span>}{item.to === '/reports' && <span className="nav-open-dot" />}{item.to === '/history' && localReports.length > 0 && <span className="nav-count">{localReports.length}</span>}</NavLink>)}</div>)}</nav>
      <div className="sidebar-bottom"><div className="open-data-card"><span className="open-data-icon"><LockKeyholeOpen size={18} /></span><h3>Данные открыты.<br />Для каждого.</h3><p>Наблюдения сообщества<br />помогают видеть больше.</p><Link to="/about" onClick={() => setMobileOpen(false)}>О проекте <ArrowUpRight size={14} /></Link><div className="card-orbit" /></div><a className="sidebar-github" href={REPO_URL} target="_blank" rel="noreferrer"><Github size={17} /><span>Проект на GitHub</span><ArrowUpRight size={13} /></a><div className="sidebar-version"><span><i />Open source</span><span>v1.0</span></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Открыть меню" onClick={() => setMobileOpen(true)}><Menu size={20} /></button><span className="breadcrumb-section">{currentGroup?.title === 'СООБЩЕСТВО' ? 'Сообщество' : currentGroup?.title === 'ИНСТРУМЕНТЫ' ? 'Инструменты' : 'Мониторинг'}</span><ChevronRight size={13} /><span>{currentPage}</span></div><div className="topbar-actions" ref={popoverRef}><Link className="public-access-badge" to="/reports"><span />Публичный доступ</Link><span className="topbar-divider" /><Link className="icon-button" to="/about" aria-label="Помощь и информация"><CircleHelp size={18} /></Link><button className={`icon-button notification-button ${popover === 'notifications' ? 'selected' : ''}`} aria-label="Уведомления" aria-expanded={popover === 'notifications'} onClick={() => setPopover(popover === 'notifications' ? null : 'notifications')}><Bell size={18} />{communityState === 'error' && <i />}</button><button className="avatar-button" aria-label="Меню гостя" aria-expanded={popover === 'profile'} onClick={() => setPopover(popover === 'profile' ? null : 'profile')}>Г</button>
        {popover === 'profile' && <div className="topbar-popover profile-popover"><div className="profile-heading"><span className="avatar-button">Г</span><div><strong>Вы в гостях</strong><small>Рады, что вы с нами</small></div></div><p>Читайте отчёты без регистрации. Ваши замеры сохраняются только в этом браузере.</p><button onClick={() => { setPopover(null); navigate('/history') }}><Clock3 size={16} />Мои замеры<ArrowRight size={14} /></button><button onClick={() => { setPopover(null); navigate('/about#privacy') }}><ShieldCheck size={16} />Приватность<ArrowRight size={14} /></button></div>}
        {popover === 'notifications' && <div className="topbar-popover notifications-popover"><div className="popover-heading"><h3>Центр уведомлений</h3><span className="badge green">Пульс сети</span></div>{localReports[0] && <button className="notification-item" onClick={() => { openReport(localReports[0]); setPopover(null) }}><span className="notification-icon"><Check size={17} /></span><span><strong>Ваш замер сохранён</strong><small>{formatDate(localReports[0].date, true)} · только в вашем браузере</small></span><ChevronRight size={14} /></button>}<div className="notification-item"><span className="notification-icon"><FileText size={17} /></span><span><strong>Отчёты доступны каждому</strong><small>Для чтения общей ленты вход не нужен.</small></span></div><div className="notification-item"><span className="notification-icon muted"><InfoIcon /></span><span><strong>{communityState === 'error' ? 'Файл отчётов временно недоступен' : 'Примеры не равны реальным данным'}</strong><small>{communityState === 'error' ? communityError : 'Демонстрационные записи отмечены меткой «Пример».'}</small></span></div><button className="popover-refresh" disabled={communityState === 'loading'} onClick={() => { void refreshCommunity() }}><RefreshCw size={14} className={communityState === 'loading' ? 'spinning' : ''} />Обновить общую ленту</button></div>}
      </div></header>
      <main id="main-content" className="main-content"><Routes><Route path="/" element={<Overview />} /><Route path="/scan" element={<Scanner />} /><Route path="/sites" element={<Resources />} /><Route path="/reports" element={<Reports />} /><Route path="/incidents" element={<Incidents />} /><Route path="/vpn" element={<VpnMonitor />} /><Route path="/history" element={<History />} /><Route path="/about" element={<About />} /><Route path="*" element={<div className="page"><EmptyState title="Здесь пока нет сигнала" description="Такой страницы не существует. Вернёмся к обзору сети?" action={<Link className="button primary" to="/">На главную <ArrowRight size={16} /></Link>} /></div>} /></Routes></main>
      <footer className="app-footer"><span><Activity size={13} />Пульс сети <span className="footer-copyright">© 2026</span></span><span>Больше прозрачности. Лучше связь.</span><div><Link to="/about#methodology">Методология</Link><i /><a href={REPO_URL} target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={11} /></a></div></footer>
    </div><ReportModals /><Toast />
  </div>
}

function InfoIcon() { return <BookOpen size={17} /> }

export function PulseApp() { return <PulseProvider><Shell /></PulseProvider> }
