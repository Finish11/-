package ru.pulsenet.app;

import android.content.Context;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.telephony.TelephonyManager;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.zip.GZIPInputStream;

/**
 * Общие сетевые примитивы для плагинов.
 *
 * Здесь важно различать два разных факта:
 *  - VPN включён в системе (сеть с TRANSPORT_VPN существует);
 *  - трафик ЭТОГО приложения идёт через VPN (активная сеть приложения — VPN).
 * При раздельном туннеле (per-app proxy в v2rayNG / NekoBox / Happ) это разные
 * вещи, и путать их нельзя: иначе замеры подписываются чужим маршрутом.
 */
final class NetUtil {
    private NetUtil() { }

    static ConnectivityManager manager(Context context) {
        return (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    static Network activeNetwork(Context context) {
        ConnectivityManager manager = manager(context);
        return manager == null ? null : manager.getActiveNetwork();
    }

    static NetworkCapabilities caps(Context context, Network network) {
        ConnectivityManager manager = manager(context);
        if (manager == null || network == null) return null;
        try { return manager.getNetworkCapabilities(network); } catch (Exception ignored) { return null; }
    }

    static boolean isVpn(NetworkCapabilities caps) {
        return caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
    }

    static boolean isPhysical(NetworkCapabilities caps) {
        if (caps == null || isVpn(caps)) return false;
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            || caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
            || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
    }

    static String transportKind(NetworkCapabilities caps) {
        if (caps == null) return "unknown";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi";
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "ethernet";
        return "unknown";
    }

    @SuppressWarnings("deprecation")
    static Network[] allNetworks(Context context) {
        ConnectivityManager manager = manager(context);
        if (manager == null) return new Network[0];
        try {
            Network[] networks = manager.getAllNetworks();
            return networks == null ? new Network[0] : networks;
        } catch (Exception ignored) { return new Network[0]; }
    }

    /** Сеть стороннего VPN-клиента, если она видна приложению. */
    static Network anyVpnNetwork(Context context) {
        for (Network network : allNetworks(context)) {
            if (isVpn(caps(context, network))) return network;
        }
        return null;
    }

    /**
     * Физическая сеть (Wi-Fi/LTE) под VPN. Нужна, чтобы измерить задержку до узла
     * напрямую: TCP-connect внутри TUN принимает сам VPN-клиент, и это не RTT.
     */
    static Network physicalNetwork(Context context) {
        Network active = activeNetwork(context);
        NetworkCapabilities activeCaps = caps(context, active);
        if (isPhysical(activeCaps) && active != null
            && activeCaps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return active;
        Network best = null;
        for (Network network : allNetworks(context)) {
            NetworkCapabilities caps = caps(context, network);
            if (!isPhysical(caps) || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue;
            // Wi-Fi предпочтительнее сотовой: не тратим мобильный трафик зря.
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return network;
            best = network;
        }
        return best;
    }

    /** Пакет-владелец VPN. Требует <queries> с android.net.VpnService в манифесте. */
    static String vpnOwnerPackage(Context context, NetworkCapabilities caps) {
        if (!isVpn(caps) || Build.VERSION.SDK_INT < 29) return "";
        try {
            int uid = caps.getOwnerUid();
            String[] packages = context.getPackageManager().getPackagesForUid(uid);
            if (packages != null) {
                for (String name : packages) {
                    if (name != null && !name.equals(context.getPackageName())) return name;
                }
            }
        } catch (Exception ignored) { }
        return "";
    }

    /** Always-on VPN из системных настроек: запасной путь, если UID не виден. */
    static String alwaysOnVpnApp(Context context) {
        try {
            String value = Settings.Secure.getString(context.getContentResolver(), "always_on_vpn_app");
            return value == null ? "" : value;
        } catch (Exception ignored) { return ""; }
    }

    static boolean alwaysOnLockdown(Context context) {
        try {
            return Settings.Secure.getInt(context.getContentResolver(), "always_on_vpn_lockdown", 0) == 1;
        } catch (Exception ignored) { return false; }
    }

    static String appLabel(Context context, String packageName) {
        if (packageName == null || packageName.isEmpty()) return "";
        try {
            PackageManager pm = context.getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString();
        } catch (Exception ignored) { return packageName; }
    }

    static String carrierName(Context context, String kind) {
        if (!"cellular".equals(kind)) return "";
        try {
            TelephonyManager telephony = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
            String name = telephony == null ? "" : telephony.getNetworkOperatorName();
            return name == null ? "" : name;
        } catch (Exception ignored) { return ""; }
    }

    /** Список установленных VPN-клиентов: пользователь может выбрать свой вручную. */
    static List<String> installedVpnApps(Context context) {
        List<String> result = new ArrayList<>();
        try {
            android.content.Intent intent = new android.content.Intent("android.net.VpnService");
            for (android.content.pm.ResolveInfo info : context.getPackageManager().queryIntentServices(intent, 0)) {
                if (info.serviceInfo == null || info.serviceInfo.packageName == null) continue;
                String name = info.serviceInfo.packageName;
                if (!name.equals(context.getPackageName()) && !result.contains(name)) result.add(name);
            }
        } catch (Exception ignored) { }
        return result;
    }

    static HttpURLConnection open(Context context, Network network, String url, int timeoutMs, String method) throws IOException {
        URL target = new URL(url);
        HttpURLConnection connection = network == null
            ? (HttpURLConnection) target.openConnection()
            : (HttpURLConnection) network.openConnection(target);
        connection.setConnectTimeout(timeoutMs);
        connection.setReadTimeout(timeoutMs);
        connection.setRequestMethod(method);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("User-Agent", "PulseNet/1.6 (Android; network diagnostics)");
        connection.setRequestProperty("Accept", "*/*");
        connection.setRequestProperty("Accept-Encoding", "gzip");
        connection.setRequestProperty("Cache-Control", "no-cache");
        return connection;
    }

    /** Читает не больше limit байт — карточке сайта не нужен весь мегабайт HTML. */
    static byte[] readLimited(InputStream stream, int limit) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[16384];
        int read;
        while (buffer.size() < limit && (read = stream.read(chunk, 0, Math.min(chunk.length, limit - buffer.size()))) > 0) {
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    static InputStream body(HttpURLConnection connection) throws IOException {
        InputStream raw;
        try { raw = connection.getInputStream(); } catch (IOException ignored) { raw = connection.getErrorStream(); }
        if (raw == null) return null;
        String encoding = connection.getContentEncoding();
        return encoding != null && encoding.toLowerCase(Locale.ROOT).contains("gzip") ? new GZIPInputStream(raw) : raw;
    }

    /** Приводит ошибки Java к словам, которые понимает классификатор в TypeScript. */
    static String describeError(Exception error) {
        String message = error.getMessage() == null ? "" : error.getMessage();
        String lower = message.toLowerCase(Locale.ROOT);
        if (error instanceof java.net.UnknownHostException) return "DNS: домен не резолвится (" + message + ")";
        if (error instanceof java.net.SocketTimeoutException) return "timeout: сервер не ответил (" + message + ")";
        if (error instanceof javax.net.ssl.SSLException || error instanceof java.security.cert.CertificateException)
            return "TLS/certificate: " + (message.isEmpty() ? error.getClass().getSimpleName() : message);
        if (lower.contains("reset") || lower.contains("broken pipe") || lower.contains("aborted")) return "connection reset: " + message;
        if (lower.contains("cleartext")) return "cleartext not permitted: " + message;
        if (lower.contains("eacces") || lower.contains("permission denied") || lower.contains("operation not permitted"))
            return "permission denied: прямой доступ запрещён системой (VPN lockdown)";
        return message.isEmpty() ? error.getClass().getSimpleName() : message;
    }

    static InetAddress[] resolve(Network network, String host) throws IOException {
        return network == null ? InetAddress.getAllByName(host) : network.getAllByName(host);
    }

    static String hostOf(String url) {
        try { return new URL(url).getHost(); } catch (Exception ignored) { return Uri.parse(url).getHost(); }
    }
}
