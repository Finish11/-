import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * Мост WebView ↔ Java проверяется статически.
 *
 * Именно здесь был реальный баг: src/lib/siteProbe.ts вызывал
 * ApkUpdater.httpProbe(), а в Java такого метода не было — в APK любой сайт
 * получал «не отвечает», хотя тесты с моком транспорта были зелёными.
 */
const JAVA_DIR = 'android/app/src/main/java/ru/pulsenet/app';

/** Единственный список методов, которые приложение реально вызывает. */
const REQUIRED: Record<string, string[]> = {
  ApkUpdater: ['download', 'status', 'getPermissionState', 'openInstallSettings', 'install',
    'openInstalledApp', 'networkKind', 'stateRead', 'stateWrite'],
  NetworkProbe: ['httpProbe', 'vpnDiagnostics', 'ipEcho', 'tcpProbe', 'realDelay', 'speedPhase', 'speedAbort'],
};

function javaSources(): Array<{ file: string; text: string }> {
  return readdirSync(JAVA_DIR).filter((name) => name.endsWith('.java'))
    .map((name) => ({ file: name, text: readFileSync(`${JAVA_DIR}/${name}`, 'utf8') }));
}

function declaredMethods(): Map<string, Set<string>> {
  const byPlugin = new Map<string, Set<string>>();
  for (const { text } of javaSources()) {
    const name = /@CapacitorPlugin\(\s*name\s*=\s*"([^"]+)"/.exec(text)?.[1];
    if (!name) continue;
    const methods = new Set<string>();
    const pattern = /@PluginMethod[\s\S]{0,200}?public\s+void\s+(\w+)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) methods.add(match[1]);
    byPlugin.set(name, methods);
  }
  return byPlugin;
}

test('каждый нативный метод, который вызывает WebView, реализован в Java', () => {
  const declared = declaredMethods();
  for (const [plugin, methods] of Object.entries(REQUIRED)) {
    assert.ok(declared.has(plugin), `плагин ${plugin} не зарегистрирован аннотацией @CapacitorPlugin`);
    for (const method of methods) {
      assert.ok(declared.get(plugin)!.has(method),
        `${plugin}.${method}() вызывается из TypeScript, но не реализован в Java — в APK это молчаливый отказ`);
    }
  }
});

test('плагины зарегистрированы в MainActivity и в WebView', () => {
  const main = readFileSync(`${JAVA_DIR}/MainActivity.java`, 'utf8');
  const bridge = readFileSync('src/lib/apkPlugin.ts', 'utf8');
  for (const plugin of Object.keys(REQUIRED)) {
    assert.match(bridge, new RegExp(`registerPlugin\\('${plugin}'\\)`), `${plugin} не зарегистрирован в src/lib/apkPlugin.ts`);
    const className = new RegExp(`registerPlugin\\((\\w+)\\.class\\)`, 'g');
    const registered: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = className.exec(main))) registered.push(match[1]);
    assert.ok(registered.length >= Object.keys(REQUIRED).length,
      `MainActivity регистрирует ${registered.length} плагинов, ожидалось минимум ${Object.keys(REQUIRED).length}`);
    const source = javaSources().find((item) => item.text.includes(`name = "${plugin}"`));
    assert.ok(source, `нет Java-класса для ${plugin}`);
    assert.ok(registered.includes(source!.file.replace(/\.java$/, '')),
      `${source!.file} не зарегистрирован в MainActivity — методы будут недоступны`);
  }
});

test('мост вызывает объявленные методы, а контракт не расходится с кодом', () => {
  const bridgeFiles = ['src/lib/nativeBridge.ts', 'src/lib/nativeStateStore.ts', 'src/lib/appUpdate.ts', 'src/lib/apkPlugin.ts'];
  const bridge = bridgeFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  for (const methods of Object.values(REQUIRED)) {
    for (const method of methods) {
      assert.ok(bridge.includes(`${method}(`) || bridge.includes(`${method}:`),
        `${method}() есть в контракте, но нигде не вызывается — контракт устарел`);
    }
  }
  // Слушатели событий тоже часть контракта.
  const probe = readFileSync(`${JAVA_DIR}/NetworkProbePlugin.java`, 'utf8');
  assert.match(probe, /notifyListeners\("speedSample"/);
  assert.match(bridge, /addListener\('speedSample'/);
  const updater = readFileSync(`${JAVA_DIR}/ApkUpdaterPlugin.java`, 'utf8');
  assert.match(updater, /notifyListeners\("networkChanged"/);
  assert.match(bridge, /addListener\('networkChanged'/);
});

test('манифест разрешает то, что нужно диагностике VPN', () => {
  const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
  // Без <queries> Android 11+ скрывает пакет владельца VPN: «клиент не указан».
  assert.match(manifest, /<action android:name="android\.net\.VpnService"\s*\/>/);
  assert.match(manifest, /android\.permission\.ACCESS_NETWORK_STATE/);
  // Привязка сокета к физической сети мимо VPN.
  assert.match(manifest, /android\.permission\.CHANGE_NETWORK_STATE/);
  assert.match(manifest, /android\.permission\.INTERNET/);
});

test('java не использует API новее minSdk без проверки версии', () => {
  const minSdk = Number(/minSdkVersion\s*=\s*(\d+)/.exec(readFileSync('android/variables.gradle', 'utf8'))?.[1] ?? 24);
  for (const { file, text } of javaSources()) {
    // java.util.Base64 появился в API 26, android.util.Base64 доступен всегда.
    if (minSdk < 26) assert.ok(!/import java\.util\.Base64;/.test(text),
      `${file}: java.util.Base64 требует API 26, а minSdk=${minSdk} — используйте android.util.Base64`);
  }
});
