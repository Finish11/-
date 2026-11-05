import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Конфигурация Capacitor для Android-сборки (APK).
 *
 * Внутри APK лежит автономная демо-сборка (`npm run build:demo` → `demo-dist/`):
 * один HTML-файл с inlined JS/CSS и мок-API (`src/demo/localApi.ts`), поэтому
 * приложение работает без сети и без бэкенда.
 *
 * Если понадобится подключить APK к реальному серверу (Express + SQLite),
 * раскомментируйте блок `server.url` и укажите HTTPS-адрес деплоя — WebView
 * будет открывать боевую версию вместо встроенных ассетов.
 */
const config: CapacitorConfig = {
  appId: 'ru.pulsenet.app',
  appName: 'ПульсСети',
  webDir: 'demo-dist',
  android: {
    backgroundColor: '#050910',
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    // Нативный HTTP вместо WebView: снимает CORS-ограничения — можно скачать
    // подписку с любого домена и постучать по порту узла (проверка доступности).
    CapacitorHttp: {
      enabled: true,
    },
  },
  server: {
    androidScheme: 'https',
    // url: 'https://pulsenet.example.com',
    // cleartext: false,
  },
};

export default config;
