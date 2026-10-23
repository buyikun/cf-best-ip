// cfip-lib.mjs —— CF 优选两种方案共用的工具函数
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';

// ── 环境自检（方便整个文件夹拷给别人用：先给出人话提示，而不是一堆报错）──
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  console.error('');
  console.error(`  [环境错误] 本项目需要 Node.js 18 或更高版本，当前是 v${process.versions.node}`);
  console.error('  请到 https://nodejs.org/zh-cn/download 下载安装 LTS 版本，然后重新运行。');
  console.error('');
  process.exit(1);
}

export const API = 'https://api.cloudflare.com/client/v4';
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0';

// ── 日志 ──────────────────────────────────────────────────────────
export function createLogger(logDir, runId) {
  fs.mkdirSync(logDir, { recursive: true });
  let buffer = '';
  const log = msg => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    buffer += line + '\n';
    console.log(msg);
  };
  const flush = () => {
    try {
      fs.writeFileSync(path.join(logDir, `cfip-${runId}.log`), buffer, 'utf8');
      fs.writeFileSync(path.join(logDir, 'latest.log'), buffer, 'utf8');
    } catch { /* 忽略 */ }
  };
  return { log, flush };
}

// ── 源解析 ────────────────────────────────────────────────────────
// 线上格式： 1.2.3.4:443#JP [7M]        1.2.3.4:443#HK [高速 by Jz 13M]
// 旧版格式： 1.2.3.4:443#JP [45ms 12Mbps]
const RE_SPEED = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)#([A-Z]{2})?\s*\[(?:高速\s*by\s*Jz\s+)?(\d+)\s*M\]\s*$/;
const RE_LAT_BW = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)#([A-Z]{2})?\s*\[(\d+)ms\s+([\d.]+)\s*Mbps\]\s*$/;
const RE_LOOSE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?(?:#([A-Z]{2}))?/;

export function parseLines(text, defaultPort = 443) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let m = line.match(RE_SPEED);
    if (m) { out.push({ ip: m[1], port: +m[2], cc: m[3] || '', fileMs: 0, fileMbps: +m[4] }); continue; }
    m = line.match(RE_LAT_BW);
    if (m) { out.push({ ip: m[1], port: +m[2], cc: m[3] || '', fileMs: +m[4], fileMbps: +m[5] }); continue; }
    m = line.match(RE_LOOSE);
    if (m) out.push({ ip: m[1], port: m[2] ? +m[2] : defaultPort, cc: m[3] || '', fileMs: 0, fileMbps: 0 });
  }
  const seen = new Set();
  return out.filter(r => (seen.has(r.ip) ? false : (seen.add(r.ip), true)));
}

/**
 * 解析 HTML 页面里的优选 IP 表格（如 api.uouin.com/cloudflare.html）
 * 页面结构：每行 = 序号 | 运营商(电信/联通/移动) | IP | 丢包率
 * 没有端口信息 -> 默认 443
 * 返回格式与 parseLines 一致，cc 字段借用运营商（TEL/UNI/CMB），filter 也能用
 */
export function parseHtmlTable(html) {
  const out = [];
  const carrierMap = { '电信': 'TEL', '联通': 'UNI', '移动': 'CMB' };
  // 匹配每个 <tr>...</tr> 里的 <td> 内容
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRe.exec(html))) {
    const cells = [...rm[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(c => c[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (cells.length < 3) continue;
    // 找一个形如 IP 的单元格
    const ipIdx = cells.findIndex(c => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(c));
    if (ipIdx < 0) continue;
    const ip = cells[ipIdx];
    const carrierRaw = cells.slice(0, ipIdx).find(c => carrierMap[c]) || '';
    out.push({
      ip,
      port: Number(defaultPortOf()),
      cc: carrierMap[carrierRaw] || '',
      carrier: carrierRaw,
      fileMs: 0,
      fileMbps: 0
    });
  }
  const seen = new Set();
  return out.filter(r => (seen.has(r.ip) ? false : (seen.add(r.ip), true)));
}

function defaultPortOf() {
  return 443;
}

/** 判断一段文本是不是 HTML（而不是纯文本订阅） */
export function looksLikeHtml(text) {
  const head = text.slice(0, 400).toLowerCase();
  return head.includes('<!doctype html') || head.includes('<html') || (head.includes('<table') && head.includes('<tr'));
}

/** 智能解析：HTML 表格 或 纯文本订阅 都支持 */
export function parseAny(text, defaultPort = 443) {
  if (!text) return [];
  if (looksLikeHtml(text)) {
    const rows = parseHtmlTable(text);
    return rows.length ? rows : [];
  }
  return parseLines(text, defaultPort);
}

export async function httpGet(url, timeout = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'cfip-auto/2.0' }, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function noteFreshness(url, log) {
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

// 多源合并拉取；全失败时回退缓存文件，再回退本地快照
export async function loadSource(sourceCfg, cfgDir, log) {
  const s = sourceCfg || {};
  const urls = (s.urls && s.urls.length) ? s.urls : (s.url ? [s.url] : []);
  const cachePath = s.cacheFile ? path.resolve(cfgDir, s.cacheFile) : '';

  if (s.preferUrl !== false && urls.length) {
    const merged = new Map();
    let used = 0;
    for (const entry of urls) {
      // 每个源可以是纯字符串，也可以是 {url, tier:'fresh'|'legacy', name}
      const u = typeof entry === 'string' ? entry : entry.url;
      const tier = (typeof entry === 'object' && entry.tier) || 'fresh';
      const label = (typeof entry === 'object' && entry.name) || '';
      if (!u) continue;
      const txt = await httpGet(u);
      const rows = txt ? parseAny(txt) : [];          // 自动兼容 HTML 表格与纯文本订阅
      if (!rows.length) { log(`   源不可用或解析为空，跳过：${u}`); if (s.merge) continue; else break; }
      used++;
      const kind = txt && looksLikeHtml(txt) ? 'HTML表格' : '纯文本';
      const tag = tier === 'legacy' ? '旧源' : '新鲜源';
      log(`源：${u}${label ? ` [${label}]` : ''}（${rows.length} 个节点，${kind}，${tag}）`);
      await noteFreshness(u, log);
      for (const r of rows) {
        const prev = merged.get(r.ip);
        // 同 IP 重复出现时：优先保留"新鲜源"的记录；同档内保留速度标注更高的
        const prevBetterTier = prev && (prev.tier !== 'legacy');
        const curBetterTier = tier !== 'legacy';
        const better = !prev
          || (!prevBetterTier && curBetterTier)
          || (prev.tier === tier && r.fileMbps > prev.fileMbps)
          || (prev.tier === tier && r.fileMbps === prev.fileMbps && r.fileMs > 0 && (!prev.fileMs || r.fileMs < prev.fileMs));
        if (better) merged.set(r.ip, { ...r, tier, sourceLabel: label || u });
      }
      if (!s.merge) break;
      if (cachePath) { try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, txt, 'utf8'); } catch { /* 忽略 */ } }
    }
    if (merged.size) {
      const list = [...merged.values()];
      const nFresh = list.filter(r => r.tier !== 'legacy').length;
      const nLegacy = list.length - nFresh;
      log(`合并去重后共 ${list.length} 个节点（新鲜源 ${nFresh} 个 / 旧源 ${nLegacy} 个）`);
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
export function tcpProbe(ip, port, timeout = 1500) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const sock = net.connect({ host: ip, port });
    let done = false;
    const fin = (ok, err) => {
      if (done) return; done = true;
      try { sock.destroy(); } catch { /* 忽略 */ }
      resolve({ ok, tcpMs: Date.now() - t0, err: err || '' });
    };
    sock.setTimeout(timeout, () => fin(false, 'tcp-timeout'));
    sock.on('connect', () => fin(true));
    sock.on('error', e => fin(false, e.code || e.message));
  });
}

export function download(ip, port, bytes, timeout) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let ttfb = 0, got = 0, done = false, guard = null;
    const fin = (ok, err) => {
      if (done) return; done = true;
      if (guard) clearTimeout(guard);
      try { req && req.destroy(); } catch { /* 忽略 */ }
      const total = Date.now() - t0;
      const mbps = ok && total - ttfb > 0 ? (got * 8) / ((total - ttfb) / 1000) / 1e6 : 0;
      resolve({ ok, mbps: +mbps.toFixed(2), ttfb: ok ? ttfb : 0, total, got, err: err || '' });
    };
    const req = https.request({
      host: ip, port, path: `/__down?bytes=${bytes}`, method: 'GET',
      servername: 'speed.cloudflare.com', rejectUnauthorized: false,
      headers: { Host: 'speed.cloudflare.com', 'User-Agent': UA }
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return fin(false, 'HTTP ' + res.statusCode); }
      res.on('data', c => { if (!ttfb) ttfb = Date.now() - t0; got += c.length; });
      res.on('end', () => fin(true));
      res.on('error', e => fin(false, e.code || e.message));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('dl-timeout')));
    guard = setTimeout(() => fin(false, 'guard-timeout'), timeout + 2500);
    req.on('error', e => fin(false, e.code || e.message));
    req.end();
  });
}

export async function pool(items, limit, worker) {
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const item = items[i++]; await worker(item); }
  }));
}

export const median = a => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

// ── Cloudflare API ────────────────────────────────────────────────
export function createCf({ apiToken, zoneId }) {
  async function call(method, p, body) {
    const res = await fetch(`${API}${p}`, {
      method,
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
    if (!res.ok || json.success === false) {
      throw new Error(`CF API ${method} ${p} -> HTTP ${res.status} ${JSON.stringify(json.errors || json).slice(0, 300)}`);
    }
    return json.result;
  }
  return {
    list: () => call('GET', `/zones/${zoneId}/dns_records?per_page=200`),
    del: id => call('DELETE', `/zones/${zoneId}/dns_records/${id}`),
    create: r => call('POST', `/zones/${zoneId}/dns_records`, r)
  };
}

const FAKE_IP = /^198\.18\./;   // 本机 Clash/mihomo 的 fake-ip 段

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

export async function dohCheck(name) {
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
export function applyFilter(rows, filter) {
  if (!filter || !filter.tokens || filter.tokens.length === 0) return rows;
  const set = new Set(filter.tokens.map(t => t.toUpperCase()));
  const mode = (filter.mode || 'deny').toLowerCase();
  return mode === 'allow' ? rows.filter(r => set.has(r.cc)) : rows.filter(r => !set.has(r.cc));
}

// ── 探测历史（早停方案靠它优先复用上次的好节点）──────────────────
export function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
export function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch { /* 忽略 */ }
}

// ── 本地网络带宽探测（speedtest，不是到 CF 的速度）─────────────────
// 用来给早停方案定达标线：本地带宽 × ratio
const SPEED_SOURCES = [
  'https://mirrors.aliyun.com/ubuntu-releases/22.04/ubuntu-22.04.5-desktop-amd64.iso',
  'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/22.04/ubuntu-22.04.5-desktop-amd64.iso',
  'https://mirrors.ustc.edu.cn/ubuntu-releases/22.04/ubuntu-22.04.5-desktop-amd64.iso',
  'https://mirrors.cloud.tencent.com/ubuntu-releases/22.04/ubuntu-22.04.5-desktop-amd64.iso'
];

function measureUrl(url, seconds, maxBytes) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let got = 0, tStart = 0, done = false;
    const fin = (ok, err) => {
      if (done) return; done = true;
      const ref = tStart || t0;
      const el = (Date.now() - ref) / 1000;
      try { req.destroy(); } catch { /* 忽略 */ }
      resolve({ mbps: ok && el > 0.3 ? (got * 8) / el / 1e6 : 0, got, el: +el.toFixed(2), err: err || '' });
    };
    const req = https.get(url, {
      headers: { Range: `bytes=0-${maxBytes - 1}`, 'User-Agent': UA }
    }, res => {
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return fin(false, 'HTTP ' + res.statusCode); }
      res.on('data', c => {
        if (!tStart) tStart = Date.now();
        got += c.length;
        const el = (Date.now() - tStart) / 1000;
        if (el >= seconds || got >= maxBytes) fin(true);
      });
      res.on('end', () => fin(true));
      res.on('error', e => fin(false, e.code || e.message));
    });
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.on('error', e => fin(false, e.code || e.message));
  });
}

// 若本机装了 Ookla speedtest CLI，优先用它（最接近“speedtest 结果”）
async function trySpeedtestCli(log) {
  const { execFile } = await import('node:child_process');
  const cands = ['speedtest', 'speedtest.exe', 'C:\\Program Files\\Speedtest\\speedtest.exe'];
  for (const bin of cands) {
    const out = await new Promise(res => {
      try {
        execFile(bin, ['--format=json', '--accept-license', '--accept-gdpr'], { timeout: 120000, windowsHide: true }, (err, stdout) => res(err ? '' : stdout));
      } catch { res(''); }
    });
    if (!out) continue;
    try {
      const j = JSON.parse(out);
      const mbps = j.download?.bandwidth ? (j.download.bandwidth * 8) / 1e6 : 0;
      if (mbps > 0) { log(`   speedtest CLI：下载 ${mbps.toFixed(1)}Mbps（服务器 ${j.server?.name || '?'}）`); return mbps; }
    } catch { /* 继续试下一个 */ }
  }
  return 0;
}

export async function measureLocalBandwidth({ seconds = 4, maxBytes = 52428800, cacheFile, cacheTtlHours = 24, profileKey = 'default', log = console.log, useSpeedtestCli = true } = {}) {
  const store = readJson(cacheFile, { profiles: {} });
  const prof = (store.profiles || {})[profileKey];
  if (prof && prof.bandwidthMbps > 0 && prof.bandwidthAt && (Date.now() - Date.parse(prof.bandwidthAt)) / 3600000 < cacheTtlHours) {
    log(`本地网络带宽：沿用本网络档案缓存 ${prof.bandwidthMbps}Mbps（${new Date(prof.bandwidthAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}，来源 ${prof.source}）`);
    return { mbps: prof.bandwidthMbps, source: prof.source, cached: true };
  }
  let mbps = 0, src = '';
  if (useSpeedtestCli) {
    mbps = await trySpeedtestCli(log);
    if (mbps > 0) src = 'speedtest-cli';
  }
  if (!mbps) {
    log(`   本机无 speedtest CLI，改用镜像站实测本地下行带宽（每源测 ${seconds}s）`);
    let best = { mbps: 0, source: '' };
    for (const u of SPEED_SOURCES) {
      const r = await measureUrl(u, seconds, maxBytes);
      const host = new URL(u).host;
      if (r.mbps > 0) log(`   ${host} -> ${r.mbps.toFixed(1)}Mbps`);
      if (r.mbps > best.mbps) best = { mbps: r.mbps, source: host };
      if (best.mbps >= 300) break;
    }
    mbps = best.mbps; src = best.source;
  }
  if (mbps > 0 && cacheFile) {
    store.profiles ||= {};
    store.profiles[profileKey] = { ...(store.profiles[profileKey] || {}), bandwidthMbps: +mbps.toFixed(1), bandwidthAt: new Date().toISOString(), source: src };
    writeJson(cacheFile, store);
  }
  return { mbps: +mbps.toFixed(1), source: src, cached: false };
}

// ── 网络指纹：换 WiFi / 换运营商后自动重新校准，换回来还能复用原阈值 ──
export async function getNetworkProfile(log = console.log) {
  const info = { ip: '', asn: '', isp: '' };
  try {
    const t = await httpGet('https://api.ip.sb/geoip', 6000);
    if (t) { const j = JSON.parse(t); info.ip = j.ip || ''; info.asn = j.asn ? 'AS' + j.asn : ''; info.isp = j.isp || j.organization || ''; }
  } catch { /* 忽略 */ }
  if (!info.ip) {
    try {
      const t = await httpGet('https://ipinfo.io/json', 6000);
      if (t) {
        const j = JSON.parse(t); info.ip = j.ip || '';
        const m = (j.org || '').match(/^(AS\d+)\s+(.*)$/);
        if (m) { info.asn = m[1]; info.isp = m[2]; }
      }
    } catch { /* 忽略 */ }
  }
  if (!info.ip) {
    const t = await httpGet('https://www.cloudflare.com/cdn-cgi/trace', 6000);
    const m = t && t.match(/^ip=(.+)$/m);
    if (m) info.ip = m[1].trim();
  }
  const prefix = info.ip ? info.ip.split('.').slice(0, 2).join('.') : 'unknown';
  const key = `${info.asn || 'AS?'}|${prefix}`;
  log(`网络指纹：${key}${info.isp ? '（' + info.isp + '）' : ''}${info.ip ? '  出口 IP ' + info.ip : ''}`);
  return { ...info, prefix, key };
}

// 网络档案（按指纹存放各自校准出的阈值）
export function readProfileStore(file) { return readJson(file, { profiles: {} }); }
export function saveProfileStore(file, store) { writeJson(file, store); }

// ── 定位"项目根目录"：从脚本目录逐级向上找，找到**同时含 var\ 目录或 run-*.cmd**的那层。
// 这样程序文件放进 src\ 子目录后，依然能正确找到根目录下的 user.config.jsonc 与运行产物目录。
export function findBaseDir(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 5; i++) {
    const hasVar = fs.existsSync(path.join(dir, 'var'));
    const hasRunner = fs.existsSync(path.join(dir, 'run-fast.cmd')) || fs.existsSync(path.join(dir, 'run-full.cmd'));
    const hasUserCfg = fs.existsSync(path.join(dir, 'user.config.jsonc'))
      || fs.existsSync(path.join(dir, 'user.config.jsonc.example'));
    // 根目录特征：有 run 脚本，或有 var\ + 用户配置；src\ 自身不会满足
    if (hasRunner || (hasVar && hasUserCfg)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(startDir);
}

// ── 配置加载：默认配置 + 用户配置文件（JSONC，支持 // 和 /* */ 注释）──
export function parseJsonc(text) {
  let out = '', inStr = false, inLine = false, inBlock = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  // 顺手干掉对象/数组结尾多余逗号
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

// 用户配置覆盖默认配置（对象递归合并，数组整体替换）
export function mergeConfig(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (k.startsWith('_')) continue;                       // 跳过注释字段
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeConfig(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 加载配置：
 *   basePath —— cfip.config.json（程序默认值）
 *   userPath —— user.config.jsonc（用户填写的那份）
 * 关键规则：**Cloudflare 上传凭据只认用户文件**，用户文件没填就不上传。
 */
export function loadConfig(basePath, userPath) {
  const base = parseJsonc(fs.readFileSync(basePath, 'utf8'));
  let user = null;
  let userError = '';          // 用户配置文件解析失败的原因（用于友好提示）
  if (userPath && fs.existsSync(userPath)) {
    try {
      user = parseJsonc(fs.readFileSync(userPath, 'utf8'));
    } catch (e) {
      // 常见错误给出人话提示，而不是让用户以为"没配置"
      const raw = fs.readFileSync(userPath, 'utf8');
      const msg = String(e.message || e);
      if (/Unexpected token|Expected|property name|after property value/i.test(msg)) {
        const m = msg.match(/position (\d+)/);
        let hint = '';
        if (m) {
          const pos = Number(m[1]);
          const before = raw.slice(0, pos);
          const line = before.split(/\r?\n/).length;
          const col = pos - before.lastIndexOf('\n');
          hint = `（第 ${line} 行第 ${col} 列附近）`;
        }
        userError = `配置文件 ${path.basename(userPath)} 格式有误${hint}：${msg}\n     常见原因：多写了逗号、少了逗号、用了单引号(要用双引号)、注释符号没闭合`;
      } else {
        userError = `配置文件 ${path.basename(userPath)} 读取失败：${msg}`;
      }
      user = null;
    }
  }
  const cfg = user ? mergeConfig(base, user) : base;
  const ucf = (user && user.cloudflare) || {};
  // 逐项判断缺失了什么，便于给出精确提示
  const missing = [];
  if (!ucf.apiToken) missing.push('apiToken');
  if (!ucf.zoneId) missing.push('zoneId');
  if (!Array.isArray(ucf.records) || !ucf.records.length) missing.push('records');
  const uploadReady = missing.length === 0;
  // 无论默认配置里写了什么，上传信息一律以用户文件为准
  cfg.cloudflare = uploadReady
    ? ucf
    : { ...(ucf || {}), apiToken: '', zoneId: '', records: [] };
  return { cfg, user, userPath, uploadReady, missing, userError, userConfigExists: !!(userPath && fs.existsSync(userPath)) };
}

// ── 清理旧文件：备份 / 日志只保留最近 N 份 ────────────────────────
export function pruneOldFiles(dir, pattern, keep, log) {
  try {
    if (!fs.existsSync(dir)) return 0;
    const files = fs.readdirSync(dir)
      .filter(f => pattern.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    const victims = files.slice(Math.max(0, keep));
    for (const v of victims) {
      try { fs.unlinkSync(path.join(dir, v.f)); if (log) log(`   清理旧文件：${v.f}`); } catch { /* 忽略 */ }
    }
    return victims.length;
  } catch { return 0; }
}
