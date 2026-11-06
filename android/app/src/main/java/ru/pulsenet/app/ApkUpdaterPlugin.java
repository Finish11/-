package ru.pulsenet.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.telephony.TelephonyManager;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.util.AtomicFile;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.HttpURLConnection;
import java.net.URI;
import java.util.Base64;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Загрузка обновлений APK средствами системы.
 *
 * JS-сторона: src/lib/apkUpdater.ts. Приложение просит скачать файл релиза,
 * опрашивает статус и открывает системный установщик. Никаких сторонних
 * разрешений, кроме REQUEST_INSTALL_PACKAGES, не нужно.
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

    private final Object networkLock = new Object();
    private ConnectivityManager.NetworkCallback defaultNetworkCallback;
    private Network defaultNetwork;
    private boolean networkCallbackRegistered;
    private String lastNetworkSignature = "";
    private long networkSequence;

    /**
     * Свой слушатель вместо перезапроса активной сети из Capacitor Network.
     * Android отдаёт актуальные capabilities прямо в onCapabilitiesChanged.
     */
    @Override
    public void load() {
        super.load();
        registerNetworkCallback();
    }

    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        registerNetworkCallback();
    }

    private void registerNetworkCallback() {
        synchronized (networkLock) {
            if (networkCallbackRegistered) return;
            ConnectivityManager manager = (ConnectivityManager) getContext()
                .getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) return;
            defaultNetworkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                    // Не вызываем здесь getActiveNetwork/getNetworkCapabilities:
                    // синхронный перезапрос может вернуть более старое состояние.
                    boolean vpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
                    String kind = transportKind(caps);
                    String carrier = carrierName(kind);
                    JSObject event = new JSObject();
                    synchronized (networkLock) {
                        defaultNetwork = network;
                        // Network ID отличает и смену двух сетей с одинаковым транспортом.
                        String signature = network.toString() + "|1|" + kind + "|" + vpn + "|" + vpnPackage(caps);
                        if (signature.equals(lastNetworkSignature)) return;
                        lastNetworkSignature = signature;
                        networkSequence += 1;
                        event.put("connected", true);
                        event.put("kind", kind);
                        event.put("vpn", vpn);
                        event.put("carrier", carrier);
                        event.put("vpnPackage", vpnPackage(caps));
                        event.put("vpnAppName", vpnAppName(caps));
                        event.put("sequence", networkSequence);
                    }
                    // Не держим networkLock во время вызова моста Capacitor.
                    notifyListeners("networkChanged", event, true);
                }

                @Override
                public void onLost(Network network) {
                    JSObject event = new JSObject();
                    synchronized (networkLock) {
                        // Старый Wi-Fi может завершиться уже после появления LTE.
                        // Такой onLost не должен стирать новый default network.
                        if (defaultNetwork == null || !network.equals(defaultNetwork)) return;
                        defaultNetwork = null;
                        lastNetworkSignature = network.toString() + "|0|none|false";
                        networkSequence += 1;
                        event.put("connected", false);
                        event.put("kind", "none");
                        event.put("vpn", false);
                        event.put("carrier", "");
                        event.put("sequence", networkSequence);
                    }
                    notifyListeners("networkChanged", event, true);
                }
            };
            try {
                manager.registerDefaultNetworkCallback(defaultNetworkCallback);
                networkCallbackRegistered = true;
            } catch (Exception ignored) {
                defaultNetworkCallback = null;
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (networkLock) {
            if (networkCallbackRegistered && defaultNetworkCallback != null) {
                try {
                    ConnectivityManager manager = (ConnectivityManager) getContext()
                        .getSystemService(Context.CONNECTIVITY_SERVICE);
                    if (manager != null) manager.unregisterNetworkCallback(defaultNetworkCallback);
                } catch (Exception ignored) {
                }
            }
            networkCallbackRegistered = false;
            defaultNetworkCallback = null;
            defaultNetwork = null;
        }
        super.handleOnDestroy();
    }

    private String carrierName(String kind) {
        if (!"cellular".equals(kind)) return "";
        try {
            TelephonyManager telephony = (TelephonyManager) getContext()
                .getSystemService(Context.TELEPHONY_SERVICE);
            if (telephony == null) return "";
            String name = telephony.getNetworkOperatorName();
            if (name == null || name.trim().isEmpty()) name = telephony.getSimOperatorName();
            return name == null ? "" : name.trim();
        } catch (Exception ignored) {
            return "";
        }
    }

    private DownloadManager downloadManager() {
        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String fileName = call.getString("fileName", "pulsenet-update.apk");

        if (url == null || url.isEmpty()) {
            call.reject("Не передан адрес APK");
            return;
        }
        if (!url.startsWith("https://")) {
            call.reject("Для безопасного обновления нужен HTTPS-адрес APK");
            return;
        }
        // subPath не должен позволять выйти из app-specific Downloads через ../
        // или передать DownloadManager неожиданный тип файла.
        if (fileName == null || !fileName.matches("[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.apk")) {
            call.reject("Некорректное имя APK-файла");
            return;
        }

        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle("ПульсСети");
            request.setDescription("Загрузка обновления");
            request.setMimeType("application/vnd.android.package-archive");
            request.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
            );
            request.setDestinationInExternalFilesDir(
                getContext(),
                Environment.DIRECTORY_DOWNLOADS,
                fileName
            );

            long id = downloadManager().enqueue(request);

            JSObject ret = new JSObject();
            ret.put("downloadId", id);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Не удалось начать загрузку: " + e.getMessage());
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        Long id = call.getLong("downloadId");
        if (id == null) {
            call.reject("Не передан downloadId");
            return;
        }

        DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
        JSObject ret = new JSObject();
        try (Cursor cursor = downloadManager().query(query)) {
            if (cursor == null || !cursor.moveToFirst()) {
                ret.put("state", 0);
                ret.put("progress", 0);
                call.resolve(ret);
                return;
            }
            int state = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long done = cursor.getLong(
                cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)
            );
            long total = cursor.getLong(
                cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
            );
            ret.put("state", state);
            ret.put("progress", total > 0 ? (int) Math.min(100, (done * 100) / total) : 0);
            ret.put("bytes", done);
            ret.put("total", total);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Не удалось узнать статус загрузки: " + e.getMessage());
        }
    }

    /** Права и системные настройки установки скачанного APK. */
    @PluginMethod
    public void getPermissionState(PluginCall call) {
        boolean canInstall = Build.VERSION.SDK_INT < 26
                || getContext().getPackageManager().canRequestPackageInstalls();
        JSObject ret = new JSObject();
        ret.put("canInstall", canInstall);
        ret.put("androidSdk", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Intent intent = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName())
                );
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("Не удалось открыть настройки установки", error);
        }
    }

    @PluginMethod
    public void install(PluginCall call) {
        Long id = call.getLong("downloadId");
        if (id == null) {
            call.reject("Не передан downloadId");
            return;
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
                // Пользователь должен разрешить установку из этого источника
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                settings.setData(Uri.parse("package:" + getContext().getPackageName()));
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(settings);

                JSObject ret = new JSObject();
                ret.put("needsPermission", true);
                call.resolve(ret);
                return;
            }

            Uri apkUri = downloadManager().getUriForDownloadedFile(id);
            if (apkUri == null) {
                call.reject("Файл ещё не скачан");
                return;
            }

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            JSObject ret = new JSObject();
            ret.put("needsPermission", false);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Не удалось открыть установщик: " + e.getMessage());
        }
    }

    /** Запуск официального приложения для ручной проверки пользователем. */
    @PluginMethod
    public void openInstalledApp(PluginCall call) {
        String packageName = call.getString("packageName", "");
        JSObject ret = new JSObject();
        if (packageName == null || !packageName.matches("[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)+")) {
            call.reject("Некорректное имя пакета");
            return;
        }
        try {
            Intent intent = getContext().getPackageManager().getLaunchIntentForPackage(packageName);
            if (intent == null) {
                ret.put("opened", false);
                ret.put("installed", false);
                call.resolve(ret);
                return;
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            ret.put("opened", true);
            ret.put("installed", true);
            ret.put("packageName", packageName);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Не удалось открыть приложение: " + e.getMessage());
        }
    }

    /** Владелец системного VPN — имя клиента, НЕ выбранный внутри него сервер. */
    private String vpnPackage(NetworkCapabilities caps) {
        if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) || Build.VERSION.SDK_INT < 29) return "";
        try {
            String[] packages = getContext().getPackageManager().getPackagesForUid(caps.getOwnerUid());
            if (packages == null) return "";
            for (String name : packages) if (name != null && !name.equals(getContext().getPackageName())) return name;
        } catch (Exception ignored) { }
        return "";
    }
    private String vpnAppName(NetworkCapabilities caps) {
        String name = vpnPackage(caps); if (name.isEmpty()) return "";
        try { PackageManager pm = getContext().getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(name, 0)).toString();
        } catch (Exception ignored) { return name; }
    }

    private String transportKind(NetworkCapabilities caps) {
        if (caps == null) return "unknown";
        // Проверяем реальный транспорт до TRANSPORT_VPN: иначе мобильный
        // интернет под туннелем ошибочно подписывается как Wi-Fi.
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "ethernet";
        return "unknown";
    }

    /** Физический транспорт активного соединения, включая underlying networks VPN. */
    @PluginMethod
    public void networkKind(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            ConnectivityManager manager = (ConnectivityManager) getContext()
                .getSystemService(Context.CONNECTIVITY_SERVICE);
            Network active = manager == null ? null : manager.getActiveNetwork();
            NetworkCapabilities caps = active == null ? null : manager.getNetworkCapabilities(active);
            String kind = transportKind(caps);

            // Android сам добавляет underlying Wi-Fi/LTE transports в capabilities
            // VPN, когда они известны. Перебирать getAllNetworks() и выбирать первую
            // не-VPN сеть нельзя: рядом может остаться неиспользуемый Wi-Fi.
            // Если система дала только TRANSPORT_VPN, честно остаётся unknown.
            boolean connected = caps != null;
            ret.put("systemKnown", true);
            ret.put("connected", connected);
            ret.put("kind", connected ? kind : "none");
            ret.put("vpn", connected && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
            ret.put("carrier", connected ? carrierName(kind) : "");
            ret.put("vpnPackage", connected ? vpnPackage(caps) : "");
            ret.put("vpnAppName", connected ? vpnAppName(caps) : "");
            synchronized (networkLock) {
                ret.put("sequence", networkSequence);
            }
            call.resolve(ret);
        } catch (Exception e) {
            ret.put("systemKnown", false);
            ret.put("connected", false);
            ret.put("kind", "unknown");
            ret.put("vpn", false);
            ret.put("carrier", "");
            call.resolve(ret);
        }
    }

    private File stateFile() {
        return new File(getContext().getFilesDir(), "pulsenet-state-v1.json");
    }

    /** Читает независимую резервную копию состояния из внутренней памяти приложения. */
    @PluginMethod
    public void stateRead(PluginCall call) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                FileInputStream input = null;
                try {
                    File file = stateFile();
                    JSObject ret = new JSObject();
                    ret.put("exists", file.exists());
                    if (!file.exists()) {
                        ret.put("value", "");
                        call.resolve(ret);
                        return;
                    }
                    input = new FileInputStream(file);
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    ret.put("value", output.toString("UTF-8"));
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("Не удалось прочитать резервную копию: " + e.getMessage());
                } finally {
                    if (input != null) {
                        try { input.close(); } catch (Exception ignored) { }
                    }
                }
            }
        }, "pulsenet-state-read").start();
    }

    /** Атомарно сохраняет состояние: обрыв записи не портит предыдущую копию. */
    @PluginMethod
    public void stateWrite(PluginCall call) {
        final String value = call.getString("value");
        if (value == null) {
            call.reject("Не передано состояние для сохранения");
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                AtomicFile atomic = new AtomicFile(stateFile());
                FileOutputStream output = null;
                try {
                    output = atomic.startWrite();
                    output.write(value.getBytes(StandardCharsets.UTF_8));
                    output.flush();
                    atomic.finishWrite(output);
                    output = null;
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("bytes", value.getBytes(StandardCharsets.UTF_8).length);
                    call.resolve(ret);
                } catch (Exception e) {
                    if (output != null) atomic.failWrite(output);
                    call.reject("Не удалось сохранить резервную копию: " + e.getMessage());
                }
            }
        }, "pulsenet-state-write").start();
    }

    /**
     * TCP-проба до игрового сервера: реальный пинг по порту, без HTTP.
     * Используется для игр (Brawl Stars — TCP 9339), где HTTP-запрос ничего не значит.
     */
    @PluginMethod
    public void tcpProbe(PluginCall call) {
        final String host = call.getString("host");
        Integer portValue = call.getInt("port", 9339);
        Integer timeoutValue = call.getInt("timeout", 5000);
        if (host == null || host.isEmpty() || portValue == null) {
            call.reject("Не передан адрес сервера");
            return;
        }
        final int port = portValue;
        final int timeout = timeoutValue == null ? 5000 : timeoutValue;

        new Thread(new Runnable() {
            @Override
            public void run() {
                Socket socket = new Socket();
                try {
                    ConnectivityManager manager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
                    Network before = manager == null ? null : manager.getActiveNetwork();
                    NetworkCapabilities beforeCaps = before == null ? null : manager.getNetworkCapabilities(before);
                    long dnsStarted = System.nanoTime();
                    InetSocketAddress address = new InetSocketAddress(host, port);
                    long dnsUs = Math.max(0L, (System.nanoTime() - dnsStarted) / 1000L);
                    if (address.isUnresolved()) throw new java.net.UnknownHostException("DNS: адрес не найден");
                    long started = System.nanoTime();
                    if (before != null) socket = before.getSocketFactory().createSocket();
                    socket.connect(address, timeout);
                    long latencyUs = Math.max(0L, (System.nanoTime() - started) / 1000L);
                    Network after = manager == null ? null : manager.getActiveNetwork();
                    NetworkCapabilities afterCaps = after == null ? null : manager.getNetworkCapabilities(after);
                    boolean changed = before == null || !before.equals(after) || beforeCaps == null || afterCaps == null
                        || beforeCaps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) != afterCaps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                        || !vpnPackage(beforeCaps).equals(vpnPackage(afterCaps));
                    JSObject ret = new JSObject();
                    ret.put("ok", !changed); ret.put("latency_us", latencyUs); ret.put("latency_ms", latencyUs / 1000.0d);
                    ret.put("dns_us", dnsUs); ret.put("vpn_package", vpnPackage(beforeCaps));
                    ret.put("route", afterCaps != null && afterCaps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ? "vpn" : "direct");
                    if (changed) ret.put("error", "Сеть изменилась во время TCP-пробы — повторите");
                    call.resolve(ret);
                } catch (Exception e) {
                    JSObject ret = new JSObject();
                    ret.put("ok", false);
                    ret.put("error", e.getMessage() == null ? "нет соединения" : e.getMessage());
                    call.resolve(ret);
                } finally {
                    try {
                        socket.close();
                    } catch (Exception ignored) {
                        // закрытие не критично
                    }
                }
            }
        }).start();
    }
}
