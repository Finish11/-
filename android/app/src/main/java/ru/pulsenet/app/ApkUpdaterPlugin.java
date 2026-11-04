package ru.pulsenet.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

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

            // DownloadManager отдаёт свой content://-Uri, который системный
            // установщик часто не может прочитать. Копируем файл в кэш приложения
            // и отдаём его через FileProvider — так установщик открывается стабильно.
            File apk = new File(getContext().getCacheDir(), "pulsenet-update.apk");
            InputStream in = downloadManager().openDownloadedFile(id);
            if (in == null) {
                call.reject("Файл ещё не скачан");
                return;
            }
            try (InputStream source = in; OutputStream target = new FileOutputStream(apk)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = source.read(buffer)) != -1) {
                    target.write(buffer, 0, read);
                }
            }
            if (!apk.exists() || apk.length() < 1024 * 1024) {
                call.reject("Скачанный файл повреждён или слишком мал — скачайте ещё раз");
                return;
            }

            Uri apkUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apk
            );

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
}
