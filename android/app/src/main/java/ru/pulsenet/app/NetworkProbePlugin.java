package ru.pulsenet.app;

import android.content.Context;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Сетевые измерения, которых не было в ApkUpdater.
 *
 * Главный принцип: приложение измеряет то, что реально может измерить, и
 * подписывает маршрут. TCP-connect внутри включённого TUN принимает локальный
 * VPN-клиент — это не задержка до сервера, поэтому проба узла умеет идти через
 * физическую сеть в обход туннеля (как tcping в v2rayNG), а «реальная задержка»
 * меряется HTTP-запросом сквозь активный туннель (как real delay в v2rayNG/NekoBox).
 */
@CapacitorPlugin(name = "NetworkProbe")
public class NetworkProbePlugin extends Plugin {

    private static final int HTML_LIMIT = 262144;
    private static final Map<String, AtomicBoolean> runningTasks = new ConcurrentHashMap<>();
    private static final String[] ECHO_SERVICES = {
        "https://api.ipify.org", "https://ifconfig.me/ip", "https://checkip.amazonaws.com",
        "https://ipv4.icanhazip.com", "https://ipinfo.io/ip",
    };

    private boolean flag(PluginCall call, String name) {
        Boolean value = call.getBoolean(name, false);
        return value != null && value;
    }

    /** Физическая сеть для прямого замера; null, если система её не отдаёт. */
    private Network probeNetwork(Context context, boolean bypassVpn) {
        if (!bypassVpn) return NetUtil.activeNetwork(context);
        return NetUtil.physicalNetwork(context);
    }

    private String routeName(Context context, Network network) {
        NetworkCapabilities caps = NetUtil.caps(context, network);
        if (caps == null) return "unknown";
        return NetUtil.isVpn(caps) ? "vpn" : NetUtil.isPhysical(caps) ? "direct" : "unknown";
    }

    // ---------------------------------------------------------------- HTTP

    /**
     * HTTP-проба сайта. Именно этого метода не хватало: JS вызывал
     * ApkUpdater.httpProbe(), в Java его не было, и любой сайт в APK получал
     * «не отвечает». Читает не больше 256 КиB и честно отдаёт код и финальный URL.
     */
    @PluginMethod
    public void httpProbe(final PluginCall call) {
        final String url = call.getString("url");
        final int timeout = call.getInt("timeoutMs", 8000);
        final boolean bypass = flag(call, "bypassVpn");
        if (url == null || url.isEmpty()) { call.reject("Не передан адрес проверки"); return; }
        final Context context = getContext();
        new Thread(new Runnable() {
            @Override public void run() {
                JSObject ret = new JSObject();
                long started = System.nanoTime();
                String current = url;
                HttpURLConnection connection = null;
                try {
                    Network network = probeNetwork(context, bypass);
                    if (bypass && network == null) throw new IOException("permission denied: физическая сеть недоступна (VPN lockdown)");
                    ret.put("route", routeName(context, network));
                    ret.put("vpn_package", NetUtil.vpnOwnerPackage(context, NetUtil.caps(context, NetUtil.activeNetwork(context))));
                    int status = 0;
                    // Общий бюджет на всю цепочку редиректов: раньше каждый хоп
                    // получал полный таймаут, и один сайт держал проверку до 6×timeout.
                    long deadlineMs = System.currentTimeMillis() + timeout;
                    for (int hop = 0; hop < 6; hop++) {
                        int left = (int) (deadlineMs - System.currentTimeMillis());
                        if (left < 250) throw new java.io.IOException("timeout: бюджет проверки исчерпан на редиректах");
                        connection = NetUtil.open(context, network, current, left, "GET");
                        status = connection.getResponseCode();
                        String location = connection.getHeaderField("Location");
                        if (status >= 300 && status < 400 && location != null && !location.isEmpty()) {
                            String next = new URL(new URL(current), location).toString();
                            closeQuietly(connection);
                            // Редирект на другой хост может увести на заглушку провайдера —
                            // сохраняем финальный адрес, чтобы проверка содержимого это увидела.
                            current = next;
                            continue;
                        }
                        break;
                    }
                    InputStream stream = NetUtil.body(connection);
                    byte[] data = stream == null ? new byte[0] : NetUtil.readLimited(stream, HTML_LIMIT + 1);
                    boolean truncated = data.length > HTML_LIMIT;
                    if (truncated) {
                        byte[] cut = new byte[HTML_LIMIT];
                        System.arraycopy(data, 0, cut, 0, HTML_LIMIT);
                        data = cut;
                    }
                    if (stream != null) try { stream.close(); } catch (Exception ignored) { }
                    String contentType = connection.getHeaderField("Content-Type");
                    ret.put("ok", true);
                    ret.put("status", status);
                    ret.put("url", current);
                    ret.put("content_type", contentType == null ? "" : contentType);
                    ret.put("data_base64", Base64.encodeToString(data, Base64.NO_WRAP));
                    ret.put("truncated", truncated);
                    ret.put("latency_ms", (System.nanoTime() - started) / 1_000_000.0d);
                    call.resolve(ret);
                } catch (Exception error) {
                    ret.put("ok", false);
                    ret.put("url", current);
                    ret.put("error", NetUtil.describeError(error));
                    ret.put("latency_ms", (System.nanoTime() - started) / 1_000_000.0d);
                    call.resolve(ret);
                } finally { closeQuietly(connection); }
            }
        }).start();
    }

    private static void closeQuietly(HttpURLConnection connection) {
        if (connection == null) return;
        try { connection.disconnect(); } catch (Exception ignored) { }
    }

    // ------------------------------------------------------------ VPN facts

    /** Системный VPN, VPN именно для этого приложения, всегда включённый клиент. */
    @PluginMethod
    public void vpnDiagnostics(PluginCall call) {
        Context context = getContext();
        JSObject ret = new JSObject();
        try {
            Network active = NetUtil.activeNetwork(context);
            NetworkCapabilities activeCaps = NetUtil.caps(context, active);
            Network vpn = NetUtil.anyVpnNetwork(context);
            NetworkCapabilities vpnCaps = vpn == null ? activeCaps : NetUtil.caps(context, vpn);
            boolean appUsesVpn = NetUtil.isVpn(activeCaps);
            boolean systemVpn = vpn != null || appUsesVpn;
            String owner = NetUtil.vpnOwnerPackage(context, NetUtil.isVpn(vpnCaps) ? vpnCaps : activeCaps);
            String alwaysOn = NetUtil.alwaysOnVpnApp(context);
            if (owner.isEmpty()) owner = alwaysOn;
            Network physical = NetUtil.physicalNetwork(context);
            ret.put("ok", true);
            ret.put("appUsesVpn", appUsesVpn);
            ret.put("systemVpn", systemVpn);
            // Раздельный туннель: VPN в системе есть, но наше приложение идёт мимо него.
            ret.put("splitTunnel", systemVpn && !appUsesVpn);
            ret.put("vpnPackage", owner);
            ret.put("vpnAppName", NetUtil.appLabel(context, owner));
            ret.put("alwaysOnApp", alwaysOn);
            ret.put("lockdown", NetUtil.alwaysOnLockdown(context));
            ret.put("bypassAvailable", physical != null);
            ret.put("physicalKind", NetUtil.transportKind(NetUtil.caps(context, physical)));
            ret.put("activeKind", NetUtil.transportKind(activeCaps));
            JSArray apps = new JSArray();
            for (String name : NetUtil.installedVpnApps(context)) {
                JSObject item = new JSObject();
                item.put("package", name);
                item.put("name", NetUtil.appLabel(context, name));
                apps.put(item);
            }
            ret.put("installedVpnApps", apps);
            call.resolve(ret);
        } catch (Exception error) {
            ret.put("ok", false);
            ret.put("error", NetUtil.describeError(error));
            call.resolve(ret);
        }
    }

    /** Совпадает ли внешний IP приложения с IP прямой сети: доказательство обхода туннеля. */
    @PluginMethod
    public void ipEcho(final PluginCall call) {
        final boolean bypass = flag(call, "bypassVpn");
        final int timeout = call.getInt("timeoutMs", 6000);
        final Context context = getContext();
        new Thread(new Runnable() {
            @Override public void run() {
                JSObject ret = new JSObject();
                String lastError = "";
                try {
                    Network network = probeNetwork(context, bypass);
                    ret.put("route", routeName(context, network));
                    if (bypass && network == null) throw new IOException("permission denied: физическая сеть недоступна");
                    for (String service : ECHO_SERVICES) {
                        HttpURLConnection connection = null;
                        long started = System.nanoTime();
                        try {
                            connection = NetUtil.open(context, network, service, timeout, "GET");
                            int status = connection.getResponseCode();
                            if (status < 200 || status >= 300) { lastError = "HTTP " + status; continue; }
                            InputStream stream = NetUtil.body(connection);
                            byte[] data = stream == null ? new byte[0] : NetUtil.readLimited(stream, 4096);
                            if (stream != null) try { stream.close(); } catch (Exception ignored) { }
                            String text = new String(data, StandardCharsets.UTF_8).trim();
                            String ip = extractIp(text);
                            if (ip.isEmpty()) { lastError = "сервис не вернул IP"; continue; }
                            ret.put("ok", true);
                            ret.put("ip", ip);
                            ret.put("source", service);
                            ret.put("latency_ms", (System.nanoTime() - started) / 1_000_000.0d);
                            call.resolve(ret);
                            return;
                        } catch (Exception error) {
                            lastError = NetUtil.describeError(error);
                        } finally { closeQuietly(connection); }
                    }
                    ret.put("ok", false);
                    ret.put("error", lastError.isEmpty() ? "сервисы IP недоступны" : lastError);
                    call.resolve(ret);
                } catch (Exception error) {
                    ret.put("ok", false);
                    ret.put("error", NetUtil.describeError(error));
                    call.resolve(ret);
                }
            }
        }).start();
    }

    static String extractIp(String text) {
        if (text == null) return "";
        String trimmed = text.trim();
        if (trimmed.length() > 200) trimmed = trimmed.substring(0, 200);
        java.util.regex.Matcher matcher = java.util.regex.Pattern
            .compile("(?:\\d{1,3}\\.){3}\\d{1,3}|[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}").matcher(trimmed);
        while (matcher.find()) {
            String value = matcher.group();
            if (value.indexOf(':') < 0) {
                String[] parts = value.split("\\.");
                boolean valid = parts.length == 4;
                for (String part : parts) {
                    try { if (Integer.parseInt(part) > 255) valid = false; } catch (Exception ignored) { valid = false; }
                }
                if (!valid) continue;
            } else if (value.replace(":", "").length() < 2) continue;
            try {
                // Литерал IP не вызывает DNS: строка уже проверена по форме.
                InetAddress address = InetAddress.getByName(value);
                String host = address.getHostAddress();
                if (host != null && !host.isEmpty()) return host;
            } catch (Exception ignored) { }
        }
        return "";
    }

    // ------------------------------------------------------------- TCP ping

    /**
     * TCP-connect до узла. При bypassVpn сокет и DNS привязываются к физической
     * сети, поэтому включённый VPN-клиент не может «ответить» за сервер локально.
     */
    @PluginMethod
    public void tcpProbe(final PluginCall call) {
        final String host = call.getString("host");
        final int port = call.getInt("port", 443);
        final int timeout = call.getInt("timeout", 4000);
        final boolean bypass = flag(call, "bypassVpn");
        if (host == null || host.isEmpty()) { call.reject("Не передан адрес сервера"); return; }
        final Context context = getContext();
        new Thread(new Runnable() {
            @Override public void run() {
                JSObject ret = new JSObject();
                Socket socket = null;
                try {
                    Network active = NetUtil.activeNetwork(context);
                    Network network = probeNetwork(context, bypass);
                    ret.put("vpn_package", NetUtil.vpnOwnerPackage(context, NetUtil.caps(context, active)));
                    if (bypass && network == null) {
                        ret.put("ok", false);
                        ret.put("route", "unknown");
                        ret.put("error", "permission denied: система не даёт прямую сеть мимо VPN");
                        call.resolve(ret);
                        return;
                    }
                    String route = routeName(context, network);
                    long dnsStarted = System.nanoTime();
                    InetAddress[] addresses = NetUtil.resolve(network, host);
                    long dnsUs = Math.max(0L, (System.nanoTime() - dnsStarted) / 1000L);
                    if (addresses.length == 0) throw new java.net.UnknownHostException("адрес не найден");
                    socket = network == null ? new Socket() : network.getSocketFactory().createSocket();
                    long started = System.nanoTime();
                    socket.connect(new InetSocketAddress(addresses[0], port), timeout);
                    long latencyUs = Math.max(0L, (System.nanoTime() - started) / 1000L);
                    boolean stillSame = network == null || network.equals(NetUtil.activeNetwork(context))
                        || bypass; // при обходе активная сеть может остаться VPN — это ожидаемо
                    double latencyMs = latencyUs / 1000.0d;
                    boolean localAccept = "vpn".equals(route) && latencyMs < 5;
                    ret.put("ok", stillSame);
                    ret.put("latency_us", latencyUs);
                    ret.put("latency_ms", latencyMs);
                    ret.put("dns_us", dnsUs);
                    ret.put("route", route);
                    ret.put("bypassed", bypass && "direct".equals(route));
                    ret.put("local_accept", localAccept);
                    ret.put("address", addresses[0].getHostAddress());
                    if (!stillSame) ret.put("error", "Сеть изменилась во время TCP-пробы — повторите");
                    else if (localAccept) ret.put("error", "Локальный ответ VPN-клиента: это не задержка до сервера");
                    call.resolve(ret);
                } catch (Exception error) {
                    ret.put("ok", false);
                    ret.put("error", NetUtil.describeError(error));
                    call.resolve(ret);
                } finally {
                    if (socket != null) try { socket.close(); } catch (Exception ignored) { }
                }
            }
        }).start();
    }

    // ----------------------------------------------------------- Real delay

    /**
     * «Реальная задержка» как в v2rayNG/NekoBox: HTTP-запрос generate_204 сквозь
     * активное подключение. Первый запрос разогревает соединение, дальше идёт
     *.median по keep-alive — без DNS и TLS-рукопожатия в каждом замере.
     */
    @PluginMethod
    public void realDelay(final PluginCall call) {
        final String url = call.getString("url", "https://www.gstatic.com/generate_204");
        final int timeout = call.getInt("timeoutMs", 8000);
        final int samples = Math.max(1, Math.min(7, call.getInt("samples", 4)));
        final Context context = getContext();
        new Thread(new Runnable() {
            @Override public void run() {
                JSObject ret = new JSObject();
                JSArray values = new JSArray();
                String lastError = "";
                int status = 0;
                Network network = NetUtil.activeNetwork(context);
                ret.put("route", routeName(context, network));
                for (int attempt = 0; attempt < samples + 1; attempt++) {
                    HttpURLConnection connection = null;
                    boolean failed = false;
                    try {
                        long started = System.nanoTime();
                        connection = NetUtil.open(context, network, url, timeout, "GET");
                        status = connection.getResponseCode();
                        InputStream stream = NetUtil.body(connection);
                        if (stream != null) {
                            NetUtil.readLimited(stream, 2048);
                            try { stream.close(); } catch (Exception ignored) { }
                        }
                        double ms = (System.nanoTime() - started) / 1_000_000.0d;
                        if (status >= 200 && status < 400 && attempt > 0) values.put(ms);
                        lastError = status >= 400 ? "HTTP " + status : "";
                    } catch (Exception error) {
                        failed = true;
                        lastError = NetUtil.describeError(error);
                    } finally {
                        // disconnect() закрывает сокет и ломает keep-alive, поэтому
                        // закрываем его только после ошибки: иначе следующий замер
                        // снова платил бы за TCP+TLS и показывал завышенный ping.
                        if (failed) closeQuietly(connection);
                    }
                }
                int count = values.length();
                if (count == 0) {
                    ret.put("ok", false);
                    ret.put("error", lastError.isEmpty() ? "цель не ответила" : lastError);
                    call.resolve(ret);
                    return;
                }
                double[] numbers = new double[count];
                for (int i = 0; i < count; i++) {
                    try { numbers[i] = values.getDouble(i); } catch (JSONException ignored) { numbers[i] = 0; }
                }
                java.util.Arrays.sort(numbers);
                double median = count % 2 == 1 ? numbers[count / 2] : (numbers[count / 2 - 1] + numbers[count / 2]) / 2.0d;
                ret.put("ok", true);
                ret.put("latency_ms", median);
                ret.put("min_ms", numbers[0]);
                ret.put("max_ms", numbers[count - 1]);
                ret.put("samples", values);
                ret.put("status", status);
                call.resolve(ret);
            }
        }).start();
    }

    // ------------------------------------------------------------ Speedtest

    @PluginMethod
    public void speedAbort(PluginCall call) {
        String runId = call.getString("runId", "");
        AtomicBoolean flag = runningTasks.get(runId);
        if (flag != null) flag.set(true);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /**
     * Одна фаза замера скорости: несколько параллельных соединений, общий
     * счётчик байт и семплер каждые 100 мс. Итоговую скорость считает TypeScript
     * по срезам (методика Ookla: отбросить 10% быстрых и 30% медленных срезов).
     */
    @PluginMethod
    public void speedPhase(final PluginCall call) {
        final String runId = call.getString("runId", "run");
        final String direction = call.getString("direction", "download");
        final JSArray urls = call.getArray("urls");
        final int connections = Math.max(1, Math.min(8, call.getInt("connections", 4)));
        final int durationMs = Math.max(1000, Math.min(30000, call.getInt("durationMs", 10000)));
        final int chunkBytes = Math.max(65536, Math.min(33554432, call.getInt("chunkBytes", 4194304)));
        final long maxBytes = call.getDouble("maxBytes", 104857600d).longValue();
        final int timeout = call.getInt("timeoutMs", 15000);
        if (urls == null || urls.length() == 0) { call.reject("Не переданы адреса замера"); return; }

        final Context context = getContext();
        final AtomicBoolean aborted = new AtomicBoolean(false);
        runningTasks.put(runId, aborted);
        final AtomicLong received = new AtomicLong();
        final AtomicLong confirmed = new AtomicLong();
        final AtomicLong completedRequests = new AtomicLong();
        final JSArray errors = new JSArray();
        final JSArray slices = new JSArray();
        final boolean upload = "upload".equals(direction);
        final String[] targets = new String[urls.length()];
        try {
            for (int i = 0; i < urls.length(); i++) targets[i] = urls.getString(i);
        } catch (JSONException error) { call.reject("Некорректный список адресов"); return; }

        new Thread(new Runnable() {
            @Override public void run() {
                final long startedAt = System.nanoTime();
                final Network network = NetUtil.activeNetwork(context);
                final String route = routeName(context, network);
                Thread sampler = new Thread(new Runnable() {
                    @Override public void run() {
                        while (!aborted.get()) {
                            double elapsed = (System.nanoTime() - startedAt) / 1_000_000.0d;
                            if (elapsed >= durationMs) break;
                            JSObject slice = new JSObject();
                            slice.put("t", elapsed);
                            slice.put("bytes", received.get());
                            slice.put("confirmed", confirmed.get());
                            slices.put(slice);
                            JSObject event = new JSObject();
                            event.put("runId", runId);
                            event.put("direction", direction);
                            event.put("elapsedMs", elapsed);
                            event.put("bytes", received.get());
                            event.put("confirmed", confirmed.get());
                            notifyListeners("speedSample", event);
                            try { Thread.sleep(100); } catch (InterruptedException ignored) { break; }
                        }
                    }
                });
                sampler.start();

                Thread[] workers = new Thread[connections];
                for (int index = 0; index < connections; index++) {
                    final int workerIndex = index;
                    workers[index] = new Thread(new Runnable() {
                        @Override public void run() {
                            byte[] payload = null;
                            if (upload) {
                                payload = new byte[32768];
                                // Несжимаемые данные: иначе провайдер/сервер сожмёт поток
                                // и «скорость» окажется скоростью компрессора.
                                java.util.Random random = new java.util.Random(31L + workerIndex);
                                random.nextBytes(payload);
                            }
                            while (!aborted.get()
                                && (System.nanoTime() - startedAt) / 1_000_000.0d < durationMs
                                && received.get() < maxBytes) {
                                String target = targets[workerIndex % targets.length];
                                HttpURLConnection connection = null;
                                try {
                                    String url = target + (target.contains("?") ? "&" : "?") + "pulse=" + System.nanoTime();
                                    connection = NetUtil.open(context, network, url, timeout, upload ? "POST" : "GET");
                                    if (upload) {
                                        connection.setDoOutput(true);
                                        connection.setFixedLengthStreamingMode(chunkBytes);
                                        connection.setRequestProperty("Content-Type", "application/octet-stream");
                                        OutputStream out = connection.getOutputStream();
                                        int written = 0;
                                        while (written < chunkBytes && !aborted.get()) {
                                            int size = Math.min(payload.length, chunkBytes - written);
                                            out.write(payload, 0, size);
                                            written += size;
                                            received.addAndGet(size);
                                        }
                                        out.flush();
                                        int status = connection.getResponseCode();
                                        if (status >= 200 && status < 300) {
                                            // Байты учитываются только после ответа сервера:
                                            // запись в сокет не доказывает доставку.
                                            confirmed.addAndGet(written);
                                            completedRequests.incrementAndGet();
                                        } else {
                                            synchronized (errors) { errors.put("HTTP " + status); }
                                            aborted.set(true);
                                        }
                                        InputStream stream = NetUtil.body(connection);
                                        if (stream != null) {
                                            NetUtil.readLimited(stream, 4096);
                                            try { stream.close(); } catch (Exception ignored) { }
                                        }
                                    } else {
                                        int status = connection.getResponseCode();
                                        if (status < 200 || status >= 300) {
                                            String retryAfter = connection.getHeaderField("Retry-After");
                                            synchronized (errors) {
                                                errors.put("HTTP " + status + (retryAfter == null ? "" : " Retry-After " + retryAfter));
                                            }
                                            aborted.set(true);
                                            break;
                                        }
                                        InputStream stream = connection.getInputStream();
                                        byte[] buffer = new byte[65536];
                                        int read;
                                        while (!aborted.get()
                                            && (System.nanoTime() - startedAt) / 1_000_000.0d < durationMs
                                            && (read = stream.read(buffer)) > 0) {
                                            received.addAndGet(read);
                                            confirmed.addAndGet(read);
                                            if (received.get() >= maxBytes) break;
                                        }
                                        try { stream.close(); } catch (Exception ignored) { }
                                        completedRequests.incrementAndGet();
                                    }
                                } catch (Exception error) {
                                    synchronized (errors) { errors.put(NetUtil.describeError(error)); }
                                    // Одна оборванная связь не отменяет фазу: остальные
                                    // соединения продолжают замер, ошибка попадёт в отчёт.
                                    if (completedRequests.get() == 0 && received.get() == 0) {
                                        try { Thread.sleep(200); } catch (InterruptedException ignored) { break; }
                                    }
                                } finally { closeQuietly(connection); }
                            }
                        }
                    });
                    workers[index].start();
                }
                for (Thread worker : workers) {
                    try { worker.join(durationMs + timeout + 2000L); } catch (InterruptedException ignored) { }
                }
                aborted.set(true);
                try { sampler.join(500); } catch (InterruptedException ignored) { }
                runningTasks.remove(runId);
                double elapsed = (System.nanoTime() - startedAt) / 1_000_000.0d;
                JSObject ret = new JSObject();
                ret.put("ok", confirmed.get() > 0);
                ret.put("bytes", received.get());
                ret.put("confirmed", confirmed.get());
                ret.put("elapsedMs", elapsed);
                ret.put("requests", completedRequests.get());
                ret.put("connections", connections);
                ret.put("route", route);
                ret.put("slices", slices);
                ret.put("errors", errors);
                call.resolve(ret);
            }
        }).start();
    }
}
