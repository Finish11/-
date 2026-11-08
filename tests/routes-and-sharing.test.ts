import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNetworkContext, emptyGeo, resolveVpnStatus } from '../src/lib/networkInfo.ts';
import { mapLimit } from '../src/lib/nativeBridge.ts';
import {
  confirmationAgeDays, confirmationAgeLabel, confirmationFreshness, confirmationWeight,
  findAppConfirmation, recommendConfirmedNodes, routeFingerprint, routeIdentity, suggestActiveNode,
} from '../src/lib/appConfirmations.ts';
import { communityInviteLink, exportIncidentBundle, importIncidentBundle, readCommunityInvite } from '../src/lib/incidentShare.ts';
import type { AppConfirmation, Incident, VpnProfile } from '../src/types.ts';

const profile = (id: number, patch: Partial<VpnProfile> = {}): VpnProfile => ({
  id, user_id: 1, name: `Узел ${id}`, protocol: 'VLESS', location: 'Амстердам', country_code: 'NL',
  host: `n${id}.example.com`, port: 443, provider: 'test', dpi_resistance: 'high', whitelist_bypass: false,
  status: 'online', latency_ms: 40, uptime_pct: 100, is_primary: false, notes: '', last_checked_at: null,
  created_at: '2026-11-01T00:00:00.000Z', ...patch,
});

const confirmation = (patch: Partial<AppConfirmation> = {}): AppConfirmation => ({
  id: 1, service_id: 'youtube', domain: 'youtube.com', node_key: 'vpn:7', profile_id: 7,
  profile_name: 'Узел 7', exit_ip: '203.0.113.10', works: true, confirmed_at: '2026-11-07T10:00:00.000Z',
  vpn_package: 'com.v2ray.ang', route_source: 'system', ...patch,
});

const incident = (patch: Partial<Incident> = {}): Incident => ({
  id: 1, user_id: 1, author_name: 'Я', region: 'Москва и МО', carrier: 'МТС', incident_type: 'whitelist',
  severity: 'high', status: 'active', title: 'Белые списки', description: 'Только ВК', upvotes: 1,
  ru_sites_ok: true, foreign_sites_ok: false, user_upvoted: true, is_owner: true,
  created_at: '2026-11-06T10:00:00.000Z', updated_at: '2026-11-06T10:00:00.000Z',
  client_id: '80000000-0000-4000-8000-000000000001', ...patch,
});

// ------------------------------------------------------------------- VPN facts

test('раздельный туннель: VPN в системе есть, но приложение идёт мимо него', () => {
  const native = { connected: true, kind: 'wifi' as const, vpn: false, systemVpn: true, appUsesVpn: false, splitTunnel: true };
  const verdict = resolveVpnStatus(native, emptyGeo(), true);
  assert.equal(verdict.vpnLikely, false, 'нельзя приписывать нашим запросам чужой туннель');
  assert.equal(verdict.vpnSource, 'system');
  assert.match(verdict.vpnReasons.join(' '), /раздельный туннель/);
  const context = buildNetworkContext(native, emptyGeo(), { nativePlatform: true });
  assert.equal(context.splitTunnel, true);
  assert.equal(context.systemVpn, true);
  assert.equal(context.appUsesVpn, false);
});

test('обычный VPN и прямое подключение определяются как раньше', () => {
  const vpn = { connected: true, kind: 'wifi' as const, vpn: true, systemVpn: true, appUsesVpn: true };
  assert.equal(resolveVpnStatus(vpn, emptyGeo(), true).vpnLikely, true);
  assert.equal(buildNetworkContext(vpn, emptyGeo(), { nativePlatform: true }).splitTunnel, false);
  const direct = { connected: true, kind: 'cellular' as const, vpn: false, systemVpn: false, appUsesVpn: false };
  assert.equal(resolveVpnStatus(direct, emptyGeo(), true).vpnLikely, false);
  assert.equal(buildNetworkContext(direct, emptyGeo(), { nativePlatform: true }).splitTunnel, false);
});

// --------------------------------------------------------------- confirmations

test('отзыв на выбранный узел не исчезает при смене выходного IP', () => {
  const saved = confirmation();
  const match = findAppConfirmation([saved], 'youtube', { id: 7 }, '198.51.100.77');
  assert.ok(match, 'карточка обязана показать отзыв пользователя на этом узле');
  assert.equal(match!.matchedBy, 'node');
  assert.equal(match!.ipChanged, true);
  const exact = findAppConfirmation([saved], 'youtube', { id: 7 }, '203.0.113.10');
  assert.equal(exact!.matchedBy, 'node_ip');
  assert.equal(exact!.ipChanged, undefined);
});

test('прямой маршрут не забирает отзыв, оставленный на VPN-узле', () => {
  assert.equal(findAppConfirmation([confirmation()], 'youtube', null, '203.0.113.10'), null);
  const direct = confirmation({ node_key: 'direct', profile_id: null, profile_name: 'Прямое подключение' });
  assert.equal(findAppConfirmation([direct], 'youtube', null, '203.0.113.10')!.matchedBy, 'node_ip');
  // Для прямого подключения смена IP — это другая сеть, отзыв не переносим.
  assert.equal(findAppConfirmation([direct], 'youtube', null, '198.51.100.1'), null);
});

test('автоопределение узла: память «клиент + IP» и совпадение IP сервера', () => {
  const profiles = [profile(7), profile(9, { server_ip: '203.0.113.55' })];
  const fingerprint = routeFingerprint('com.v2ray.ang', '203.0.113.10');
  assert.equal(fingerprint, 'com.v2ray.ang|203.0.113.10');
  const remembered = suggestActiveNode(profiles, { vpnPackage: 'com.v2ray.ang', exitIp: '203.0.113.10', remembered: { [fingerprint]: 7 } });
  assert.equal(remembered!.profile.id, 7);
  assert.equal(remembered!.source, 'remembered');
  const byIp = suggestActiveNode(profiles, { exitIp: '203.0.113.55' });
  assert.equal(byIp!.profile.id, 9);
  assert.equal(byIp!.source, 'server_ip');
  assert.match(byIp!.reason, /не доказательство/);
  assert.equal(suggestActiveNode(profiles, { exitIp: '192.0.2.1' }), null);
  assert.equal(routeFingerprint('', '203.0.113.10'), '');
});

test('смена системного sequence сама по себе не отменяет маршрут отзыва', () => {
  assert.equal(routeIdentity('1|wifi|1|com.v2ray.ang|41'), '1|wifi|1|com.v2ray.ang');
  assert.equal(routeIdentity('1|wifi|1|com.v2ray.ang|42'), routeIdentity('1|wifi|1|com.v2ray.ang|41'));
  assert.notEqual(routeIdentity('1|wifi|0||41'), routeIdentity('1|wifi|1|com.v2ray.ang|41'));
});

// ------------------------------------------------------------- incident sharing

test('экспорт пакета не содержит ключей устройства и демо-отчётов', () => {
  const items = [incident(), incident({ id: 2, demo: true, client_id: '80000000-0000-4000-8000-000000000002' }),
    incident({ id: 3, pending_delete: true, client_id: '80000000-0000-4000-8000-000000000003' })];
  const raw = exportIncidentBundle(items, { endpoint: 'https://api.test', author: 'Владелец', now: '2026-11-07T10:00:00.000Z' });
  const bundle = JSON.parse(raw);
  assert.equal(bundle.pulsenet, 'incidents');
  assert.equal(bundle.incidents.length, 2);
  assert.deepEqual(bundle.deleted, ['80000000-0000-4000-8000-000000000003']);
  assert.ok(!raw.includes('device_hash'), 'ключ устройства не должен покидать приложение');
  assert.ok(!raw.includes('sync_state'));
  assert.equal(bundle.incidents[0].client_id, '80000000-0000-4000-8000-000000000001');
});

test('импорт сливает по client_id: свежая правка побеждает, дубли не создаются', () => {
  const mine = incident();
  const raw = exportIncidentBundle([
    incident({ title: 'Обновлённый текст', updated_at: '2026-11-07T09:00:00.000Z' }),
    incident({ id: 5, client_id: '80000000-0000-4000-8000-000000000009', title: 'Чужой отчёт', is_owner: false }),
  ], { author: 'Участник' });
  const first = importIncidentBundle(raw, [mine], { userId: 1, now: '2026-11-07T12:00:00.000Z' });
  assert.equal(first.ok, true);
  assert.equal(first.added, 1);
  assert.equal(first.updated, 1);
  assert.equal(first.incidents.length, 2);
  assert.equal(first.incidents.find((item) => item.client_id === mine.client_id)!.title, 'Обновлённый текст');
  const imported = first.incidents.find((item) => item.client_id!.endsWith('9'))!;
  assert.equal(imported.is_owner, false);
  assert.notEqual(imported.id, mine.id, 'локальные id не должны сталкиваться');
  const again = importIncidentBundle(raw, first.incidents, { userId: 1 });
  assert.equal(again.added, 0);
  assert.equal(again.updated, 0);
  assert.equal(again.skipped, 2);
});

test('импорт уважает удаления и не перетирает несохранённые свои правки', () => {
  const dirty = incident({ sync_dirty: true, title: 'Моя свежая правка', updated_at: '2026-11-05T00:00:00.000Z' });
  const raw = exportIncidentBundle([incident({ title: 'Старая копия', updated_at: '2026-11-06T00:00:00.000Z' })]);
  const kept = importIncidentBundle(raw, [dirty]);
  assert.equal(kept.updated, 0);
  assert.equal(kept.incidents[0].title, 'Моя свежая правка');

  const foreign = incident({ id: 4, is_owner: false, client_id: '80000000-0000-4000-8000-000000000004' });
  const tombstone = JSON.stringify({ pulsenet: 'incidents', version: 1, exported_at: '2026-11-07T10:00:00.000Z',
    incidents: [], deleted: ['80000000-0000-4000-8000-000000000004'] });
  const removed = importIncidentBundle(tombstone, [foreign]);
  assert.equal(removed.removed, 1);
  assert.equal(removed.incidents.length, 0);
  const resurrect = importIncidentBundle(exportIncidentBundle([foreign]), []);
  assert.equal(resurrect.added, 1, 'пакет без tombstone создаёт копию — это ожидаемо');
});

test('мусорный пакет отвергается с понятной ошибкой', () => {
  assert.match(importIncidentBundle('не json', []).error, /не JSON/);
  assert.match(importIncidentBundle('{"a":1}', []).error, /не пакет отчётов/);
  assert.match(importIncidentBundle('{"pulsenet":"incidents","version":99,"incidents":[]}', []).error, /Версия пакета/);
  assert.match(importIncidentBundle('{"pulsenet":"incidents","version":1}', []).error, /нет списка отчётов/);
  const huge = JSON.stringify({ pulsenet: 'incidents', version: 1, incidents: [], padding: 'x'.repeat(2_100_000) });
  assert.match(importIncidentBundle(huge, []).error, /слишком большой/);
  const badIds = JSON.stringify({ pulsenet: 'incidents', version: 1, exported_at: '', incidents: [{ client_id: 'мусор', title: 'x' }] });
  const result = importIncidentBundle(badIds, []);
  assert.equal(result.ok, true);
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
});

test('ссылка-приглашение подключает сервер у получателя', () => {
  const link = communityInviteLink('https://api.example.com', 'https://app.example/demo.html#old');
  assert.equal(link, 'https://app.example/demo.html#community=https%3A%2F%2Fapi.example.com');
  assert.equal(readCommunityInvite('#community=https%3A%2F%2Fapi.example.com'), 'https://api.example.com');
  assert.equal(readCommunityInvite('#tab=incidents&community=https%3A%2F%2Fa.test'), 'https://a.test');
  assert.equal(readCommunityInvite('#tab=incidents'), '');
  assert.equal(readCommunityInvite(''), '');
});

test('капча и проверка браузера не превращают живой сайт в «не открыт»', async () => {
  const { assessSiteContent } = await import('../src/lib/siteContent.ts');
  const { siteResultFromProbe } = await import('../src/lib/siteMeasurement.ts');
  const challenge = assessSiteContent('https://example.com/', '<html>Just a moment... Checking your browser</html>', 403, 'text/html');
  assert.equal(challenge.own, false);
  assert.equal(challenge.challenge, true);
  const site = { id: 1, user_id: 1, name: 'Example', domain: 'example.com', probe_url: 'https://example.com/',
    category: 'global_infra', marker_role: 'global_neutral', enabled: 1, last_status: 'unknown', last_latency_ms: null,
    last_checked_at: null, description: '', created_at: '' } as any;
  const result = siteResultFromProbe(site, { verdict: 'blocked', latencyMs: 120, httpStatus: 403,
    challenge: true, networkStatus: 'ok', proof: 'opaque', reason: challenge.reason });
  assert.equal(result.access_scope, 'app_unconfirmed');
  assert.equal(result.network_status, 'ok', 'сеть до сайта есть');
  const stub = assessSiteContent('https://example.com/', '<html>Доступ ограничен Роскомнадзор</html>', 200, 'text/html');
  assert.equal(stub.intercepted, true);
  assert.notEqual(stub.challenge, true);
});

test('партию проб можно остановить: новые задачи не запускаются, отказ один', async () => {
  const controller = new AbortController();
  const started: number[] = [];
  const pending = mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 2, async (item) => {
    started.push(item);
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (item === 2) controller.abort();
    return item;
  }, controller.signal);
  await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  assert.ok(started.length < 8, `после остановки не должны стартовать все задачи: ${started.join(',')}`);
  assert.ok(started.includes(1) && started.includes(2));
});

test('без отмены партия выполняется полностью и в исходном порядке', async () => {
  const results = await mapLimit([1, 2, 3, 4, 5], 2, async (item) => {
    await new Promise((resolve) => setTimeout(resolve, 5 - item));
    return item * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});

test('уже отменённая партия не запускает ни одной пробы', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(mapLimit([1, 2], 2, async () => { calls += 1; }, controller.signal),
    (error: Error) => error.name === 'AbortError');
  assert.equal(calls, 0);
});

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

test('свежесть отзыва: неделя свежий, месяц стареет, дальше давний', () => {
  assert.equal(confirmationFreshness(daysAgo(0), NOW), 'fresh');
  assert.equal(confirmationFreshness(daysAgo(7), NOW), 'fresh');
  assert.equal(confirmationFreshness(daysAgo(8), NOW), 'aging');
  assert.equal(confirmationFreshness(daysAgo(30), NOW), 'aging');
  assert.equal(confirmationFreshness(daysAgo(31), NOW), 'stale');
  assert.equal(confirmationFreshness('мусор', NOW), 'unknown');
  assert.equal(confirmationFreshness(null, NOW), 'unknown');
  assert.equal(confirmationAgeDays(daysAgo(-3), NOW), 0, 'часы устройства могут спешить');
  assert.equal(confirmationWeight(daysAgo(1), NOW), 1);
  assert.ok(confirmationWeight(daysAgo(45), NOW) < confirmationWeight(daysAgo(10), NOW));
  assert.equal(confirmationAgeLabel(daysAgo(0), NOW), 'подтверждено сегодня');
  assert.equal(confirmationAgeLabel(daysAgo(1), NOW), 'подтверждено вчера');
  assert.match(confirmationAgeLabel(daysAgo(45), NOW), /больше месяца/);
});

test('давний отзыв не поднимает узел выше свежего', () => {
  const oldNode = profile(1, { name: 'Давно подтверждён' });
  const freshNode = profile(2, { name: 'Подтверждён вчера' });
  const confirmation = (node: typeof oldNode, age: number, service: string): AppConfirmation => ({
    id: node.id * 10, user_id: 1, service_id: service, profile_id: node.id, node_key: `vpn:${node.id}`,
    profile_name: node.name, exit_ip: '203.0.113.5', works: true, confirmed_at: daysAgo(age),
  } as AppConfirmation);
  const ranked = recommendConfirmedNodes([oldNode, freshNode], [
    confirmation(oldNode, 60, 'chatgpt'),
    confirmation(freshNode, 1, 'chatgpt'),
  ], NOW);
  assert.equal(ranked[0].profile.id, freshNode.id, 'свежий отзыв важнее давнего');
  assert.equal(ranked.find((item) => item.profile.id === oldNode.id)?.freshWorks, 0);
  assert.equal(ranked.find((item) => item.profile.id === freshNode.id)?.freshWorks, 1);
});
