import { Share } from '@capacitor/share';
import { isNativeApp } from './nativeBridge';

export type ShareTextOutcome = 'shared' | 'copied' | 'cancelled';

/** Настоящий системный Share Sheet в APK и Web Share/буфер в браузере. */
export async function shareText(title: string, text: string): Promise<ShareTextOutcome> {
  try {
    if (isNativeApp()) {
      await Share.share({ title, text, dialogTitle: 'Поделиться отчётом' });
      return 'shared';
    }
    if (typeof navigator.share === 'function') {
      await navigator.share({ title, text });
      return 'shared';
    }
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch (err) {
    if (err instanceof Error && /abort|cancel|отмен/i.test(err.message)) return 'cancelled';
    // Если системный диалог недоступен, текст всё равно не теряем.
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      throw err;
    }
  }
}
