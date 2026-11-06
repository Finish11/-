import { useCallback, useEffect, useRef, useState } from 'react';
import { Radar, Loader2 } from 'lucide-react';
import { Network } from '@capacitor/network';
import type { PluginListenerHandle } from '@capacitor/core';
import { isNativeApp, onNativeNetworkChanged } from './lib/nativeBridge';
import { useSettings } from './lib/appSettings';
import {
  apiFetch,
  hasExplicitLogout,
  markExplicitLogout,
  setStoredToken,
} from './lib/api';
import {
  buildNetworkContext,
  detectNativeNetworkStatus,
  detectNetworkContext,
  isNewerNetworkSequence,
  networkSnapshotKey,
  toClientConnection,
} from './lib/networkInfo';
import type {
  AppConfirmation,
  ClientConnectionInfo,
  Incident,
  ScanRecord,
  Site,
  User,
  VpnProfile,
  VpnSubscription,
} from './types';
import { ToastContainer, type ToastItem } from './components/Toast';
import { AuthView, type AuthBootstrapPayload } from './components/AuthView';
import { Layout, type NavTab } from './components/Layout';
import { ScannerView } from './components/ScannerView';
import { SitesView } from './components/SitesView';
import { VpnMonitorView } from './components/VpnMonitorView';
import { IncidentsView } from './components/IncidentsView';
import { HistoryView } from './components/HistoryView';
import { PermissionOnboarding } from './components/PermissionOnboarding';

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);

  const [activeTab, setActiveTab] = useState<NavTab>('scanner');
  const [darkMode, setDarkMode] = useState(true);

  const [sites, setSites] = useState<Site[]>([]);
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [vpnProfiles, setVpnProfiles] = useState<VpnProfile[]>([]);
  const [subscriptions, setSubscriptions] = useState<VpnSubscription[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [confirmations, setConfirmations] = useState<AppConfirmation[]>([]);
  const [confirmationProfileId, setConfirmationProfileId] = useState<number | null>(null);

  const [connection, setConnection] = useState<ClientConnectionInfo | null>(null);
  const [connLoading, setConnLoading] = useState(false);
  const [appSettings] = useSettings();
  const connectionRequest = useRef(0);
  const nativeSequence = useRef(0);
  const transportKey = useRef('');

  const [prefillIncidentScan, setPrefillIncidentScan] = useState<ScanRecord | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback(
    (type: ToastItem['type'], message: string) => {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { id, type, message }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const refreshConnection = useCallback(async () => {
    const request = ++connectionRequest.current;
    setConnLoading(true);
    try {
      const native = await detectNativeNetworkStatus();
      if (request !== connectionRequest.current) return;

      // Старый IP/город/оператор исчезает сразу при смене транспорта.
      const nextKey = networkSnapshotKey(native);
      if (isNativeApp() && nextKey !== transportKey.current) {
        transportKey.current = nextKey;
        setConnection(toClientConnection(buildNetworkContext(native, null, {
          networkTypeOverride: appSettings.networkType,
        })));
      }

      const ctx = await detectNetworkContext({
        networkTypeOverride: appSettings.networkType,
        nativeStatus: native,
      });
      if (request !== connectionRequest.current) return;
      if (ctx.changedDuringCheck) {
        // Быстрые LTE ↔ Wi-Fi переключения: не применяем GeoIP старого маршрута.
        window.setTimeout(() => { void refreshConnection(); }, 0);
        return;
      }
      const client = toClientConnection(ctx);
      // transportKey уже сохранён из системного native-статуса выше. Не заменяем
      // его ключом без sequence: иначе следующий poll снова сотрёт GeoIP.
      setConnection(client);
    } catch {
      // Системный callback или периодическая проверка повторит запрос.
    } finally {
      if (request === connectionRequest.current) setConnLoading(false);
    }
  }, [appSettings.networkType]);

  useEffect(() => {
    let disposed = false;
    let listener: PluginListenerHandle | undefined;
    void refreshConnection();
    const removeNative = isNativeApp()
      ? onNativeNetworkChanged((state) => {
          if (disposed || !isNewerNetworkSequence(state.sequence, nativeSequence.current)) return;
          nativeSequence.current = state.sequence ?? nativeSequence.current;
          void refreshConnection();
        })
      : () => {};

    // Запасной триггер. Его connectionType не используем: он может быть старым.
    if (isNativeApp()) {
      void Network.addListener('networkStatusChange', () => {
        if (!disposed) void refreshConnection();
      }).then((handle) => {
        if (disposed) void handle.remove();
        else listener = handle;
      }).catch(() => {});
    }
    const poll = window.setInterval(() => { void refreshConnection(); }, 30000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshConnection();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', refreshConnection);
    window.addEventListener('offline', refreshConnection);
    return () => {
      disposed = true;
      connectionRequest.current += 1;
      removeNative();
      if (listener) void listener.remove();
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', refreshConnection);
      window.removeEventListener('offline', refreshConnection);
    };
  }, [refreshConnection]);

  const applyBootstrap = useCallback(
    (payload: AuthBootstrapPayload) => {
      setStoredToken(payload.token);
      setUser(payload.user);
      if (payload.sites) setSites(payload.sites);
      if (payload.scans) setScans(payload.scans);
      if (payload.profiles) setVpnProfiles(payload.profiles);
      if (payload.subscriptions) setSubscriptions(payload.subscriptions);
      if (payload.incidents) setIncidents(payload.incidents);
      if (payload.confirmations) setConfirmations(payload.confirmations);
      setConfirmationProfileId(payload.confirmationProfileId ?? null);
      refreshConnection();
    },
    [refreshConnection]
  );

  const loadWorkspaceData = useCallback(async () => {
    setDataLoading(true);
    try {
      const [sitesRes, scansRes, vpnRes, incRes, subRes, confirmationsRes, routeRes] = await Promise.all([
        apiFetch<{ sites: Site[] }>('/api/sites'),
        apiFetch<{ scans: ScanRecord[] }>('/api/scans'),
        apiFetch<{ profiles: VpnProfile[] }>('/api/vpn-profiles'),
        apiFetch<{ incidents: Incident[] }>('/api/incidents'),
        apiFetch<{ subscriptions: VpnSubscription[] }>('/api/vpn-subscriptions'),
        apiFetch<{ confirmations: AppConfirmation[] }>('/api/app-confirmations'),
        apiFetch<{ profileId: number | null }>('/api/app-confirmations/route'),
      ]);
      setSites(sitesRes.sites);
      setScans(scansRes.scans);
      setVpnProfiles(vpnRes.profiles);
      setIncidents(incRes.incidents);
      setSubscriptions(subRes.subscriptions);
      setConfirmations(confirmationsRes.confirmations);
      setConfirmationProfileId(routeRes.profileId);
    } catch (err) {
      const status = (err as Error & { status?: number })?.status;
      if (status === 401) {
        setStoredToken(null);
        setUser(null);
        showToast('warning', 'Сессия истекла — войдите в аккаунт снова');
      } else {
        showToast('error', err instanceof Error ? err.message : 'Ошибка загрузки данных');
      }
    } finally {
      setDataLoading(false);
    }
  }, [showToast]);

  // Initial auth bootstrap (uses existing session token or auto-signs into demo on first visit)
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const me = await apiFetch<AuthBootstrapPayload>('/api/auth/me');
        if (!cancelled) {
          applyBootstrap(me);
        }
      } catch {
        if (!hasExplicitLogout()) {
          try {
            const demo = await apiFetch<AuthBootstrapPayload>('/api/auth/demo', {
              method: 'POST',
            });
            if (!cancelled) {
              applyBootstrap(demo);
            }
          } catch {
            // stay unauthenticated
          }
        }
      } finally {
        if (!cancelled) setBooting(false);
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [applyBootstrap]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  const handleAuthenticated = (payload: AuthBootstrapPayload) => {
    applyBootstrap(payload);
    if (!payload.sites) {
      loadWorkspaceData();
    }
  };

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    markExplicitLogout();
    setUser(null);
    setSites([]);
    setScans([]);
    setVpnProfiles([]);
    setIncidents([]);
    setSubscriptions([]);
    setConfirmations([]);
    setConfirmationProfileId(null);
    showToast('info', 'Вы вышли из аккаунта');
  };

  const handleScanSaved = (scan: ScanRecord) => {
    setScans((prev) => {
      const exists = prev.some((s) => s.id === scan.id);
      if (exists) {
        return prev.map((s) => (s.id === scan.id ? scan : s));
      }
      return [scan, ...prev];
    });

    if (scan.results && scan.results.length > 0) {
      const byId = new Map(
        scan.results.filter((r) => r.site_id).map((r) => [r.site_id!, r])
      );
      setSites((prev) =>
        prev.map((s) => {
          const hit = byId.get(s.id);
          if (!hit) return s;
          return {
            ...s,
            last_status: hit.network_status ?? hit.status,
            last_latency_ms: hit.network_latency_ms ?? hit.latency_ms,
            last_checked_at: scan.created_at,
          };
        })
      );
    }
  };

  const handleConfirmationSaved = (confirmation: AppConfirmation) => {
    setConfirmations((prev) => {
      const exists = prev.some((item) => item.id === confirmation.id);
      return exists
        ? prev.map((item) => item.id === confirmation.id ? confirmation : item)
        : [confirmation, ...prev];
    });
  };

  const handleConfirmationRoute = async (profileId: number | null) => {
    const res = await apiFetch<{ profileId: number | null }>('/api/app-confirmations/route', {
      method: 'PUT', body: JSON.stringify({ profile_id: profileId }),
    });
    setConfirmationProfileId(res.profileId);
  };

  const handleQuickReportIncident = (scan: ScanRecord) => {
    setPrefillIncidentScan(scan);
    setActiveTab('incidents');
  };

  if (booting) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-sky-500/15 border border-sky-400/30 flex items-center justify-center">
          <Radar className="w-7 h-7 text-sky-400 animate-pulse" />
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-400 font-medium">
          <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
          Загрузка ПульсСети...
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
        <AuthView onAuthenticated={handleAuthenticated} showToast={showToast} />
      </>
    );
  }

  return (
    <>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      <PermissionOnboarding />
      <Layout
        user={user}
        onUserUpdate={setUser}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        connection={connection}
        connLoading={connLoading}
        onRefreshConnection={refreshConnection}
        onLogout={handleLogout}
        counts={{
          sites: sites.filter((s) => Boolean(s.enabled)).length,
          vpnOnline: vpnProfiles.filter((p) => p.status === 'online' || p.status === 'degraded').length,
          vpnTotal: vpnProfiles.length,
          activeIncidents: incidents.filter((i) => i.status === 'active').length,
          scans: scans.length,
        }}
        darkMode={darkMode}
        onToggleTheme={() => setDarkMode((d) => !d)}
        showToast={showToast}
      >
        {dataLoading && sites.length === 0 ? (
          <div className="space-y-4 animate-pulse">
            <div className="h-14 rounded-2xl bg-slate-800/60" />
            <div className="h-72 rounded-3xl bg-slate-800/60" />
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="h-24 rounded-2xl bg-slate-800/60" />
              <div className="h-24 rounded-2xl bg-slate-800/60" />
              <div className="h-24 rounded-2xl bg-slate-800/60" />
            </div>
          </div>
        ) : (
          <>
            <div className={`anim-fade-up ${activeTab === 'scanner' ? '' : 'hidden'}`}>
              <ScannerView
                user={user}
                sites={sites}
                latestScan={scans[0] || null}
                connection={connection}
                vpnProfiles={vpnProfiles}
                confirmations={confirmations}
                onConfirmationSaved={handleConfirmationSaved}
                confirmationProfileId={confirmationProfileId}
                onConfirmationRoute={handleConfirmationRoute}
                onConnectionDetected={() => { void refreshConnection(); }}
                onScanSaved={handleScanSaved}
                onQuickReportIncident={handleQuickReportIncident}
                onNavigateSites={() => setActiveTab('sites')}
                onNavigateVpn={() => setActiveTab('vpn')}
                hasNodes={vpnProfiles.length > 0}
                onSitesChanged={loadWorkspaceData}
                darkMode={darkMode}
                showToast={showToast}
              />
            </div>

            {activeTab === 'sites' && (
              <SitesView
                sites={sites}
                setSites={setSites}
                darkMode={darkMode}
                showToast={showToast}
              />
            )}

            {activeTab === 'vpn' && (
              <VpnMonitorView
                profiles={vpnProfiles}
                setProfiles={setVpnProfiles}
                subscriptions={subscriptions}
                setSubscriptions={setSubscriptions}
                confirmations={confirmations}
                connection={connection}
                connLoading={connLoading}
                onRefreshConnection={refreshConnection}
                darkMode={darkMode}
                showToast={showToast}
                lastScan={scans[0] ?? null}
              />
            )}

            {activeTab === 'incidents' && (
              <IncidentsView
                user={user}
                incidents={incidents}
                setIncidents={setIncidents}
                prefillFromScan={prefillIncidentScan}
                onClearPrefill={() => setPrefillIncidentScan(null)}
                darkMode={darkMode}
                showToast={showToast}
              />
            )}

            {activeTab === 'history' && (
              <HistoryView
                scans={scans}
                setScans={setScans}
                onGoToScanner={() => setActiveTab('scanner')}
                darkMode={darkMode}
                showToast={showToast}
              />
            )}
          </>
        )}
      </Layout>
    </>
  );
}
export default App;
