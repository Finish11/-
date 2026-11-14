/**
 * «Эмулятор телефона» для прохода по приложению как обычный человек.
 *
 * Настоящий Android-эмулятор в песочнице не запускается: нет KVM, Android SDK
 * и сети до dl.google.com (3 ГБ памяти тоже мало). Но главное отличие APK от
 * веб-демо — нативный мост Capacitor — воспроизводится точно: приложение
 * видит `Capacitor.isNativePlatform() === true`, `Capacitor.PluginHeaders`
 * с методами Java-плагинов и ходит в них через `cap.nativePromise`, как в
 * настоящем WebView.
 *
 * Что это даёт: те же ветки кода, что на телефоне (`isNativeApp()`), реальные
 * потоки «VPN включён / выключен / split tunnel», замеры, обновление APK,
 * сохранение состояния — без SDK. Сеть синтетическая и управляемая: можно
 * задать скорость, задержку, «нет сети» и хосты, отвечающие 403, — именно так
 * воспроизводятся жалобы вида «YouTube работает, а замер показывает 0 бит».
 */

export type PhoneNetworkKind = 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown';

export interface PhoneState {
  /** Сеть глазами Android. */
  connected: boolean;
  kind: PhoneNetworkKind;
  /** VPN включён в системе (может быть у другого приложения). */
  systemVpn: boolean;
  /** Идёт ли трафик ЭТОГО приложения через VPN (per-app proxy выключает). */
  appUsesVpn: boolean;
  vpnPackage: string;
  vpnAppName: string;
  /** Скорость канала, Мбит/с. */
  mbps: number;
  /** Задержка канала, мс. */
  latencyMs: number;
  /** Хосты, отвечающие 403/410 — как протухший videoplayback. */
  blockedHosts: string[];
  /** Точки замера, которые не отвечают (для проверки честного отказа). */
  deadSpeedHosts: string[];
  /** Персистентное состояние приложения (аналог filesDir). */
  state: string | null;
  /** Версия установленного APK — от неё зависит предложение обновления. */
  installedVersionCode: number;
  /**
   * Выходной IP. Задаётся явно, чтобы проверять смену узла в VPN-клиенте:
   * раньше адрес был зашит в моке, и сценарий «сменил сервер — отзыв должен
   * перепровериться» проверить было нельзя.
   */
  exitIp: string;
  /** IP без VPN. */
  directIp: string;
}

export const DEFAULT_PHONE: PhoneState = {
  connected: true,
  kind: 'wifi',
  systemVpn: true,
  appUsesVpn: true,
  vpnPackage: 'com.v2ray.ang',
  vpnAppName: 'v2rayNG',
  mbps: 62,
  latencyMs: 34,
  blockedHosts: [],
  deadSpeedHosts: [],
  state: null,
  installedVersionCode: 111002091,
  exitIp: '198.51.100.7',
  directIp: '203.0.113.20',
  /** Разрешена ли установка APK из приложения (Android: canRequestPackageInstalls). */
  canInstallApk: true,
};

export interface PhoneOptions {
  /** Считаться APK. `false` — обычный браузер, для сравнения поведения. */
  native?: boolean;
  state?: Partial<PhoneState>;
}

/** Скрипт для `page.addInitScript`: поднимает мост до загрузки приложения. */
export function phoneInitScript(options: PhoneOptions = {}): string {
  const phone = { ...DEFAULT_PHONE, ...options.state };
  const native = options.native !== false;
  const methods = {
    ApkUpdater: ['download', 'status', 'getPermissionState', 'openInstallSettings', 'install',
      'openInstalledApp', 'networkKind', 'stateRead', 'stateWrite', 'tcpProbe'],
    NetworkProbe: ['httpProbe', 'vpnDiagnostics', 'ipEcho', 'realDelay', 'speedPhase', 'speedAbort'],
    App: ['getInfo', 'getState', 'minimizeApp', 'addListener', 'removeListener'],
    CapacitorHttp: ['request'],
  };
  const headers = Object.entries(methods).map(([name, list]) => ({
    name,
    methods: [
      ...list.map((method) => ({ name: method, rtype: 'promise' })),
      // addListener/removeListener объявлены в базовом com.getcapacitor.Plugin
      // с returnType = RETURN_NONE: rtype в заголовке не пишется, и JS-прокси
      // вызывает их как callback-методы. Без этих строк подписка на
      // networkChanged молча падала — так же, как было в реальном APK до
      // проверки на «телефоне».
      { name: 'addListener' },
      { name: 'removeListener' },
    ],
  }));

  return String.raw`(() => {
  const NATIVE = ${native};
  const phone = ${JSON.stringify(phone)};
  const log = [];
  window.__phone = {
    log,
    snapshot: () => JSON.parse(JSON.stringify(phone)),
    // Любая правка состояния — это смена сети: sequence растёт, подписчики
    // получают networkChanged. Раньше здесь остался вызов удалённой emit(),
    // и patch() падал с ReferenceError на любом вызове.
    patch: (values) => { Object.assign(phone, values); bumpSequence(); emitEvent('ApkUpdater:networkChanged', window.__phone.snapshot()); },
    calls: () => log.map((entry) => entry.pluginId + '.' + entry.methodName),
  };
  if (!NATIVE) return;

  const cap = (window.Capacitor = window.Capacitor || {});
  cap.PluginHeaders = ${JSON.stringify(headers)};
  cap.Plugins = cap.Plugins || {};
  window.androidBridge = window.androidBridge || { postMessage() {} };

  // Слушатели, как в Java: на событие — набор подписок, у каждой свой
  // callbackId. React StrictMode монтирует эффект дважды, и отписка «старого»
  // монтирования не должна снимать живую подписку. Раньше здесь лежал один
  // колбэк на имя события — из-за этого события сети терялись.
  // ---- «DownloadManager»: загрузка APK идёт в фоне, статус — через status() ---
  const downloads = new Map();
  let downloadSeq = 0;
  const downloadTimers = [];
  Object.assign(phone, { downloads: [], installCalls: [], installSettingsOpened: 0, installed: false });
  // Счётчики обновления живут на самом window.__phone: тест читает их из
  // страницы, а не из замыкания init-скрипта.
  const installState = phone;
  const listeners = new Map();
  let counter = Math.floor(Math.random() * 100000);
  const emitEvent = (key, payload) => {
    const set = listeners.get(key);
    if (set) for (const entry of Array.from(set)) if (entry.callback) entry.callback(payload);
  };

  // ---- «Java»: те же ответы, коды и ошибки, что у плагинов в APK ----------
  const num = (value, fallback) => (typeof value === 'number' && isFinite(value) ? value : fallback);
  let sequenceValue = 1;
  const sequence = () => sequenceValue;
  const bumpSequence = () => { sequenceValue += 1; };
  const routeName = () => (phone.connected && phone.appUsesVpn ? 'vpn' : phone.connected ? 'direct' : 'unknown');
  const wantStatus = (url, status) => {
    try { return phone.blockedHosts.some((host) => String(url).includes(host)) ? status || 403 : 0; }
    catch { return 0; }
  };
  const noNetwork = () => ({ ok: false, route: 'unknown', error: 'DNS: домен не резолвится (UnknownHostException)' });

  const speedPhase = (options) => {
    const direction = options.direction === 'upload' ? 'upload' : 'download';
    const durationMs = Math.max(1000, Math.min(30000, num(options.durationMs, 10000)));
    const maxBytes = num(options.maxBytes, 100 * 1024 * 1024);
    const connections = Math.max(1, Math.min(8, num(options.connections, 4)));
    const urls = Array.isArray(options.urls) ? options.urls.slice() : [];
    if (!phone.connected) {
      return { ok: false, bytes: 0, confirmed: 0, elapsedMs: 5, requests: 0, connections,
        route: 'unknown', slices: [], errors: ['DNS: домен не резолвится'] };
    }
    // Отказ адреса — это отказ адреса: остальные продолжают (как в Java).
    const errors = [];
    const dead = new Set();
    for (const url of urls) {
      const denied = wantStatus(url, 403);
      if (denied) { errors.push('HTTP ' + denied); dead.add(url); }
    }
    if (!urls.some((url) => !dead.has(url))) {
      return { ok: false, bytes: 0, confirmed: 0, elapsedMs: 30, requests: dead.size || urls.length,
        connections, route: routeName(), slices: [], errors };
    }
    const rate = (direction === 'download' ? phone.mbps : Math.max(1, phone.mbps * 0.33)) * 1000 * 1000 / 8;
    const slices = [];
    let bytes = 0;
    for (let elapsed = 100; elapsed <= durationMs && bytes < maxBytes; elapsed += 100) {
      bytes = Math.min(maxBytes, Math.round((rate * elapsed) / 1000));
      slices.push({ t: elapsed, bytes, confirmed: bytes });
    }
    return { ok: bytes > 0, bytes, confirmed: bytes, elapsedMs: slices.length ? slices[slices.length - 1].t : 0,
      requests: Math.max(1, Math.round(durationMs / 800)), connections, route: routeName(), slices, errors };
  };

  const handlers = {
    ApkUpdater: {
      networkKind: () => ({
        systemKnown: true, connected: phone.connected, kind: phone.connected ? phone.kind : 'none',
        vpn: phone.connected && phone.appUsesVpn, carrier: phone.kind === 'cellular' ? 'MTS' : '',
        systemVpn: phone.systemVpn, appUsesVpn: phone.connected && phone.appUsesVpn,
        splitTunnel: phone.systemVpn && !phone.appUsesVpn, lockdown: false,
        bypassAvailable: !phone.systemVpn || !phone.appUsesVpn,
        vpnPackage: phone.vpnPackage, vpnAppName: phone.vpnAppName,
        // В Java это монотонный счётчик, который растёт ТОЛЬКО когда меняется
        // сеть. С Date.now() приложение видело новое событие на каждом опросе,
        // уходило в бесконечную перепроверку и навсегда застревало на
        // «определяем сеть…» — именно это поймал эмулятор телефона.
        sequence: sequence(),
      }),
      stateRead: () => ({ exists: phone.state != null, value: phone.state == null ? '' : phone.state }),
      stateWrite: (options) => { phone.state = String(options.value == null ? '' : options.value); return { ok: true, bytes: phone.state.length }; },
      openInstalledApp: () => ({ opened: false, installed: false }),
      // Java: status() в этом плагине не про версию приложения, а про загрузку
      // APK — { state, progress, bytes, total }. Версию отдаёт App.getInfo().
      status: (options) => {
        const id = Number(options && options.downloadId);
        const entry = downloads.get(id);
        if (!entry) return { state: 0, progress: 0 };
        return { state: entry.state, progress: Math.min(100, Math.round((entry.bytes / entry.total) * 100)),
          bytes: entry.bytes, total: entry.total };
      },
      // Java отдаёт { canInstall, androidSdk }, а не { granted }. С чужим полем
      // приложение считало, что разрешение не выдано, и уходило в «Нужно
      // разрешение» вместо установщика.
      getPermissionState: () => ({ canInstall: phone.canInstallApk, androidSdk: 34 }),
      openInstallSettings: () => { phone.installSettingsOpened += 1; return { ok: true }; },
      // Контракт Java: install отдаёт { needsPermission }, download — { downloadId }.
      install: (options) => {
        const id = Number(options && options.downloadId);
        phone.installCalls.push(id);
        if (!phone.canInstallApk) return { needsPermission: true };
        if (!downloads.has(id) || downloads.get(id).state !== 8) throw new Error('Файл ещё не скачан');
        phone.installed = true;
        return { needsPermission: false };
      },
      download: (options) => {
        const id = ++downloadSeq;
        const state = { bytes: 0, total: 4_914_631, state: 1, url: String(options && options.url),
          name: String(options && options.fileName) };
        downloads.set(id, state);
        phone.downloads.push({ id, url: state.url, name: state.name });
        // Как DownloadManager: загрузка идёт в фоне, статус опрашивается через status().
        const timer = setInterval(() => {
          if (!phone.connected) { state.state = 16; clearInterval(timer); return; }
          state.bytes = Math.min(state.total, state.bytes + Math.round(state.total / 5));
          state.state = 2;
          if (state.bytes >= state.total) { state.state = 8; clearInterval(timer); }
        }, 400);
        downloadTimers.push(timer);
        return { downloadId: id };
      },
      tcpProbe: (options) => {
        if (!phone.connected) return { ok: false, route: 'unknown', error: 'DNS: домен не резолвится' };
        if (wantStatus(options.host, 1)) return { ok: false, route: routeName(), error: 'connection reset: таймаут' };
        const delay = Math.max(1, Math.round(phone.latencyMs / 2));
        return { ok: true, latency_ms: delay, latency_us: delay * 1000, route: routeName(), address: '203.0.113.20' };
      },
    },
    NetworkProbe: {
      vpnDiagnostics: () => ({
        ok: true, appUsesVpn: phone.connected && phone.appUsesVpn, systemVpn: phone.systemVpn,
        splitTunnel: phone.systemVpn && !phone.appUsesVpn, vpnPackage: phone.vpnPackage,
        vpnAppName: phone.vpnAppName, alwaysOnApp: '', lockdown: false, bypassAvailable: true,
        physicalKind: phone.kind, activeKind: phone.kind,
        installedVpnApps: [{ package: 'com.v2ray.ang', name: 'v2rayNG' }],
      }),
      ipEcho: () => phone.connected
        ? { ok: true, ip: phone.appUsesVpn ? phone.exitIp : phone.directIp, route: routeName(),
            latency_ms: phone.latencyMs, source: 'phone' }
        : noNetwork(),
      realDelay: (options) => {
        if (!phone.connected) return noNetwork();
        if (wantStatus(options.url, 1)) return { ok: false, route: routeName(), error: 'HTTP 403' };
        const samples = [];
        for (let index = 0; index < Math.max(1, Math.min(7, num(options.samples, 4))); index += 1) {
          samples.push(phone.latencyMs + (index % 2));
        }
        return { ok: true, latency_ms: phone.latencyMs, min_ms: phone.latencyMs,
          max_ms: phone.latencyMs + 1, samples, status: 204, route: routeName() };
      },
      /**
       * HTTP-проба сайта. Мок отвечает по типу запрошенного файла, как живой
       * сервер: раньше на КАЖДЫЙ адрес приходил HTML, и проверка каталога
       * объявляла все 75 сайтов заблокированными («вместо значка сайта пришла
       * HTML-страница»). Это был дефект мока, а не приложения: настоящий
       * ya.ru на /favicon.ico отдаёт картинку.
       */
      httpProbe: (options) => {
        if (!phone.connected) return noNetwork();
        const url = String(options.url || '');
        const denied = wantStatus(url, 403);
        if (denied) return { ok: true, status: denied, url, route: routeName(),
          content_type: 'text/plain', data_base64: '', truncated: false, latency_ms: phone.latencyMs };
        const base = { ok: true, status: 200, url, route: routeName(), truncated: false, latency_ms: phone.latencyMs };
        // Служебные 204 для контрольной пробы сети.
        if (/generate_204/.test(url)) return { ...base, status: 204, content_type: 'text/plain', data_base64: '' };
        // Значок сайта — картинка, а не страница.
        if (/favicon\.(ico|png|svg)|logo\.(png|svg)/i.test(url)) {
          const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
          return { ...base, content_type: 'image/png', data_base64: png };
        }
        return { ...base, content_type: 'text/html; charset=utf-8',
          data_base64: btoa('<html><head><title>Phone</title></head><body>ok</body></html>') };
      },
      // Настоящая Java-фаза присылает события каждые 100 мс и отдаёт итог в
      // resolve. Здесь повторяем оба пути, чтобы проверять и график, и итог.
      speedPhase: (options) => {
        const result = speedPhase(options);
        const emit = window.__phone && window.__phone.emitSample;
        if (typeof emit === 'function' && result.slices && result.slices.length) {
          result.slices.forEach((slice, index) => {
            setTimeout(() => emit({ runId: options.runId, direction: options.direction || 'download',
              elapsedMs: slice.t, bytes: slice.bytes, confirmed: slice.confirmed }), 40 * (index + 1));
          });
        }
        return result;
      },
      speedAbort: () => ({ ok: true }),
    },
    App: {
      getInfo: () => ({ id: 'ru.pulsenet.app', name: 'ПульсСети', version: '1.11.2', build: '111002091', platform: 'android' }),
      getState: () => ({ isActive: true }),
      minimizeApp: () => ({}),
    },
    CapacitorHttp: {
      // Нативный HTTP в APK — единственный путь к геосервисам и страницам.
      // Мок отвечает правдоподобно для каждого известного хоста: HTML вместо
      // JSON у ipwho.is оставлял шапку навсегда на «определяем сеть…», и это
      // было видно только в эмуляторе.
      request: (options) => {
        const url = String(options.url == null ? '' : options.url);
        if (!phone.connected) throw new Error('DNS: домен не резолвится');
        const json = (value) => ({ status: 200, url, headers: { 'content-type': 'application/json' }, data: JSON.stringify(value) });
        const text = (value) => ({ status: 200, url, headers: { 'content-type': 'text/html; charset=utf-8' }, data: value });
        const ip = phone.appUsesVpn ? phone.exitIp : phone.directIp;
        // Для прямого IP (203.0.113.0/24 — TEST-NET-3) показываем RU: именно так
        // пользователь в России видит «ограничено сервисом в RU» для ChatGPT.
        // Для VPN-выхода (198.51.100.0/24) оставляем NL — как зарубежный хостинг.
        const directRu = ip === phone.directIp || ip.startsWith('203.0.113.');
        if (url.includes('ipwho.is')) {
          if (directRu) return json({ success: true, ip, country_code: 'RU', country_name: 'Россия', city: 'Москва',
            region: 'Москва', connection: { isp: 'МТС', org: 'МТС', asn: 25532 },
            security: { hosting: false, proxy: false, vpn: false, mobile: false } });
          return json({ success: true, ip, country_code: 'NL', country_name: 'Нидерланды', city: 'Амстердам',
            region: 'Noord-Holland', connection: { isp: 'Datacamp Limited', org: 'Datacamp', asn: 212238 },
            security: { hosting: true, proxy: false, vpn: true, mobile: false } });
        }
        if (url.includes('ipapi.co')) {
          if (directRu) return json({ ip, country_code: 'RU', country_name: 'Россия', city: 'Москва', org: 'МТС' });
          return json({ ip, country_code: 'NL', country_name: 'Нидерланды', city: 'Амстердам', org: 'Datacamp Limited' });
        }
        if (url.includes('freeipapi.com')) {
          if (directRu) return json({ ipAddress: ip, countryCode: 'RU', countryName: 'Россия', cityName: 'Москва' });
          return json({ ipAddress: ip, countryCode: 'NL', countryName: 'Нидерланды', cityName: 'Амстердам' });
        }
        const denied = wantStatus(url, 403);
        if (denied) return { status: denied, url, headers: { 'content-type': 'text/plain' }, data: 'forbidden' };
        if (url.includes('youtube.com')) {
          return text('<html><head><title>YouTube</title></head><body><div id="player"></div></body></html>');
        }
        return text('<html><head><title>Phone</title></head><body>ok</body></html>');
      },
    },
  };

  const call = (pluginId, methodName, options) => {
    log.push({ pluginId, methodName, at: Date.now() });
    // Системные плагины (App, Network) в нативных сборках обрабатываются самим
    // мостом, а не таблицей методов ApkUpdater/NetworkProbe.
    if (pluginId === 'App' && (methodName === 'addListener' || methodName === 'removeListener')) {
      return { ok: true };
    }
    const table = handlers[pluginId];
    if (!table || typeof table[methodName] !== 'function') {
      throw new Error('"' + pluginId + '.' + methodName + '()" is not implemented');
    }
    return table[methodName](options || {});
  };

  cap.toNative = (pluginId, methodName, options, stored) => {
    if (methodName === 'addListener') {
      const handle = addListener(pluginId, options && options.eventName, stored && stored.callback);
      log.push({ pluginId, methodName, key: pluginId + ':' + (options && options.eventName) });
      return handle.callbackId;
    }
    if (methodName === 'removeListener') {
      removeListener(pluginId, options && options.eventName, options && options.callbackId);
      return 'removed';
    }
    return pluginId + '.' + methodName;
  };
  // addListener в Java — callback-метод: первый вызов получает данные, а каждый
  // следующий — новое событие. Прокси Capacitor ждёт объект с remove, поэтому
  // первый ответ именно такой.
  const addListener = (pluginId, eventName, callback) => {
    const key = pluginId + ':' + eventName;
    const callbackId = 'listener-' + (++counter);
    const entry = { callback, callbackId };
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(entry);
    if (callback) callback({ remove: async () => { listeners.get(key)?.delete(entry); } });
    return { remove: async () => { listeners.get(key)?.delete(entry); }, callbackId };
  };
  const removeListener = (pluginId, eventName, callbackId) => {
    const key = pluginId + ':' + eventName;
    const set = listeners.get(key);
    if (!set) return;
    if (!callbackId) { set.clear(); return; }
    for (const entry of set) if (entry.callbackId === callbackId) set.delete(entry);
  };

  cap.nativePromise = (pluginId, methodName, options) => new Promise((resolve, reject) => {
    const delay = methodName === 'realDelay' || methodName === 'httpProbe' ? phone.latencyMs : 10;
    setTimeout(() => {
      try { resolve(call(pluginId, methodName, options)); } catch (error) { reject(error); }
    }, delay);
  });
  cap.nativeCallback = (pluginId, methodName, options, callback) => {
    log.push({ pluginId, methodName, at: Date.now() });
    if (methodName === 'addListener') return addListener(pluginId, options && options.eventName, callback);
    if (methodName === 'removeListener') {
      removeListener(pluginId, options && options.eventName, options && options.callbackId);
      if (callback) callback({ ok: true });
      return { ok: true };
    }
    try { if (callback) callback(call(pluginId, methodName, options)); } catch (error) { if (callback) callback(null, error); }
  };
  cap.addListener = (pluginId, eventName, callback) => addListener(pluginId, eventName, callback);
  // patch() в тестах меняет сеть: эмулируем то же, что делает Android, —
  // новый sequence и событие networkChanged для тех, кто подписан.
  window.__phone.listenerKeys = () => Array.from(listeners.keys());
  // Итоги обновления APK — те же поля, что выставляет «Java» выше.
  window.__phone.installState = () => ({
    downloads: installState.downloads, installCalls: installState.installCalls,
    settingsOpened: installState.installSettingsOpened, installed: installState.installed,
  });
  window.__phone.setNetwork = (values) => {
    Object.assign(phone, values);
    sequenceValue += 1;
    // Как Callback.onAvailable у Android: событие приходит отдельной доставкой.
    setTimeout(() => emitEvent('ApkUpdater:networkChanged', window.__phone.snapshot()), 0);
  };
  window.__phone.emitSample = (event) => emitEvent('NetworkProbe:speedSample', event);
  cap.isNativePlatform = () => true;
  cap.getPlatform = () => 'android';
  cap.convertFileSrc = (value) => value;
})();`;
}
