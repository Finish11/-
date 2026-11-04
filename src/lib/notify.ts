import { LocalNotifications } from '@capacitor/local-notifications';
import { isNativeApp } from './nativeBridge';

/**
 * Уведомление о результате замера: если пользователь ушёл на другую вкладку
 * или свернул приложение, итог всё равно видно в шторке.
 */
export async function notifyScanResult(title: string, body: string): Promise<void> {
  if (!isNativeApp()) return;
  try {
    let perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      perm = await LocalNotifications.requestPermissions();
    }
    if (perm.display !== 'granted') return;

    await LocalNotifications.schedule({
      notifications: [
        {
          id: Math.floor(Date.now() / 1000) % 2_000_000_000,
          title,
          body,
          schedule: { at: new Date(Date.now() + 300) },
          smallIcon: 'ic_launcher',
        },
      ],
    });
  } catch {
    // уведомления не критичны для замера — молча пропускаем
  }
}
