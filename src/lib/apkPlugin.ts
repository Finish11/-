import { registerPlugin } from '@capacitor/core';

/**
 * Единственная регистрация Java-плагина ApkUpdater в WebView.
 * Сеть, TCP, обновления и файловое хранилище используют этот общий proxy;
 * повторный registerPlugin при каждом ping создавал лишние объекты и warnings.
 */
export const ApkPlugin = registerPlugin('ApkUpdater');
