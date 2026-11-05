package ru.pulsenet.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.util.AtomicFile;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.net.InetSocketAddress;
import java.net.Socket;

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

    /** Открывает системный установщик для скачанного файла. */
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

            if (kind.equals("unknown") && caps != null
                && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                // Публичного getUnderlyingNetworks() у приложения нет: это системный
                // API. Среди доступных подключённых сетей выбираем не-VPN транспорт.
                // Если Android скрывает его, возвращаем unknown, а не выдумываем Wi-Fi.
                for (Network network : manager.getAllNetworks()) {
                    if (network.equals(active)) continue;
                    NetworkCapabilities underlying = manager.getNetworkCapabilities(network);
                    if (underlying == null || underlying.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
                    kind = transportKind(underlying);
                    if (!kind.equals("unknown")) break;
                }
            }

            ret.put("connected", caps != null);
            ret.put("kind", kind);
            ret.put("vpn", caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
            call.resolve(ret);
        } catch (Exception e) {
            ret.put("connected", false);
            ret.put("kind", "unknown");
            ret.put("vpn", false);
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
                long started = System.currentTimeMillis();
                Socket socket = new Socket();
                try {
                    socket.connect(new InetSocketAddress(host, port), timeout);
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("latency_ms", (int) (System.currentTimeMillis() - started));
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
