import { getNativeNetworkState, getVpnDiagnostics, ipEcho, isNativeApp, nativeGet } from './nativeBridge';
import type { NativeNetworkState } from './nativeBridge';
import type { ClientConnectionInfo } from '../types';

export interface GeoInfo {
  ip: string;
  country_code: string;
  country_name: string;
  region: string;
  city: string;
  isp: string;
  org: string;
  asn: string;
  is_hosting: boolean;
  is_proxy: boolean;
  is_mobile: boolean;
}

export interface NetworkContext {
  geo: GeoInfo | null;
  /** Физический транспорт Android или ручной режим демо. */
  networkKind: 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown';
  /** В APK это исключительно системный TRANSPORT_VPN. */
  vpnLikely: boolean;
  vpnSource: 'system' | 'ip' | 'none';
  vpnReasons: string[];
  splitTunnel: boolean;
  /** VPN есть в системе (может принадлежать другому приложению). */
  systemVpn?: boolean;
  /** Через туннель идёт именно трафик этого приложения. */
  appUsesVpn?: boolean;
  bypassAvailable?: boolean;
  /** IP физической сети, если удалось измерить мимо туннеля. */
  directIp?: string;
  nativeSequence?: number;
  nativeCarrier?: string;
  vpnPackage?: string;
  vpnAppName?: string;
  changedDuringCheck: boolean;
  geoError?: string;
}

export function connectionLabel(kind: NetworkContext['networkKind']): string {
  switch (kind) {
    case 'wifi': return 'Wi-Fi';
    case 'cellular': return 'Мобильная сеть';
    case 'ethernet': return 'Проводная сеть';
    case 'none': return 'Нет сети';
    default: return 'Сеть не определена';
  }
}

export interface NetworkContextOptions {
  networkTypeOverride?: string;
  nativeStatus?: NativeNetworkState;
  skipGeo?: boolean;
}

export function emptyGeo(): GeoInfo {
  return {
    ip: '', country_code: '', country_name: '', region: '', city: '',
    isp: '', org: '', asn: '',
    is_hosting: false, is_proxy: false, is_mobile: false,
  };
}

export function networkSnapshotKey(state: NativeNetworkState): string {
  const transport = `${state.connected ? 1 : 0}|${state.kind}|${state.vpn ? 1 : 0}|${state.vpnPackage || ''}`;
  // Два разных Wi-Fi или две сотовые сети имеют одинаковый транспорт. Системный
  // sequence различает Network ID; у старых bridge его может не быть — тогда
  // сохраняем прежнее поведение, а не выдумываем идентификатор.
  return typeof state.sequence === 'number' && Number.isFinite(state.sequence)
    ? `${transport}|${state.sequence}`
    : transport;
}

/** Позднее системное событие не должно запускать устаревший снимок. */
export function isNewerNetworkSequence(incoming: number | undefined, current: number): boolean {
  return incoming == null || incoming >= current;
}

export async function detectNativeNetworkStatus(): Promise<NativeNetworkState> {
  if (!isNativeApp()) {
    return { connected: false, kind: 'unknown', vpn: false, carrier: '', systemKnown: false };
  }
  try {
    return await getNativeNetworkState();
  } catch {
    // Старый APK или недоступный плагин: не выдумываем системный VPN по GeoIP.
    return { connected: false, kind: 'unknown', vpn: false, carrier: '', systemKnown: false };
  }
}

const TEXT_IP_PROVIDERS = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://checkip.amazonaws.com'];

/** IP отдельным шагом: без него нельзя ни подтвердить приложение, ни привязать замер. */
export async function detectExitIp(): Promise<{ ip: string; source: string; error?: string }> {
  if (isNativeApp()) {
    const echo = await ipEcho(false, 6000);
    if (echo.ok && echo.ip) return { ip: echo.ip, source: echo.source || 'native' };
  }
  for (const url of TEXT_IP_PROVIDERS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const response = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        if (!response.ok) continue;
        const text = (await response.text()).trim();
        const match = /^(?:\d{1,3}\.){3}\d{1,3}$/.exec(text) || /^[0-9a-f:]+$/i.exec(text);
        if (match) return { ip: text, source: url };
      } finally { clearTimeout(timer); }
    } catch { /* следующий провайдер */ }
  }
  return { ip: '', source: '', error: 'Сервисы определения IP недоступны' };
}

async function detectGeo(): Promise<{ geo: GeoInfo; error?: string }> {
  const providers = [
    'https://ipwho.is/',
    'https://ipapi.co/json/',
    'https://freeipapi.com/api/json',
  ];
  let lastError = '';
  for (const url of providers) {
    try {
      let raw: Record<string, unknown>;
      if (isNativeApp()) {
        // Тот же CapacitorHttp, что и у siteProbe: один сетевой маршрут в APK.
        const response = await nativeGet(url, 6000, 'PulseNet/1.5 (Android)');
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`HTTP ${response.status}`);
        }
        raw = JSON.parse(response.text) as Record<string, unknown>;
      } else {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        try {
          const r = await fetch(url, { signal: ctrl.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          raw = await r.json() as Record<string, unknown>;
        } finally {
          clearTimeout(timer);
        }
      }
      if (raw.success === false || raw.error === true) {
        throw new Error(String(raw.message || raw.reason || 'GeoIP вернул ошибку'));
      }
      const conns = (raw.connection || {}) as Record<string, unknown>;
      const security = (raw.security || {}) as Record<string, unknown>;
      const geo: GeoInfo = {
        ip: String(raw.ip || raw.ipAddress || raw.query || ''),
        country_code: String(raw.country_code || raw.countryCode || raw.country || ''),
        country_name: String(raw.country_name || raw.countryName || ''),
        region: String(raw.region || raw.region_name || raw.regionName || ''),
        city: String(raw.city || ''),
        isp: String(raw.isp || conns.isp || raw.org || ''),
        org: String(raw.org || conns.org || conns.asn_org || ''),
        asn: String(conns.asn || raw.asn || ''),
        is_hosting: Boolean(raw.is_hosting || security.hosting || raw.hosting),
        is_proxy: Boolean(raw.is_proxy || security.proxy || raw.proxy),
        is_mobile: Boolean(raw.is_mobile || security.mobile || raw.mobile),
      };
      if (geo.ip) return { geo };
      lastError = 'сервис не вернул IP';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  // Геоданные не обязательны: подтверждающим приложениям нужен только сам IP.
  const fallback = await detectExitIp();
  if (fallback.ip) return { geo: { ...emptyGeo(), ip: fallback.ip }, error: lastError || 'Страна и провайдер не определены' };
  return { geo: emptyGeo(), error: lastError || 'GeoIP недоступен' };
}

/**
 * Единственное место, где формируется VPN-вердикт.
 * На Android IP, страна и hosting вообще не участвуют в системном факте VPN.
 */
export function resolveVpnStatus(
  native: NativeNetworkState,
  geo: GeoInfo,
  nativePlatform: boolean
): Pick<NetworkContext, 'vpnLikely' | 'vpnSource' | 'vpnReasons'> {
  if (nativePlatform) {
    // VPN «для приложения» и VPN «в системе» — разные факты. При per-app proxy
    // клиент включён, но наши запросы идут напрямую: подписывать их туннелем нельзя.
    const appUsesVpn = native.connected && (native.appUsesVpn ?? native.vpn);
    const systemVpn = native.connected && (native.systemVpn || native.vpn || appUsesVpn);
    const reasons: string[] = [];
    if (appUsesVpn) reasons.push('Android сообщает TRANSPORT_VPN для сети этого приложения');
    if (systemVpn && !appUsesVpn) reasons.push('VPN включён в системе, но трафик приложения идёт мимо туннеля (раздельный туннель)');
    return {
      vpnLikely: appUsesVpn,
      vpnSource: native.connected ? 'system' : 'none',
      vpnReasons: reasons,
    };
  }

  // В браузере системного TRANSPORT_VPN нет: это лишь подсказка, не факт туннеля.
  const foreign = geo.country_code.length === 2 && geo.country_code.toUpperCase() !== 'RU';
  const hosting = geo.is_hosting || geo.is_proxy;
  const reasons: string[] = [];
  if (foreign) reasons.push(`IP вне РФ (${geo.country_code})`);
  if (hosting) reasons.push('IP похож на дата-центр или прокси');
  return {
    vpnLikely: foreign || hosting,
    vpnSource: reasons.length ? 'ip' : 'none',
    vpnReasons: reasons,
  };
}

export function buildNetworkContext(
  native: NativeNetworkState,
  geo: GeoInfo | null,
  options: NetworkContextOptions = {}
): NetworkContext {
  const nativePlatform = isNativeApp();
  const vpn = resolveVpnStatus(native, geo || emptyGeo(), nativePlatform);
  let browserKind: NetworkContext['networkKind'] = 'unknown';
  if (!nativePlatform && typeof navigator !== 'undefined') {
    const nav = navigator as Navigator & { connection?: { type?: string; effectiveType?: string } };
    if (nav.connection?.type === 'wifi' || nav.connection?.type === 'cellular' || nav.connection?.type === 'ethernet') {
      browserKind = nav.connection.type;
    } else if (nav.connection?.effectiveType) {
      browserKind = 'cellular';
    }
  }
  const networkKind = options.networkTypeOverride && options.networkTypeOverride !== 'auto'
    ? options.networkTypeOverride as NetworkContext['networkKind']
    : native.connected
    ? native.kind
    : nativePlatform
    ? !native.systemKnown ? 'unknown' : 'none'
    : browserKind;
  const operator = native.kind === 'cellular' && native.carrier
    ? native.carrier
    : geo?.isp || '';
  const appUsesVpn = nativePlatform ? native.connected && (native.appUsesVpn ?? native.vpn) : vpn.vpnLikely;
  const systemVpn = nativePlatform ? native.connected && Boolean(native.systemVpn || native.vpn || appUsesVpn) : false;
  return {
    geo,
    networkKind,
    ...vpn,
    splitTunnel: nativePlatform ? systemVpn && !appUsesVpn : false,
    systemVpn,
    appUsesVpn,
    bypassAvailable: native.bypassAvailable !== false,
    nativeSequence: native.sequence,
    nativeCarrier: operator,
    vpnPackage: native.vpnPackage,
    vpnAppName: native.vpnAppName,
    changedDuringCheck: false,
  };
}

/**
 * Свежий атомарный снимок. Если сеть переключилась во время GeoIP, повторяем
 * GeoIP один раз; changedDuringCheck позволяет вызывающему отбросить результат,
 * если переключения продолжаются и даже вторая попытка устарела.
 */
export async function detectNetworkContext(
  options: NetworkContextOptions = {}
): Promise<NetworkContext> {
  const start = options.nativeStatus || await detectNativeNetworkStatus();
  let geo: GeoInfo | null = null;
  let geoError: string | undefined;
  if (!options.skipGeo && start.connected) {
    const result = await detectGeo();
    geo = result.geo.ip ? result.geo : null;
    geoError = result.error;
  } else if (!options.skipGeo && !isNativeApp()) {
    const result = await detectGeo();
    geo = result.geo.ip ? result.geo : null;
    geoError = result.error;
  }

  let current = await detectNativeNetworkStatus();
  if (networkSnapshotKey(current) !== networkSnapshotKey(start)) {
    if (current.connected && !options.skipGeo) {
      const retry = await detectGeo();
      geo = retry.geo.ip ? retry.geo : null;
      geoError = retry.error;
    } else if (!current.connected) {
      geo = null;
    }
    const finalState = await detectNativeNetworkStatus();
    const changedAgain = networkSnapshotKey(finalState) !== networkSnapshotKey(current);
    current = finalState;
    const context = buildNetworkContext(current, current.connected || !isNativeApp() ? geo : null, options);
    context.changedDuringCheck = changedAgain;
    context.geoError = geoError;
    return context;
  }

  const context = buildNetworkContext(current, current.connected || !isNativeApp() ? geo : null, options);
  context.geoError = geoError;
  return context;
}

export function hasSameNetworkAttribution(
  before: ClientConnectionInfo,
  after: ClientConnectionInfo
): boolean {
  const systemVpn = (value: ClientConnectionInfo) =>
    value.vpn_source === 'system' && value.vpn_detected;
  const sameNativeNetwork =
    before.native_sequence == null ||
    after.native_sequence == null ||
    before.native_sequence === after.native_sequence;
  return sameNativeNetwork && before.connection_kind === after.connection_kind && systemVpn(before) === systemVpn(after)
    && (before.vpn_package || '') === (after.vpn_package || '');
}

export function toClientConnection(ctx: NetworkContext): ClientConnectionInfo {
  const g = ctx.geo || emptyGeo();
  return {
    ip: g.ip,
    country_code: g.country_code,
    country_name: g.country_name,
    region: g.region,
    city: g.city,
    isp: g.isp,
    org: g.org,
    asn: g.asn,
    is_hosting: g.is_hosting,
    is_proxy: g.is_proxy,
    is_mobile: g.is_mobile,
    connection_kind: ctx.networkKind,
    operator: ctx.nativeCarrier || g.isp,
    native_sequence: ctx.nativeSequence,
    vpn_package: ctx.vpnPackage,
    vpn_app_name: ctx.vpnAppName,
    vpn_detected: ctx.vpnLikely,
    vpn_confidence: ctx.vpnSource === 'system' ? 'high' : ctx.vpnSource === 'ip' ? 'medium' : 'none',
    vpn_source: ctx.vpnSource,
    vpn_reasons: ctx.vpnReasons,
    split_tunnel: ctx.splitTunnel,
    system_vpn: ctx.systemVpn,
    direct_ip: ctx.directIp,
    bypass_available: ctx.bypassAvailable,
    webrtc_ips: [],
  };
}

/**
 * Доказательство раздельного туннеля: сравниваем IP приложения и IP физической
 * сети. Если они совпадают при включённом VPN — наши проверки идут напрямую, и
 * результаты нельзя приписывать туннелю.
 */
export async function verifyTunnelBypass(): Promise<{ checked: boolean; bypassed: boolean; appIp: string; directIp: string; reason: string }> {
  if (!isNativeApp()) return { checked: false, bypassed: false, appIp: '', directIp: '', reason: 'Доступно только в Android-приложении' };
  const diagnostics = await getVpnDiagnostics();
  if (!diagnostics.ok) return { checked: false, bypassed: false, appIp: '', directIp: '', reason: diagnostics.error || 'Система не отдала сведения о VPN' };
  if (!diagnostics.systemVpn) return { checked: true, bypassed: false, appIp: '', directIp: '', reason: 'Системный VPN выключен' };
  if (diagnostics.splitTunnel) return { checked: true, bypassed: true, appIp: '', directIp: '',
    reason: `${diagnostics.vpnAppName || 'VPN-клиент'} включён, но Android направляет трафик этого приложения мимо туннеля. Добавьте приложение в проксируемые в настройках клиента.` };
  if (!diagnostics.bypassAvailable) return { checked: true, bypassed: false, appIp: '', directIp: '',
    reason: 'Прямой доступ мимо VPN запрещён системой (постоянный VPN): сравнить маршруты нельзя' };
  const [app, direct] = await Promise.all([ipEcho(false, 6000), ipEcho(true, 6000)]);
  if (!app.ok || !app.ip || !direct.ok || !direct.ip)
    return { checked: false, bypassed: false, appIp: app.ip || '', directIp: direct.ip || '', reason: 'Не удалось сравнить IP двух маршрутов' };
  const bypassed = app.ip === direct.ip;
  return { checked: true, bypassed, appIp: app.ip, directIp: direct.ip,
    reason: bypassed ? 'Приложение и прямая сеть выходят с одного IP: туннель не используется для наших проверок'
      : `Приложение выходит с ${app.ip}, прямая сеть — с ${direct.ip}: проверки идут через туннель` };
}
