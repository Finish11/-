import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseScan, evaluateScanVerdict } from '../src/lib/scanner.ts';
import { parseSubscriptionText } from '../src/lib/subscriptionParser.ts';
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
  assert.match(diagnosis.details, /Подмена ответа/);
  const verdict = evaluateScanVerdict(results, false, sites);
  assert.equal(verdict.verdict, 'SEVERE_RESTRICTIONS');
  assert.equal(verdict.ok_sites, 0);
  assert.equal(verdict.blocked_sites, 2);
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
