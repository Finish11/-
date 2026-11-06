import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diagnoseScan, evaluateScanVerdict } from '../src/lib/scanner.ts';
import { parseSubscriptionText } from '../src/lib/subscriptionParser.ts';
import { assessSiteContent } from '../src/lib/siteContent.ts';
import { canonicalServiceProbeUrl } from '../src/lib/siteProbe.ts';
import { emptyGeo, hasSameNetworkAttribution, isNewerNetworkSequence, networkSnapshotKey, resolveVpnStatus } from '../src/lib/networkInfo.ts';
import type { NativeNetworkState } from '../src/lib/nativeBridge.ts';
import { decodeStatePacket, encodeStatePacket, selectNewestState } from '../src/demo/stateStorage.ts';
import { applyServiceAccessPolicy } from '../src/lib/serviceAccess.ts';
import { orderSitesForScan } from '../src/lib/scanScheduler.ts';
import { applyNodeMeasurements, formatTcpLatency, type NodeMeasurement } from '../src/lib/nodePing.ts';
import { compareVersions } from '../src/lib/appUpdate.ts';
import { findAppConfirmation, recommendConfirmedNodes } from '../src/lib/appConfirmations.ts';
import { communitySyncChanged, normalizeCommunityEndpoint, reconcileCommunitySync } from '../src/lib/community.ts';
import type { AppConfirmation, Incident, VpnProfile } from '../src/types.ts';
import type { ScanSiteResult, Site } from '../src/types.ts';

function site(id: number, role: Site['marker_role'] = 'global_neutral'): Site {
  return {
    id,
    user_id: 1,
    name: `Сайт ${id}`,
    domain: `site${id}.example`,
    probe_url: `https://site${id}.example/favicon.ico`,
    category: role === 'ru_whitelist' ? 'ru_whitelist' : role === 'dpi_target' ? 'dev_ai_vpn' : 'global_infra',
    marker_role: role,
    enabled: 1,
    accessibility: role === 'dpi_target' ? 'blocked' : 'ok',
    last_status: 'unknown',
    last_latency_ms: null,
    last_checked_at: null,
    description: '',
    created_at: '',
  };
}

function vpnProfile(id: number, name: string, latency: number): VpnProfile {
  return {
    id, user_id: 1, name, protocol: 'VLESS', location: 'NL', country_code: 'NL',
    host: `${name}.example`, port: 443, provider: '', dpi_resistance: 'high',
    whitelist_bypass: true, status: 'online', latency_ms: latency, uptime_pct: 100,
    is_primary: false, notes: '', last_checked_at: null, created_at: '',
  };
}

function confirmation(profileId: number | null, serviceId: string, ip: string, works: boolean, at: string): AppConfirmation {
  return {
    id: 1, service_id: serviceId, domain: `${serviceId}.example`,
    node_key: profileId == null ? 'direct' : `vpn:${profileId}`, profile_id: profileId,
    profile_name: profileId == null ? 'Прямое подключение' : `node-${profileId}`,
    exit_ip: ip, works, confirmed_at: at,
  };
}

function result(id: number, role: Site['marker_role'], intercepted = false): ScanSiteResult {
  return {
    site_id: id,
    name: `Сайт ${id}`,
    domain: `site${id}.example`,
    category: role === 'ru_whitelist' ? 'ru_whitelist' : role === 'dpi_target' ? 'dev_ai_vpn' : 'global_infra',
    marker_role: role,
    status: intercepted ? 'ok' : 'ok',
    intercepted,
    latency_ms: intercepted ? 20 : 50,
  };
}

test('подмена TLS не считается открытым сайтом и не даёт свободный интернет', () => {
  const sites = new Map([[1, site(1)], [2, site(2)]]);
  const results = [result(1, 'global_neutral', true), result(2, 'global_neutral', true)];
  const diagnosis = diagnoseScan(results, sites, { withVpn: false });
  assert.equal(diagnosis.global_ok_pct, 0);
  assert.equal(diagnosis.scenario, 'partial');
  assert.match(diagnosis.details, /заглушка или чужой TLS-сертификат/);
  const verdict = evaluateScanVerdict(results, false, sites);
  assert.equal(verdict.verdict, 'SEVERE_RESTRICTIONS');
  assert.equal(verdict.ok_sites, 0);
  assert.equal(verdict.blocked_sites, 2);
});

test('ChatGPT без VPN на RU-IP получает справочное региональное ограничение, не успех и не РКН', () => {
  const chat = { ...site(90, 'dpi_target'), domain: 'chatgpt.com' };
  const measured = { ...result(90, 'dpi_target'), domain: 'chatgpt.com', proof: 'app' as const };
  const actual = applyServiceAccessPolicy(chat, measured, { withVpn: false, countryCode: 'RU' });
  assert.equal(actual.status, 'blocked');
  assert.equal(actual.block_reason, 'provider_region');
  assert.equal(actual.access_scope, 'provider_region_ru');
  assert.equal(actual.latency_ms, null);
  assert.match(actual.source_url || '', /help\.openai\.com/);
  assert.doesNotMatch(actual.note || '', /это блок РКН/i);
});

test('Claude и WhatsApp через VPN при нераспознанном ответе не получают ложный достоверный отказ', () => {
  for (const [id, domain] of [[91, 'claude.ai'], [92, 'web.whatsapp.com']] as const) {
    const target = { ...site(id, 'dpi_target'), domain };
    const measured = {
      ...result(id, 'dpi_target'),
      domain,
      status: 'blocked' as const,
      latency_ms: null,
      intercepted: true,
      block_reason: 'throttled' as const,
    };
    const actual = applyServiceAccessPolicy(target, measured, { withVpn: true, countryCode: 'NL' });
    assert.equal(actual.access_scope, 'app_unconfirmed');
    assert.equal(actual.block_reason, 'unknown');
    assert.equal(actual.intercepted, false);
    assert.match(actual.note || '', /не доказательство блокировки/i);
  }
});

test('сводный вердикт сохраняет региональную причину и не перезаписывает её групповым РКН', () => {
  const chat = { ...site(94, 'dpi_target'), domain: 'chatgpt.com', accessibility: 'blocked' as const };
  const measured = applyServiceAccessPolicy(
    chat,
    { ...result(94, 'dpi_target'), domain: 'chatgpt.com', proof: 'app' as const },
    { withVpn: false, countryCode: 'RU' }
  );
  const evaluated = evaluateScanVerdict([measured], false, new Map([[94, chat]]));
  const highlighted = evaluated.diagnosis.highlight_blocked.find((item) => item.domain === 'chatgpt.com');
  assert.equal(highlighted?.block_reason, 'provider_region');
  assert.equal(highlighted?.access_scope, 'provider_region_ru');
  assert.match(highlighted?.source_url || '', /help\.openai\.com/);
  assert.doesNotMatch(evaluated.diagnosis.headline, /РКН/);
});

test('справочный RU-статус не создаёт DPI-паттерн при живом нейтральном интернете', () => {
  const chat = { ...site(95, 'dpi_target'), domain: 'chatgpt.com', accessibility: 'blocked' as const };
  const neutral = site(96);
  const reference = applyServiceAccessPolicy(
    chat,
    { ...result(95, 'dpi_target'), domain: 'chatgpt.com' },
    { withVpn: false, countryCode: 'RU' }
  );
  const evaluated = evaluateScanVerdict(
    [reference, result(96, 'global_neutral')],
    false,
    new Map([[95, chat], [96, neutral]])
  );
  assert.equal(evaluated.diagnosis.dpi_pattern, false);
  assert.equal(evaluated.diagnosis.scenario, 'open');
  assert.equal(evaluated.diagnosis.blocked_total, 0);
  assert.equal(evaluated.diagnosis.highlight_blocked[0]?.block_reason, 'provider_region');
});

test('неотвечающая dpi_target не даёт автоматический заголовок ТСПУ или РКН', () => {
  const limited = site(97, 'dpi_target');
  const neutral = site(98);
  const unavailable = {
    ...result(97, 'dpi_target'),
    status: 'blocked' as const,
    latency_ms: null,
    block_reason: 'network' as const,
  };
  const evaluated = evaluateScanVerdict(
    [unavailable, result(98, 'global_neutral')],
    false,
    new Map([[97, limited], [98, neutral]])
  );
  assert.equal(evaluated.diagnosis.scenario, 'dpi');
  assert.equal(evaluated.verdict_title, 'Часть сервисов ограничена');
  assert.doesNotMatch(evaluated.verdict_title, /ТСПУ|РКН/);
});

test('открытая страница Gemini через VPN не выдаётся за работу приложения', () => {
  const gemini = { ...site(93, 'dpi_target'), domain: 'gemini.google.com' };
  const measured = { ...result(93, 'dpi_target'), domain: 'gemini.google.com', proof: 'app' as const };
  const actual = applyServiceAccessPolicy(gemini, measured, { withVpn: true, countryCode: 'DE' });
  assert.equal(actual.status, 'ok');
  assert.equal(actual.proof, 'page');
  assert.equal(actual.access_scope, 'web_only');
  assert.match(actual.note || '', /приложение.*не проверяются/i);
});

test('прежние таймауты и DPI-цели стартуют раньше быстрых сайтов без потери стабильности', () => {
  const fast = { ...site(101), last_status: 'ok' as const, last_latency_ms: 40, last_checked_at: '2026-01-01' };
  const slow = { ...site(102), last_status: 'blocked' as const, last_checked_at: '2026-01-01' };
  const dpi = { ...site(103, 'dpi_target'), last_status: 'ok' as const, last_latency_ms: 30, last_checked_at: '2026-01-01' };
  const equalA = site(104);
  const equalB = site(105);
  const ordered = orderSitesForScan([fast, equalA, equalB, dpi, slow]);
  assert.equal(ordered[0].id, slow.id);
  assert.ok(ordered.findIndex((item) => item.id === dpi.id) < ordered.findIndex((item) => item.id === fast.id));
  assert.ok(ordered.findIndex((item) => item.id === equalA.id) < ordered.findIndex((item) => item.id === equalB.id));
});

test('TCP ping никогда не показывает сомнительный ноль как международный RTT', () => {
  assert.equal(formatTcpLatency(0), '<1 мс');
  assert.equal(formatTcpLatency(0.42), '<1 мс');
  assert.equal(formatTcpLatency(12.4), '12 мс');
  assert.equal(formatTcpLatency(null), '—');
});

test('проверка обновления сравнивает числовые части версий без строковой ошибки', () => {
  assert.ok(compareVersions('1.5.10', '1.5.9') > 0);
  assert.ok(compareVersions('1.5.5', '1.5.5') === 0);
  assert.ok(compareVersions('1.5.4', '1.5.5') < 0);
  assert.ok(compareVersions('2.0', '1.9.9') > 0);
});

test('подтверждение приложения привязано к VPN/IP, а совпадение IP не выдаётся за проверку другого узла', () => {
  const saved = confirmation(7, 'chatgpt', '1.2.3.4', true, '2026-11-06T10:00:00.000Z');
  const exact = findAppConfirmation([saved], 'chatgpt', vpnProfile(7, 'node-7', 40), '1.2.3.4');
  assert.equal(exact?.matchedBy, 'node_ip');
  const sameIp = findAppConfirmation([saved], 'chatgpt', vpnProfile(8, 'node-8', 30), '1.2.3.4');
  assert.equal(sameIp?.matchedBy, 'ip');
  assert.equal(findAppConfirmation([saved], 'chatgpt', vpnProfile(8, 'node-8', 30), '5.6.7.8'), null);
  assert.equal(findAppConfirmation([saved], 'chatgpt', null, '1.2.3.4'), null);
});

test('рекомендации VPN учитывают последний отзыв и покрытие сервисов, а не только пинг', () => {
  const first = vpnProfile(1, 'fast', 20);
  const second = vpnProfile(2, 'coverage', 50);
  const third = vpnProfile(3, 'failing', 10);
  const records = [
    confirmation(1, 'chatgpt', '1.1.1.1', true, '2026-11-01'),
    confirmation(2, 'chatgpt', '2.2.2.2', true, '2026-11-01'),
    confirmation(2, 'youtube', '2.2.2.2', true, '2026-11-02'),
    confirmation(3, 'chatgpt', '3.3.3.3', false, '2026-11-02'),
    confirmation(3, 'youtube', '3.3.3.3', true, '2026-11-02'),
  ];
  const ranked = recommendConfirmedNodes([first, second, third], records);
  assert.deepEqual(ranked.map((item) => item.profile.id), [2, 1, 3]);
  assert.equal(ranked[0].works, 2);
  // Новый отрицательный отзыв заменяет старый положительный для того же сервиса.
  const changed = recommendConfirmedNodes([first], [records[0], confirmation(1, 'chatgpt', '4.4.4.4', false, '2026-11-03')]);
  assert.equal(changed.length, 0);
});

function incident(id: number, clientId: string): Incident {
  return {
    id, user_id: null, author_name: 'Пользователь', region: 'Москва и МО', carrier: 'МТС',
    incident_type: 'whitelist', severity: 'high', status: 'active', title: clientId,
    description: '', upvotes: 1, ru_sites_ok: true, foreign_sites_ok: false,
    user_upvoted: true, is_owner: true, created_at: `2026-11-06T10:00:0${id % 10}.000Z`,
    client_id: clientId, sync_state: 'pending',
  };
}

test('синхронизация не стирает добавления, изменения и удаления, сделанные во время запроса', () => {
  const old = incident(100, 'inc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const unchanged = incident(101, 'inc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const snapshot = [old, unchanged];
  const added = incident(102, 'inc_cccccccccccccccccccccccccccccccc');
  const edited = { ...unchanged, title: 'Изменено во время запроса', sync_state: 'error' as const };
  const current = [edited, added]; // old удалён, unchanged изменён, added создан
  const synced = [
    { ...old, sync_state: 'synced' as const },
    { ...unchanged, title: 'Ответ сервера', sync_state: 'synced' as const },
    { ...incident(103, 'inc_dddddddddddddddddddddddddddddddd'), sync_state: 'synced' as const },
  ];
  assert.equal(communitySyncChanged(snapshot, current), true);
  const result = reconcileCommunitySync(snapshot, current, synced);
  assert.equal(result.some((item) => item.client_id === old.client_id), false);
  assert.equal(result.find((item) => item.client_id === unchanged.client_id)?.title, 'Изменено во время запроса');
  assert.equal(result.some((item) => item.client_id === added.client_id), true);
  assert.equal(result.some((item) => item.client_id === synced[2].client_id), true);
  assert.equal(communitySyncChanged(snapshot, snapshot), false);
});

test('общий сервер требует HTTPS и нормализует адрес без скрытых параметров', () => {
  assert.equal(normalizeCommunityEndpoint(' https://community.example/ '), 'https://community.example');
  assert.equal(normalizeCommunityEndpoint('http://127.0.0.1:3100/'), 'http://127.0.0.1:3100');
  assert.equal(normalizeCommunityEndpoint(''), '');
  assert.throws(() => normalizeCommunityEndpoint('http://community.example'), /HTTPS/);
  assert.throws(() => normalizeCommunityEndpoint('https://user:secret@community.example'), /без логина/);
  assert.throws(() => normalizeCommunityEndpoint('https://community.example/?token=secret'), /без логина/);
});

test('справочный сервисный вердикт сохраняет фактический статус страницы для каталога', () => {
  const chat = { ...site(96, 'dpi_target'), domain: 'chatgpt.com' };
  const measured = applyServiceAccessPolicy(
    chat,
    { ...result(96, 'dpi_target'), domain: 'chatgpt.com', proof: 'app' as const },
    { withVpn: false, countryCode: 'RU' }
  );
  assert.equal(measured.status, 'blocked');
  assert.equal(measured.network_status, 'ok');
  assert.equal(measured.network_latency_ms, 50);
});

test('партия TCP обновляет известные узлы, сохраняет дробные мс и не принимает NaN', () => {
  const profiles: Array<{
    id: number;
    status: 'online' | 'degraded' | 'blocked' | 'unknown';
    latency_ms: number | null;
    notes: string;
    last_checked_at: string | null;
    name: string;
  }> = [
    { id: 1, status: 'online', latency_ms: 30, notes: '', last_checked_at: null, name: 'A' },
    { id: 2, status: 'unknown', latency_ms: null, notes: '', last_checked_at: null, name: 'B' },
  ];
  const measurements: NodeMeasurement[] = [
    { id: 2, status: 'online', latencyMs: 0.42, reason: 'TCP через VPN', checkedAt: '2026-11-06' },
    { id: 1, status: 'blocked', latencyMs: Number.NaN, reason: 'таймаут', checkedAt: '2026-11-06' },
    { id: 999, status: 'online', latencyMs: 1, reason: '', checkedAt: '2026-11-06' },
  ];
  const actual = applyNodeMeasurements(profiles, measurements);
  assert.equal(actual.length, 2);
  assert.equal(actual[1].latency_ms, 0.42);
  assert.equal(actual[1].notes, 'TCP через VPN');
  assert.equal(actual[1].name, 'B');
  assert.equal(actual[0].status, 'blocked');
  assert.equal(actual[0].latency_ms, null);
  assert.equal(actual.some((profile) => profile.id === 999), false);
});

test('реальный ответ нейтральных сайтов по-прежнему даёт открытый сценарий', () => {
  const sites = new Map([[1, site(1)], [2, site(2)]]);
  const diagnosis = diagnoseScan([result(1, 'global_neutral'), result(2, 'global_neutral')], sites, { withVpn: false });
  assert.equal(diagnosis.global_ok_pct, 100);
  assert.equal(diagnosis.scenario, 'open');
});

test('ChatGPT и другие dpi_target могут честно быть доступны без VPN', () => {
  const sites = new Map([[1, site(1)], [2, site(2, 'dpi_target')]]);
  const diagnosis = diagnoseScan([result(1, 'global_neutral'), result(2, 'dpi_target')], sites, { withVpn: false });
  assert.equal(diagnosis.dpi_ok_pct, 100);
  assert.equal(diagnosis.scenario, 'open');
  assert.match(diagnosis.highlight_ok.map((x) => x.note).join(' '), /сейчас отвечает напрямую/);
});

test('разные конфиги с одним именем, хостом и портом не теряются', () => {
  const links = Array.from({ length: 5 }, (_, i) =>
    `vless://00000000-0000-4000-8000-00000000000${i}@same.example:443?security=reality&sni=one.example#Одинаковый`
  );
  const parsed = parseSubscriptionText(links.join('\n'));
  assert.equal(parsed.nodes.length, 5);
  assert.equal(parseSubscriptionText([links[0], links[0]].join('\n')).nodes.length, 1);
});

test('sing-box VLESS сохраняет flow в экспортируемой ссылке', () => {
  const config = JSON.stringify({ outbounds: [{
    type: 'vless', tag: 'DE', server: 'de.example', server_port: 443,
    uuid: '00000000-0000-4000-8000-000000000000', flow: 'xtls-rprx-vision',
    tls: { enabled: true, server_name: 'mask.example' },
  }] });
  const parsed = parseSubscriptionText(config);
  assert.equal(parsed.nodes.length, 1);
  assert.match(parsed.nodes[0].raw_link, /flow=xtls-rprx-vision/);
});

test('статистика импорта отделяет копии от нераспознанных ссылок', () => {
  const one = 'vless://00000000-0000-4000-8000-000000000001@one.example:443#DE 01';
  const two = 'trojan://secret@two.example:443#FI 01';
  const parsed = parseSubscriptionText([
    one,
    one,
    two,
    'anytls://secret@unknown-one.example:443',
    'naive://secret@unknown-two.example:443',
  ].join('\n'));
  assert.equal(parsed.nodes.length, 2);
  assert.equal(parsed.source_candidates, 5);
  assert.equal(parsed.duplicates_removed, 1);
  assert.equal(parsed.source_candidates - parsed.nodes.length - parsed.duplicates_removed, 2);
  assert.equal(parsed.nodes[0].name, 'DE 01');
});

test('Clash сохраняет UUID, Reality и не теряет разные узлы на одном адресе', () => {
  const config = `proxies:
  - name: Одинаковый
    type: vless
    server: same.example
    port: 443
    uuid: 00000000-0000-4000-8000-000000000001
    network: ws
    servername: mask.example
    client-fingerprint: chrome
    reality-opts:
      public-key: key-one
      short-id: ab
    ws-opts:
      path: /one
      headers:
        Host: cdn.example
  - name: Одинаковый
    type: vless
    server: same.example
    port: 443
    uuid: 00000000-0000-4000-8000-000000000002
    network: ws
    servername: mask.example
    reality-opts:
      public-key: key-two
      short-id: cd
    ws-opts:
      path: /two
`;
  const parsed = parseSubscriptionText(config);
  assert.equal(parsed.format, 'clash');
  assert.equal(parsed.nodes.length, 2);
  assert.match(parsed.nodes[0].raw_link, /000000000001/);
  assert.match(parsed.nodes[0].raw_link, /pbk=key-one/);
  assert.match(parsed.nodes[0].raw_link, /type=ws/);
  assert.match(parsed.nodes[0].raw_link, /path=%2Fone/);
  assert.match(parsed.nodes[0].raw_link, /host=cdn.example/);
  assert.match(parsed.nodes[1].raw_link, /000000000002/);
  assert.match(parsed.nodes[1].raw_link, /pbk=key-two/);
});

test('inline Clash с вложенными картами разбирается без потери WS-параметров', () => {
  const config = `proxies:
  - {name: "DE 01", type: vless, server: de.example, port: 443, uuid: 00000000-0000-4000-8000-000000000003, network: ws, tls: true, servername: mask.example, ws-opts: {path: "/socket", headers: {Host: "cdn.example"}}}
`;
  const parsed = parseSubscriptionText(config);
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.nodes[0].name, 'DE 01');
  assert.match(parsed.nodes[0].raw_link, /path=%2Fsocket/);
  assert.match(parsed.nodes[0].raw_link, /host=cdn.example/);
});

test('ChatGPT с признаками настоящего приложения считается открытым', () => {
  const assessment = assessSiteContent(
    'https://chatgpt.com/',
    '<html><head><title>ChatGPT</title><script src="https://cdn.oaistatic.com/app.js"></script></head></html>',
    200
  );
  assert.equal(assessment.own, true);
  assert.equal(assessment.intercepted, false);
});

test('проверка Cloudflare не считается работающим ChatGPT и не называется подменой', () => {
  const assessment = assessSiteContent(
    'https://chatgpt.com/',
    '<html><title>Just a moment...</title><div>Verify you are human</div><script>cf-chl</script></html>',
    403
  );
  assert.equal(assessment.own, false);
  assert.equal(assessment.intercepted, false);
  assert.match(assessment.reason || '', /проверку или отказ доступа/);
});

test('HTTP 403 не считается успехом даже при наличии ресурсов ChatGPT', () => {
  const assessment = assessSiteContent(
    'https://chatgpt.com/',
    '<html><script src="https://cdn.oaistatic.com/app.js"></script></html>',
    403
  );
  assert.equal(assessment.own, false);
  assert.equal(assessment.intercepted, false);
  assert.match(assessment.reason || '', /HTTP 403/);
});

test('посторонняя страница с названием ChatGPT не даёт ложный успех', () => {
  const assessment = assessSiteContent(
    'https://chatgpt.com/',
    '<html><head><title>ChatGPT</title></head><body>VPN landing page</body></html>',
    200
  );
  assert.equal(assessment.own, false);
  assert.equal(assessment.intercepted, true);
});

test('заглушка оператора помечается как чужой ответ, а не как доступный сайт', () => {
  const assessment = assessSiteContent(
    'https://www.youtube.com/',
    '<html>Доступ к ресурсу ограничен согласно требованиям законодательства</html>',
    200
  );
  assert.equal(assessment.own, false);
  assert.equal(assessment.intercepted, true);
});

test('зарубежный hosting IP при LTE/Wi-Fi не считается системным VPN', () => {
  const geo = { ...emptyGeo(), country_code: 'DE', is_hosting: true, is_proxy: true };
  const native: NativeNetworkState = { connected: true, kind: 'wifi', vpn: false, carrier: 'Beeline' };
  const verdict = resolveVpnStatus(native, geo, true);
  assert.equal(verdict.vpnLikely, false);
  assert.equal(verdict.vpnSource, 'system');
  assert.deepEqual(verdict.vpnReasons, []);
});

test('TRANSPORT_VPN не зависит от страны IP и корректно выключается', () => {
  const geo = { ...emptyGeo(), country_code: 'RU' };
  const on: NativeNetworkState = { connected: true, kind: 'cellular', vpn: true };
  const off: NativeNetworkState = { ...on, vpn: false };
  assert.equal(resolveVpnStatus(on, geo, true).vpnLikely, true);
  assert.equal(resolveVpnStatus(off, geo, true).vpnLikely, false);
  assert.notEqual(networkSnapshotKey(on), networkSnapshotKey(off));
});

test('ключ сети меняется при LTE → Wi-Fi → LTE, старые события отбрасываются', () => {
  const lte: NativeNetworkState = { connected: true, kind: 'cellular', vpn: false };
  const wifi: NativeNetworkState = { connected: true, kind: 'wifi', vpn: false };
  const lteKey = networkSnapshotKey(lte);
  assert.notEqual(lteKey, networkSnapshotKey(wifi));
  assert.equal(networkSnapshotKey(lte), lteKey);
  assert.notEqual(
    networkSnapshotKey({ ...wifi, sequence: 11 }),
    networkSnapshotKey({ ...wifi, sequence: 12 }),
    'два разных Wi-Fi не должны считаться одним подключением'
  );
  assert.equal(isNewerNetworkSequence(11, 12), false);
  assert.equal(isNewerNetworkSequence(12, 12), true);
  assert.equal(isNewerNetworkSequence(13, 12), true);
});

test('смена IP не отменяет замер, а смена LTE/Wi-Fi или системного VPN отменяет', () => {
  const base = {
    ip: '1.1.1.1', country_code: 'RU', country_name: '', region: '', city: '',
    isp: '', org: '', asn: '', is_hosting: false, is_proxy: false, is_mobile: true,
    connection_kind: 'cellular' as const, vpn_detected: false,
    vpn_confidence: 'high' as const, vpn_source: 'system' as const, vpn_reasons: [],
  };
  assert.equal(hasSameNetworkAttribution(base, { ...base, ip: '2.2.2.2' }), true);
  assert.equal(hasSameNetworkAttribution(base, { ...base, connection_kind: 'wifi' }), false);
  assert.equal(hasSameNetworkAttribution(base, { ...base, vpn_detected: true }), false);
  assert.equal(
    hasSameNetworkAttribution(
      { ...base, native_sequence: 20 },
      { ...base, native_sequence: 21 }
    ),
    false,
    'смена Network ID при том же транспорте отменяет смешанный замер'
  );
  assert.equal(
    hasSameNetworkAttribution(
      { ...base, native_sequence: 20 },
      { ...base, native_sequence: 20, ip: '8.8.8.8' }
    ),
    true
  );
});

test('YouTube без характерного приложения не считается открытым по одному названию', () => {
  const foreign = assessSiteContent(
    'https://www.youtube.com/',
    '<html><title>YouTube</title><body>Добро пожаловать на портал провайдера</body></html>',
    200
  );
  assert.equal(foreign.own, false);
  assert.equal(foreign.intercepted, true);
  const actual = assessSiteContent(
    'https://www.youtube.com/',
    '<html><title>YouTube</title><script>ytcfg.set({"INNERTUBE_API_KEY":"test"});</script></html>',
    200
  );
  assert.equal(actual.own, true);
  assert.equal(actual.proof, 'app');
});

test('Telegram, WhatsApp и Claude требуют содержимого собственного веб-приложения', () => {
  for (const [url, actualHtml] of [
    ['https://web.telegram.org/', '<title>Telegram Web</title><meta content="https://web.telegram.org/">'],
    ['https://web.whatsapp.com/', '<title>WhatsApp</title><script src="https://static.whatsapp.net/app.js"></script>'],
    ['https://claude.ai/', '<title>Claude</title><script src="https://claude.ai/assets/app.js"></script>'],
  ] as const) {
    assert.equal(assessSiteContent(url, '<html><title>Сервис недоступен</title></html>', 200).own, false);
    const actual = assessSiteContent(url, actualHtml, 200);
    assert.equal(actual.own, true);
    assert.equal(actual.proof, 'app');
  }
});

test('favicon доказывает только ответ адреса, старые ключевые пробы становятся HTML', () => {
  const image = assessSiteContent('https://example.com/favicon.ico', 'binary-icon', 200);
  assert.equal(image.own, true);
  assert.equal(image.proof, 'endpoint');
  assert.equal(canonicalServiceProbeUrl('https://chatgpt.com/favicon.ico'), 'https://chatgpt.com/');
  assert.equal(canonicalServiceProbeUrl('https://www.youtube.com/favicon.ico'), 'https://www.youtube.com/');
  assert.equal(canonicalServiceProbeUrl('https://example.com/favicon.ico'), 'https://example.com/favicon.ico');
});

test('generic HTML без признаков домена не подтверждён, а текстовый ответ остаётся endpoint', () => {
  const foreign = assessSiteContent(
    'https://discord.com/',
    '<html><title>Добро пожаловать</title><body>Проверка соединения</body></html>',
    200
  );
  assert.equal(foreign.own, false);
  assert.equal(foreign.intercepted, false); // неизвестный HTML не доказывает подмену провайдером
  const actual = assessSiteContent(
    'https://discord.com/',
    '<html><title>Discord</title><script src="/assets/app.js"></script></html>',
    200
  );
  assert.equal(actual.own, true);
  assert.equal(actual.proof, 'page');
  const data = assessSiteContent('https://example.com/api', '{"status":"ok"}', 200);
  assert.equal(data.own, true);
  assert.equal(data.proof, 'endpoint');
});

test('при восстановлении выбирается самая свежая копия подписки', () => {
  const older = encodeStatePacket({ subscriptions: [{ id: 1 }] }, new Date('2026-11-05T10:00:00Z'));
  const newer = encodeStatePacket({ subscriptions: [{ id: 1 }, { id: 2 }] }, new Date('2026-11-05T12:00:00Z'));
  const selected = selectNewestState<{ subscriptions: Array<{ id: number }> }>([
    older,
    newer,
    '{broken json',
  ]);
  assert.equal(selected?.state.subscriptions.length, 2);
  assert.equal(selected?.savedAtMs, new Date('2026-11-05T12:00:00Z').getTime());
});

test('старый формат состояния 1.5.x остаётся совместимым', () => {
  const legacy = JSON.stringify({ subscriptions: [{ id: 7 }] });
  const decoded = decodeStatePacket<{ subscriptions: Array<{ id: number }> }>(legacy);
  assert.equal(decoded?.savedAtMs, 0);
  assert.equal(decoded?.state.subscriptions[0].id, 7);
  assert.equal(selectNewestState(['null', '{bad', legacy])?.savedAtMs, 0);
});
