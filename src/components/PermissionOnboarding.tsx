import React, { useCallback, useEffect, useState } from 'react';
import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Bell, Check, ChevronRight, Download, Globe2, ShieldCheck } from 'lucide-react';
import { ApkUpdater } from '../lib/appUpdate';
import { isNativeApp } from '../lib/nativeBridge';
import { Sheet } from './ui/Sheet';
import { Button, Notice } from './ui/kit';

const INTRO_KEY = 'pulsenet_permissions_intro_v1';

export const PermissionOnboarding: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [busy, setBusy] = useState<'notifications' | 'install' | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!isNativeApp()) return;
    try {
      const [notice, install] = await Promise.all([
        LocalNotifications.checkPermissions(),
        ApkUpdater.getPermissionState(),
      ]);
      setNotifications(notice.display === 'granted');
      setCanInstall(Boolean(install.canInstall));
    } catch {
      // Экран остаётся доступным: отказ bridge не блокирует приложение.
    }
  }, []);

  useEffect(() => {
    if (!isNativeApp()) return;
    let shown = false;
    try {
      shown = localStorage.getItem(INTRO_KEY) === '1';
    } catch {
      // В приватном режиме покажем ещё раз, но не сломаем запуск.
    }
    if (!shown) {
      setOpen(true);
      void refresh();
    }
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const listener = App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void refresh();
    });
    return () => {
      void listener.then((handle) => handle.remove());
    };
  }, [open, refresh]);

  const close = () => {
    try {
      localStorage.setItem(INTRO_KEY, '1');
    } catch {
      // Настройки всё равно сохраняются системой Android.
    }
    setOpen(false);
  };

  const requestNotifications = async () => {
    setBusy('notifications');
    setError('');
    try {
      const result = await LocalNotifications.requestPermissions();
      setNotifications(result.display === 'granted');
      if (result.display !== 'granted') {
        setError('Уведомления не разрешены. Их можно включить позже в настройках Android.');
      }
    } catch {
      setError('Android не смог показать запрос уведомлений. Попробуйте ещё раз или откройте настройки приложения.');
    } finally {
      setBusy(null);
    }
  };

  const openInstallSettings = async () => {
    setBusy('install');
    setError('');
    try {
      await ApkUpdater.openInstallSettings();
    } catch {
      setError('Не удалось открыть системную настройку. Найдите «ПульсСети → Установка неизвестных приложений» в настройках Android.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Разрешения для ПульсСети"
      subtitle="Только то, что нужно диагностике и обновлениям"
      size="sm"
      icon={<ShieldCheck className="w-5 h-5" style={{ color: 'rgb(var(--accent))' }} />}
    >
      <div className="space-y-2.5">
        <div className="flex gap-3 rounded-2xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
          <div className="w-9 h-9 rounded-xl grid place-items-center shrink-0 accent-soft">
            <Globe2 className="w-4.5 h-4.5" style={{ color: 'rgb(var(--accent))' }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[12.5px] font-bold">
              Сеть и состояние VPN <Check className="w-3.5 h-3.5" style={{ color: 'rgb(var(--success))' }} />
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted">
              Разрешено при установке. Нужно для проверок и распознавания Wi-Fi, мобильной сети и VPN.
            </p>
          </div>
        </div>

        <div className="flex gap-3 rounded-2xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
          <div className="w-9 h-9 rounded-xl grid place-items-center shrink-0 accent-soft">
            <Bell className="w-4.5 h-4.5" style={{ color: 'rgb(var(--accent))' }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-bold">Уведомления</div>
            <p className="mt-1 mb-2 text-[11px] leading-snug text-muted">
              Чтобы увидеть итог замера, если вы свернули приложение. На Android 13+ запрос отдельный.
            </p>
            {notifications ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold" style={{ color: 'rgb(var(--success))' }}>
                <Check className="w-3.5 h-3.5" /> Разрешено
              </span>
            ) : (
              <Button size="sm" variant="soft" loading={busy === 'notifications'} onClick={requestNotifications}>
                Разрешить уведомления <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>

        <div className="flex gap-3 rounded-2xl border p-3" style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}>
          <div className="w-9 h-9 rounded-xl grid place-items-center shrink-0 accent-soft">
            <Download className="w-4.5 h-4.5" style={{ color: 'rgb(var(--accent))' }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-bold">Установка обновлений APK</div>
            <p className="mt-1 mb-2 text-[11px] leading-snug text-muted">
              Android откроет системный экран «Установка неизвестных приложений». Разрешите только ПульсСети.
              Скачанный APK хранится в папке приложения — доступ ко всей памяти и фото не нужен.
            </p>
            {canInstall ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold" style={{ color: 'rgb(var(--success))' }}>
                <Check className="w-3.5 h-3.5" /> Установка разрешена
              </span>
            ) : (
              <Button size="sm" variant="soft" loading={busy === 'install'} onClick={openInstallSettings}>
                Открыть системную настройку <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>

        {error && <Notice tone="bad">{error}</Notice>}
        <Notice tone="info">
          Мы не запрашиваем контакты, геолокацию, фотографии или широкий доступ к файлам.
          Любое разрешение можно изменить позже в настройках Android.
        </Notice>
        <Button variant="primary" size="lg" block onClick={close}>
          {notifications && canInstall ? 'Всё готово' : 'Продолжить'}
        </Button>
      </div>
    </Sheet>
  );
};
