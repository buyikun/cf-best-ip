// Cloudflare DNS helper: list / backup / replace A records
// usage:
//   node cf-api.mjs list
//   node cf-api.mjs set <recordName> <ip1,ip2,...>
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, findBaseDir } from './cfip-lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BASE = findBaseDir(HERE);
const { cfg, uploadReady } = loadConfig(path.join(HERE, 'cfip.config.json'), path.join(BASE, 'user.config.jsonc'));
const TOKEN = process.env.CF_TOKEN || cfg.cloudflare.apiToken;
const ZONE = process.env.CF_ZONE || cfg.cloudflare.zoneId;
if (!uploadReady && !process.env.CF_TOKEN) {
  console.error('未配置 Cloudflare：请在 user.config.jsonc 里填写 apiToken / zoneId / records');
  process.exit(1);
}
const API = 'https://api.cloudflare.com/client/v4';
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function api(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json.success === false) {
    throw new Error(`HTTP ${res.status} ${pathname} -> ${JSON.stringify(json.errors || json).slice(0, 400)}`);
  }
  return json.result;
}

const cmd = process.argv[2];

if (cmd === 'list') {
  const records = await api(`/zones/${ZONE}/dns_records?per_page=200`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bakDir = path.join(BASE, 'var', 'backups');
  fs.mkdirSync(bakDir, { recursive: true });
  const backup = path.join(bakDir, `cf-backup-${stamp}.json`);
  fs.writeFileSync(backup, JSON.stringify(records, null, 2), 'utf8');
  console.log(`records=${records.length} backup=var\\backups\\${path.basename(backup)}`);
  for (const r of records) {
    console.log(`${r.type}\t${r.name}\t${r.content}\tttl=${r.ttl}\tproxied=${r.proxied}\tid=${r.id}`);
  }
} else if (cmd === 'set') {
  const name = process.argv[3];
  const ips = (process.argv[4] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!name || ips.length === 0) throw new Error('usage: set <recordName> <ip1,ip2,...>');
  const all = await api(`/zones/${ZONE}/dns_records?per_page=200`);
  const existing = all.filter(r => r.name === name && r.type === 'A');
  const keep = existing.filter(r => ips.includes(r.content));
  const drop = existing.filter(r => !ips.includes(r.content));
  const already = new Set(keep.map(r => r.content));
  const toAdd = ips.filter(ip => !already.has(ip));
  console.log(`[${name}] existing=${existing.length} keep=${keep.length} delete=${drop.length} add=${toAdd.length}`);
  for (const r of drop) {
    await api(`/zones/${ZONE}/dns_records/${r.id}`, { method: 'DELETE' });
    console.log(`  DEL ${r.content}`);
  }
  for (const ip of toAdd) {
    const created = await api(`/zones/${ZONE}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ type: 'A', name, content: ip, ttl: 300, proxied: false, comment: 'cf-best-ip' })
    });
    console.log(`  ADD ${created.content} id=${created.id}`);
  }
} else {
  console.log('usage: list | set <recordName> <ip1,ip2,...>');
}
