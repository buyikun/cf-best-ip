#!/usr/bin/env node
/**
 * CF 优选 IP 自动化任务
 * ---------------------------------------------------------------
 * 流程：读取优选源 -> 候选筛选 -> 443 端口 TCP 门控 + 多轮下载实测
 *      -> 中位数排名 -> 国家过滤取 TopN -> Cloudflare API 替换 A 记录
 *      -> 读回 + DoH 双重验证 -> 日志落盘
 *
 * 用法：
 *   node cfip-auto.mjs                # 正常执行（集合无变化会自动跳过）
 *   node cfip-auto.mjs --dry-run      # 只测速出方案，不碰 Cloudflare
 *   node cfip-auto.mjs --force        # 即使集合没变也重写一遍
 *   node cfip-auto.mjs --config x.json --verbose
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { pruneOldFiles, loadConfig, findBaseDir } from './cfip-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = findBaseDir(HERE);   // 根目录（配置与 var\ 所在层），程序可放在 src\ 子目录
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const CONFIG_PATH = path.resolve(HERE, opt('--config', 'cfip.config.json'));   // 内置默认配置随程序在 src\
const USER_CONFIG_PATH = path.resolve(BASE, opt('--user-config', 'user.config.jsonc'));  // 用户配置在根目录
const { cfg, userPath, uploadReady } = loadConfig(CONFIG_PATH, USER_CONFIG_PATH);
if (!uploadReady) cfg.behavior.dryRun = true;   // 没填凭据 = 强制只测速，绝不写 DNS
const FORCE = flag('--force');
const VERBOSE = flag('--verbose');
const DRY_RUN = flag('--dry-run') || cfg.behavior.dryRun === true;
if (opt('--candidates')) cfg.probe.candidates = Number(opt('--candidates'));
if (opt('--rounds')) cfg.probe.rounds = Number(opt('--rounds'));
if (opt('--port')) cfg.probe.port = Number(opt('--port'));
const CFG_DIR = BASE;
const LOG_DIR = path.resolve(CFG_DIR, cfg.behavior.logDir || 'var/logs');
const BAK_DIR = path.resolve(CFG_DIR, cfg.behavior.backupDir || 'var/backups');
const STATE_FILE = path.resolve(CFG_DIR, cfg.behavior.stateFile || 'var/state.json');
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(BAK_DIR, { recursive: true });

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const RUN_ID = stamp();
let logBuffer = '';
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logBuffer += line + '\n';
  console.log(msg);
}
function flushLog() {
  try {
    fs.writeFileSync(path.join(LOG_DIR, `cfip-${RUN_ID}.log`), logBuffer, 'utf8');
    fs.writeFileSync(path.join(LOG_DIR, 'latest.log'), logBuffer, 'utf8');
  } catch { /* ignore */ }
}
process.on('exit', flushLog);
let hardTimeout = null;
function armGlobalTimeout() {
  const minutes = Number(cfg.behavior.globalTimeoutMinutes || 15);
  hardTimeout = setTimeout(() => {
    log(`!! 触发全局超时(${minutes} 分钟)，放弃本次写入并退出`);
    process.exitCode = 2;
    process.exit(2);
  }, minutes * 60_000);
}
function done(code) {
  if (hardTimeout) clearTimeout(hardTimeout);
  flushLog();
  process.exitCode = code;
  // Node 24 + undici：退出前留出收尾时间，避免 libuv 关闭断言
  setTimeout(() => process.exit(code), 250);
}
// 提前结束必须用 throw，绝不能只调 done()——否则后面的写入代码还会继续跑
class ExitError extends Error { constructor(code) { super('early-exit'); this.code = code; this.isExit = true; } }

// ── 源解析 ────────────────────────────────────────────────────────
// 线上格式： 1.2.3.4:443#JP [7M]        1.2.3.4:443#HK [高速 by Jz 13M]
// 旧版格式： 1.2.3.4:443#JP [45ms 12Mbps]
const RE_SPEED = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)#([A-Z]{2})?\s*\[(?:高速\s*by\s*Jz\s+)?(\d+)\s*M\]\s*$/;
const RE_LAT_BW = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)#([A-Z]{2})?\s*\[(\d+)ms\s+([\d.]+)\s*Mbps\]\s*$/;
const RE_LOOSE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?(?:#([A-Z]{2}))?/;

function parseLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let m = line.match(RE_SPEED);
    if (m) { out.push({ ip: m[1], port: +m[2], cc: m[3] || '', fileMs: 0, fileMbps: +m[4] }); continue; }
    m = line.match(RE_LAT_BW);
    if (m) { out.push({ ip: m[1], port: +m[2], cc: m[3] || '', fileMs: +m[4], fileMbps: +m[5] }); continue; }
    m = line.match(RE_LOOSE);
    if (m) out.push({ ip: m[1], port: m[2] ? +m[2] : Number(cfg.probe.port), cc: m[3] || '', fileMs: 0, fileMbps: 0 });
  }
  const seen = new Set();
  return out.filter(r => (seen.has(r.ip) ? false : (seen.add(r.ip), true)));
}

async function httpGet(url, timeout = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'cfip-auto/1.0' },
      redirect: 'follow',
      signal: ctl.signal
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// 顺带查一下上游最后提交时间，避免长期用过期的数据
async function noteFreshness(url) {
  const m = url.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//);
  if (!m) return;
  const txt = await httpGet(`https://api.github.com/repos/${m[1]}/${m[2]}/commits?path=full_ips.txt&per_page=1`, 10000);
  if (!txt) return;
  try {
    const d = JSON.parse(txt)[0]?.commit?.committer?.date;
    if (!d) return;
    const ageH = (Date.now() - Date.parse(d)) / 3600000;
    log(`   上游最后更新：${new Date(d).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（${ageH.toFixed(1)} 小时前）`);
    if (ageH > 6) log(`   警告：上游已 ${ageH.toFixed(1)} 小时未更新，可能是过期数据`);
  } catch { /* 忽略 */ }
}

async function loadSource() {
  const s = cfg.source || {};
  const urls = (s.urls && s.urls.length) ? s.urls : (s.url ? [s.url] : []);
  const cachePath = s.cacheFile ? path.resolve(CFG_DIR, s.cacheFile) : '';

  if (s.preferUrl !== false && urls.length) {
    const merged = new Map();
    let used = 0;
    for (const u of urls) {
      const txt = await httpGet(u);
      const rows = txt ? parseLines(txt) : [];
      if (!rows.length) { log(`   源不可用或解析为空，跳过：${u}`); if (s.merge) continue; else break; }
      used++;
      log(`源：${u}（${rows.length} 个节点）`);
      await noteFreshness(u);
      for (const r of rows) {
        const prev = merged.get(r.ip);
        const better = !prev || r.fileMbps > prev.fileMbps
          || (r.fileMbps === prev.fileMbps && r.fileMs > 0 && (!prev.fileMs || r.fileMs < prev.fileMs));
        if (better) merged.set(r.ip, r);
      }
      if (!s.merge) break;
      if (cachePath) { try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, txt, 'utf8'); } catch { /* 忽略 */ } }
    }
    if (merged.size) {
      const list = [...merged.values()];
      if (used > 1) log(`合并去重后共 ${list.length} 个节点，来自 ${used} 个源`);
      if (cachePath && used > 1) {
        try {
          fs.mkdirSync(path.dirname(cachePath), { recursive: true });
          fs.writeFileSync(cachePath, list.map(r => `${r.ip}:${r.port}#${r.cc} [${r.fileMbps}M]`).join('\n'), 'utf8');
        } catch { /* 忽略 */ }
      }
      return list;
    }
    log('   所有线上源均失败，改用本地缓存/文件');
  }

  if (cachePath && fs.existsSync(cachePath)) {
    const rows = parseLines(fs.readFileSync(cachePath, 'utf8'));
    if (rows.length) { log(`源：本地缓存 ${cachePath}（${rows.length} 个节点）`); return rows; }
  }

  const file = s.file;
  if (!file || !fs.existsSync(file)) throw new Error(`线上源不可用，本地文件也不存在: ${file}`);
  const ageMin = (Date.now() - fs.statSync(file).mtimeMs) / 60000;
  log(`源：${file}（${ageMin.toFixed(0)} 分钟前更新）`);
  if (s.maxAgeMinutes > 0 && ageMin > s.maxAgeMinutes) log(`   警告：文件已超过 maxAgeMinutes=${s.maxAgeMinutes}，可能是旧数据`);
  return parseLines(fs.readFileSync(file, 'utf8'));
}

// ── 探针 ──────────────────────────────────────────────────────────
function tcpProbe(ip, port, timeout) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const sock = net.connect({ host: ip, port });
    let done = false;
    const fin = (ok, err) => {
      if (done) return; done = true;
      try { sock.destroy(); } catch {}
      resolve({ ok, tcpMs: Date.now() - t0, err: err || '' });
    };
    sock.setTimeout(timeout, () => fin(false, 'tcp-timeout'));
    sock.on('connect', () => fin(true));
    sock.on('error', e => fin(false, e.code || e.message));
  });
}

function download(ip, port, bytes, timeout) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let ttfb = 0, got = 0, done = false;
    let guard = null;
    const fin = (ok, err) => {
      if (done) return; done = true;
      if (guard) clearTimeout(guard);
      try { req && req.destroy(); } catch { /* 忽略 */ }
      const total = Date.now() - t0;
      const mbps = ok && total - ttfb > 0 ? (got * 8) / ((total - ttfb) / 1000) / 1e6 : 0;
      resolve({ ok, mbps: +mbps.toFixed(2), ttfb: ok ? ttfb : 0, total, err: err || '' });
    };
    const req = https.request({
      host: ip, port, path: `/__down?bytes=${bytes}`, method: 'GET',
      servername: 'speed.cloudflare.com', rejectUnauthorized: false,
      headers: { Host: 'speed.cloudflare.com', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/152.0' }
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return fin(false, 'HTTP ' + res.statusCode); }
      res.on('data', c => { if (!ttfb) ttfb = Date.now() - t0; got += c.length; });
      res.on('end', () => fin(true));
      res.on('error', e => fin(false, e.code || e.message));
    });
    // socket 空闲超时 + 无论如何都会 resolve 的硬兜底，避免个别连接把整轮任务卡死
    req.setTimeout(timeout, () => req.destroy(new Error('dl-timeout')));
    guard = setTimeout(() => fin(false, 'guard-timeout'), timeout + 2500);
    req.on('error', e => fin(false, e.code || e.message));
    req.end();
  });
}

async function pool(items, limit, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const item = items[i++]; await worker(item); }
  });
  await Promise.all(runners);
}

const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ── Cloudflare API ────────────────────────────────────────────────
const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CF_TOKEN || cfg.cloudflare.apiToken;
const ZONE = process.env.CF_ZONE || cfg.cloudflare.zoneId;

async function cf(method, p, body) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  if (!res.ok || json.success === false) throw new Error(`CF API ${method} ${p} -> HTTP ${res.status} ${JSON.stringify(json.errors || json).slice(0, 300)}`);
  return json.result;
}

const listRecords = () => cf('GET', `/zones/${ZONE}/dns_records?per_page=200`);
const deleteRecord = id => cf('DELETE', `/zones/${ZONE}/dns_records/${id}`);
const createRecord = r => cf('POST', `/zones/${ZONE}/dns_records`, r);

const FAKE_IP = /^198\.18\./;   // 本机 Clash/mihomo 的 fake-ip 段，遇到要换路重查
async function dohOnce(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: ctl.signal });
    const j = await res.json();
    return (j.Answer || []).filter(a => a.type === 1).map(a => a.data);
  } catch (e) {
    return ['DoH失败:' + (e.code || e.message)];
  } finally {
    clearTimeout(timer);
  }
}
async function dohCheck(name) {
  const urls = [
    `https://dns.alidns.com/resolve?name=${name}&type=A`,
    `https://doh.pub/dns-query?name=${name}&type=A`,
    `https://cloudflare-dns.com/dns-query?name=${name}&type=A`
  ];
  let last = [];
  for (const u of urls) {
    const ans = await dohOnce(u);
    if (ans.length && !ans.some(a => FAKE_IP.test(a) || a.startsWith('DoH失败'))) return ans;
    last = ans;
  }
  return last.map(a => (FAKE_IP.test(a) ? '(被本机代理伪造)' : a));
}

// ── 国家过滤 ──────────────────────────────────────────────────────
function applyFilter(rows, filter) {
  if (!filter || !filter.tokens || filter.tokens.length === 0) return rows;
  const set = new Set(filter.tokens.map(t => t.toUpperCase()));
  const mode = (filter.mode || 'deny').toLowerCase();
  return mode === 'allow' ? rows.filter(r => set.has(r.cc)) : rows.filter(r => !set.has(r.cc));
}

// ── 主流程 ────────────────────────────────────────────────────────
armGlobalTimeout();
log('=========== CF 优选自动化任务开始 ===========');
log(`配置：${path.basename(CONFIG_PATH)}${uploadReady ? ' + ' + path.basename(userPath) : '（未配置用户变量文件）'}${DRY_RUN ? '  [DRY-RUN 不写 Cloudflare]' : ''}${FORCE ? '  [--force]' : ''}`);
if (!uploadReady) {
  log('');
  log('  ┌────────────────────────────────────────────────────────────┐');
  log('  │  还没有配置 Cloudflare，本次运行 = 演示模式                │');
  log('  │  · 只测速、只打印结果，绝不会改动你的 DNS                  │');
  log('  │  · 想正式使用：用记事本打开 user.config.jsonc，填三样：    │');
  log('  │      apiToken / zoneId / records（文件里每项都有中文说明） │');
  log('  └────────────────────────────────────────────────────────────┘');
  log('');
  // 演示模式：缩小规模，一两分钟就出结果
  cfg.probe.candidates = Math.min(Number(cfg.probe.candidates) || 150, 12);
  cfg.probe.rounds = 1;
}

try {
  // 清理历史文件：备份和日志各只留最近 N 份
  const keepBak = Number(cfg.behavior.keepBackups ?? 3);
  const keepLog = Number(cfg.behavior.keepLogs ?? 3);
  const prB = pruneOldFiles(BAK_DIR, /^cf-backup-.*\.json$/, keepBak, log);
  const prL = pruneOldFiles(LOG_DIR, /^cfip-.*\.log$/, keepLog, null);
  if (prB || prL) log(`已清理历史文件：备份 ${prB} 个、日志 ${prL} 个（各保留最近 ${keepBak} 份）`);

  // 1. 源
  const all = await loadSource();
  log(`源记录：${all.length} 条，其中带速度标注 ${all.filter(r => r.fileMbps > 0).length} 条`);
  if (!all.length) throw new Error('源文件没有可解析的 IP');

  // 2. 候选：TCP 门控很便宜，可以对尽可能多的节点做；下载测速贵，才需要限量
  const P = Number(cfg.probe.port);
  const byMbps = (a, b) => (b.fileMbps - a.fileMbps) || (a.fileMs - b.fileMs);
  const t1 = all.filter(r => r.port === P && r.fileMbps > 0).sort(byMbps);
  const t2 = all.filter(r => r.port === P && r.fileMbps === 0);
  const t3 = all.filter(r => r.port !== P && r.fileMbps > 0).sort(byMbps);
  const gateLimit = Number(cfg.probe.tcpPool || 0) || Infinity;
  const gatePool = [...t1, ...t2, ...t3].slice(0, gateLimit).map(r => ({ ...r, port: P }));
  log(`候选池：${P} 端口+有速度 ${t1.length} / ${P} 端口+无速度 ${t2.length} / 其他端口 ${t3.length}；本轮门控 ${gatePool.length} 个`);

  // 3. TCP 门控
  const alive = [];
  await pool(gatePool, cfg.probe.tcpConcurrency, async c => {
    const t = await tcpProbe(c.ip, c.port, cfg.probe.tcpTimeoutMs);
    if (t.ok) alive.push({ ...c, tcpMs: t.tcpMs });
    else if (VERBOSE) log(`   x ${c.ip} TCP 不通(${t.err})`);
  });
  log(`TCP ${P} 可达：${alive.length}/${gatePool.length}`);
  if (!alive.length) throw new Error('没有候选 IP 能连通，放弃本次任务');

  // 4. HTTP 粗筛（并发、小样本、短超时）：上游数据陈旧时大量节点已失效，先便宜地筛掉
  const testList = alive.sort(byMbps).slice(0, cfg.probe.candidates);
  if (testList.length < alive.length) log(`存活 ${alive.length} 个，取标称速度最高的 ${testList.length} 个进入 HTTP 粗筛`);
  const screened = [];
  await pool(testList, cfg.probe.screenConcurrency ?? 4, async c => {
    const d = await download(c.ip, c.port, cfg.probe.screenBytes ?? 262144, cfg.probe.screenTimeoutMs ?? 3000);
    if (d.ok) screened.push(c);
    else if (VERBOSE) log(`   x ${c.ip} 粗筛失败(${d.err})`);
  });
  log(`HTTP 粗筛通过：${screened.length}/${testList.length}`);
  if (!screened.length) throw new Error('没有节点能完成下载（可能是网络故障或数据全部过期），保留现有 DNS 记录');

  // 5. 多轮正式测速（串行，避免互抢带宽导致排名失真）
  const rounds = Math.max(1, cfg.probe.rounds);
  for (let r = 1; r <= rounds; r++) {
    for (const c of screened) {
      const d = await download(c.ip, c.port, cfg.probe.bytes, cfg.probe.downloadTimeoutMs);
      (c.samples ||= []).push(d);
      if (VERBOSE) log(`   r${r} ${c.ip} ${d.ok ? d.mbps + 'Mbps/' + d.ttfb + 'ms' : 'FAIL(' + d.err + ')'}`);
    }
    log(`第 ${r}/${rounds} 轮实测完成`);
  }

  // 6. 中位数排名
  const ranked = screened.map(c => {
    const ok = c.samples.filter(s => s.ok);
    const mbps = median(ok.map(s => s.mbps));
    return { ...c, mbps, ttfb: median(ok.map(s => s.ttfb)), okRate: ok.length / c.samples.length };
  }).filter(r => r.okRate >= cfg.probe.minOkRate && r.mbps >= cfg.probe.minMedianMbps)
    .sort((a, b) => (b.mbps - a.mbps) || (a.ttfb - b.ttfb));

  log(`合格节点：${ranked.length} 个（要求 ok率≥${cfg.probe.minOkRate}，中位速度≥${cfg.probe.minMedianMbps}Mbps）`);
  for (const r of ranked.slice(0, 12)) log(`   ${r.ip.padEnd(16)} ${r.cc} ${String(r.mbps).padStart(6)}Mbps  ttfb=${r.ttfb}ms  ok=${Math.round(r.okRate * 100)}%`);
  if (!ranked.length) throw new Error('没有节点通过质量门槛，保留现有 DNS 记录不变');

  // 6. 逐记录出方案
  const plan = [];
  for (const rec of (cfg.cloudflare.records || [])) {
    const picked = applyFilter(ranked, rec.filter).slice(0, rec.topN);
    plan.push({ rec, ips: picked.map(r => r.ip), detail: picked });
  }
  log('---- 目标方案 ----');
  for (const p of plan) log(`   ${p.rec.name} (${p.rec.type}, top${p.rec.topN}) <- ${p.ips.join(', ') || '(空)'}`);

  // 7. 与现状比对
  const current = uploadReady ? await listRecords() : [];
  let changed = false;
  for (const p of plan) {
    const cur = current.filter(r => r.name === p.rec.name && r.type === p.rec.type).map(r => r.content).sort();
    const next = [...p.ips].sort();
    p.current = cur; p.next = next;
    p.same = cur.length === next.length && cur.every((v, i) => v === next[i]);
    if (!p.same) changed = true;
    log(`   ${p.rec.name}: 现状[${cur.join(',')}] -> 目标[${next.join(',')}] ${p.same ? '（无变化）' : '（将更新）'}`);
  }

  // 【硬保证】只测速模式 / dry-run：在任何写入动作之前就退出
  if (DRY_RUN) {
    log(flag('--dry-run')
      ? 'DRY-RUN：以上为将要执行的改动，未调用 Cloudflare 写接口。'
      : '只测速模式（未配置 Cloudflare 凭据 / behavior.dryRun=true）：未调用 Cloudflare 写接口，DNS 记录未变动。');
    throw new ExitError(0);
  }
  if (!changed && cfg.behavior.skipIfUnchanged && !FORCE) {
    log('结论：所有记录已是最优集合，跳过写入。');
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastRunAt: new Date().toISOString(), skipped: true, plan: plan.map(p => ({ name: p.rec.name, ips: p.next })) }, null, 2));
    throw new ExitError(0);
  }

  const targets = FORCE ? plan : plan.filter(p => !p.same);
  if (DRY_RUN) throw new Error('内部保护：dry-run 状态下不应进入写入流程');

  // 8. 备份
  if (cfg.behavior.backupBeforeWrite) {
    const bak = path.join(BAK_DIR, `cf-backup-${RUN_ID}.json`);
    fs.writeFileSync(bak, JSON.stringify(current, null, 2), 'utf8');
    log(`已备份现有记录：${bak}`);
  }

  // 9. 写入
  for (const p of targets) {
    const existing = current.filter(r => r.name === p.rec.name && r.type === p.rec.type);
    const keep = new Set(p.next);
    for (const r of existing) {
      if (!keep.has(r.content)) { await deleteRecord(r.id); log(`   DEL ${p.rec.name} ${r.content}`); }
    }
    const have = new Set(existing.map(r => r.content));
    for (const ip of p.next) {
      if (have.has(ip)) continue;
      await createRecord({
        type: p.rec.type, name: p.rec.name, content: ip,
        ttl: p.rec.ttl ?? 300, proxied: p.rec.proxied ?? false, comment: 'cf-best-ip-auto'
      });
      log(`   ADD ${p.rec.name} ${ip}`);
    }
  }

  // 10. 验证
  log('---- 验证 ----');
  const after = await listRecords();
  let allOk = true;
  for (const p of plan) {
    const got = after.filter(r => r.name === p.rec.name && r.type === p.rec.type).map(r => r.content).sort();
    const want = [...p.next].sort();
    const ok = got.length === want.length && got.every((v, i) => v === want[i]);
    if (!ok) allOk = false;
    log(`   权威记录 ${p.rec.name}: ${ok ? 'OK' : '不一致！'} [${got.join(',')}]`);
    if (cfg.behavior.verifyDoh) {
      const pub = await dohCheck(p.rec.name);
      const pubOk = want.every(ip => pub.includes(ip));
      log(`   公网解析 ${p.rec.name}: ${pubOk ? 'OK' : '缓存未过期/待刷新（TTL 300s）'} [${pub.join(',')}]`);
    }
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({
    lastRunAt: new Date().toISOString(),
    dryRun: false,
    ok: allOk,
    applied: targets.map(p => ({ name: p.rec.name, ips: p.next })),
    ranking: ranked.slice(0, 12).map(r => ({ ip: r.ip, cc: r.cc, mbps: r.mbps, ttfb: r.ttfb }))
  }, null, 2), 'utf8');

  log(allOk ? '=========== 完成：写入并验证通过 ===========' : '=========== 完成：但验证存在偏差，请查看日志 ===========');
  done(allOk ? 0 : 3);
} catch (e) {
  if (e && e.isExit) done(e.code);
  else { log(`!! 任务失败：${e.message}`); done(1); }
}
