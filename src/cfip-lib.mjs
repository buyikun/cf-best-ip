// cfip-lib.mjs —— CF 优选两种方案共用的工具函数
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import tls from 'node:tls';
import http2 from 'node:http2';

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
// 尾部 (?=[\s|,;)\]]|$) 很关键：国家码后面必须是分隔符或行尾，
// 否则 `#VPS789优选`、`#CFYes`、`#CM优选` 会被误读成 VP / CF / CM 这样的假国家码。
const RE_LOOSE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?(?:#([A-Z]{2})(?=[\s|,;)\]]|$))?/;

// 常见国家/地区码白名单。
// 用途：很多聚合订阅（free-nodes/bestcf 等）把国家码写在 # 后面的自由文本里，
// 形如 `1.2.3.4:443#天诚优选1 | 港岛茶记 | HK | 1.2.3.4:443`，
// 而不是紧贴 # 的 `#HK`。靠白名单从这段文本里挑出国家码，
// 可以避免把「TG:@MiaChatChannel」的 TG、「…Entry IP TOP50」的 IP 之类误当成国家。
const CC_WHITELIST = new Set([
  'HK', 'TW', 'MO', 'JP', 'KR', 'KP', 'MN',
  'SG', 'MY', 'TH', 'VN', 'PH', 'ID', 'KH', 'LA', 'MM', 'BN',
  'IN', 'PK', 'BD', 'LK', 'NP',
  'AU', 'NZ', 'GU',
  'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'VE', 'EC', 'UY', 'PY', 'BO', 'CR', 'PA', 'PR', 'VI',
  'GB', 'UK', 'IE', 'FR', 'DE', 'NL', 'BE', 'LU', 'CH', 'AT', 'IT', 'ES', 'PT', 'MT', 'CY', 'GR',
  'SE', 'NO', 'FI', 'DK', 'IS', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'HR', 'SI', 'RS', 'EE', 'LV', 'LT',
  'RU', 'UA', 'BY', 'MD', 'GE', 'AM', 'AZ', 'KZ', 'UZ',
  'TR', 'IL', 'AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'JO', 'LB',
  'ZA', 'EG', 'NG', 'KE', 'MA', 'TN', 'DZ', 'GH', 'TZ', 'UG',
  'CN'
]);

// 零宽字符等不可见字符：某些源（bestcf.tools12345.com 系）为防止被脚本抓取，
// 会在字母之间插入 U+200B 零宽空格 —— 看起来是 "HK"，实际字节是 "H\u200BK"。
// 注意这里只清零宽类字符，不把普通空格/NBSP 也删掉，否则 "HK TG" 会粘成 "HKTG"。
const INVISIBLE_RE = /[\u200b\u200c\u200d\u200e\u200f\u2060\ufeff\u00ad\u180e]/g;

/** 从 # 后面的自由文本里挑一个国家/地区码；挑不到返回 '' */
function ccFromNote(note) {
  if (!note) return '';
  const cleaned = note.replace(INVISIBLE_RE, '');
  for (const tok of cleaned.split(/[^A-Za-z]+/)) {
    if (tok.length !== 2) continue;
    const up = tok.toUpperCase();
    if (CC_WHITELIST.has(up)) return up;
  }
  return '';
}

export function parseLines(text, defaultPort = 443) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // # 后面是一段自由文本注释；有些源把国家码写在这里面
    const hash = line.indexOf('#');
    const note = hash >= 0 ? line.slice(hash + 1) : '';
    let m = line.match(RE_SPEED);
    if (m) { out.push({ ip: m[1], port: +m[2], cc: m[3] || ccFromNote(note), fileMs: 0, fileMbps: +m[4] }); continue; }
    m = line.match(RE_LAT_BW);
    if (m) { out.push({ ip: m[1], port: +m[2], cc: m[3] || ccFromNote(note), fileMs: +m[4], fileMbps: +m[5] }); continue; }
    m = line.match(RE_LOOSE);
    if (m) out.push({ ip: m[1], port: m[2] ? +m[2] : defaultPort, cc: m[3] || ccFromNote(note), fileMs: 0, fileMbps: 0 });
  }
  const seen = new Set();
  return out.filter(r => (seen.has(r.ip) ? false : (seen.add(r.ip), true)));
}

/**
 * 解析 HTML 页面里的优选 IP 表格（部分源用网页表格发布，而非纯文本）
 * 页面结构：每行 = 序号 | 运营商(电信/联通/移动/多线) | IP | 丢包率 | ...
 * 没有端口信息 -> 默认 443
 * 返回格式与 parseLines 一致，cc 字段借用运营商（TEL/UNI/CMB/MUL），filter 也能用
 */
export function parseHtmlTable(html) {
  const out = [];
  // 这类运营商表格页面出现过 4 种分组：电信/联通/移动/多线
  const carrierMap = { '电信': 'TEL', '联通': 'UNI', '移动': 'CMB', '多线': 'MUL', 'All': 'MUL', '全局': 'MUL' };
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
      fileMbps: 0,
      // 页面里还有一列形如 "21.55mb/s" 的实测带宽，顺手解析出来当排序参考
      fileMbps: (() => {
        const mb = cells.find(c => /^\d+(?:\.\d+)?mb\/s$/i.test(c));
        return mb ? +mb.replace(/mb\/s/i, '') : 0;
      })()
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
      // 拉取单个源，失败自动重试。
      //   为什么必须重试：raw.githubusercontent.com 实测存在偶发失败
      //   （同一个 URL 第一次 HTTP 000、紧接着两次都 200）。
      //   以前只拉一次，一次抖动就把整个源丢掉，而丢掉的往往是命中率最高的源。
      let txt = '';
      const tries = Math.max(1, Number(s.fetchRetries ?? 3));
      for (let i = 0; i < tries; i++) {
        txt = await httpGet(u);
        if (txt) break;
        if (i < tries - 1) {
          log(`   源拉取失败，${i + 1}/${tries} 次重试中：${u}`);
          await new Promise(r => setTimeout(r, 800 * (i + 1)));
        }
      }
      const rowsAll = txt ? parseAny(txt) : [];       // 自动兼容 HTML 表格与纯文本订阅
      if (!rowsAll.length) {
        log(`   源不可用或解析为空（已试 ${tries} 次），跳过：${u}`);
        if (s.merge) continue; else break;
      }
      // DNS 的 A 记录只能写 IP、不能写端口，用户访问默认走 443。
      // 所以只保留 443 端口的节点；其余端口（8443/2087/11371…）写进 DNS 也访问不通。
      const rows = rowsAll.filter(r => r.port === 443);
      const droppedPort = rowsAll.length - rows.length;
      if (!rows.length) { log(`   源里没有 443 端口的节点，跳过：${u}`); if (s.merge) continue; else break; }
      used++;
      const kind = txt && looksLikeHtml(txt) ? 'HTML表格' : '纯文本';
      const tag = tier === 'legacy' ? '旧源' : '新鲜源';
      log(`源：${u}${label ? ` [${label}]` : ''}（${rows.length} 个 443 节点${droppedPort ? `，另有 ${droppedPort} 个非 443 端口已忽略` : ''}，${kind}，${tag}）`);
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

  // 缓存/快照里可能残留历史写入的非 443 端口条目，这里同样只保留 443
  const pick443 = list => list.filter(r => r.port === 443);

  if (cachePath && fs.existsSync(cachePath)) {
    const rows = pick443(parseLines(fs.readFileSync(cachePath, 'utf8')));
    if (rows.length) { log(`源：本地缓存 ${cachePath}（${rows.length} 个 443 节点）`); return rows; }
  }

  const file = s.file;
  if (!file || !fs.existsSync(file)) throw new Error(`线上源不可用，本地文件也不存在: ${file}`);
  const ageMin = (Date.now() - fs.statSync(file).mtimeMs) / 60000;
  log(`源：${file}（${ageMin.toFixed(0)} 分钟前更新）`);
  if (s.maxAgeMinutes > 0 && ageMin > s.maxAgeMinutes) log(`   警告：文件已超过 maxAgeMinutes=${s.maxAgeMinutes}，可能是旧数据`);
  return pick443(parseLines(fs.readFileSync(file, 'utf8')));
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

export function download(ip, port, bytes, timeout, onProgress) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let ttfb = 0, got = 0, done = false, guard = null;
    let lastTick = 0, colo = '';
    const fin = (ok, err) => {
      if (done) return; done = true;
      if (guard) clearTimeout(guard);
      try { req && req.destroy(); } catch { /* 忽略 */ }
      const total = Date.now() - t0;
      const mbps = ok && total - ttfb > 0 ? (got * 8) / ((total - ttfb) / 1000) / 1e6 : 0;
      resolve({ ok, mbps: +mbps.toFixed(2), ttfb: ok ? ttfb : 0, total, got, colo, err: err || '' });
    };
    const req = https.request({
      host: ip, port, path: withBytes(SPEED_PATH, bytes), method: 'GET',
      servername: SPEED_HOST, rejectUnauthorized: false,
      // Accept-Encoding: identity —— 要服务器别压缩，否则「下载了多少字节」不等于「实际传输量」，
      //   速度会被算歪。参考 CFData-WEB combined_refactor/tasks_speed.go:49 的同一处理。
      headers: { Host: SPEED_HOST, 'User-Agent': UA, 'Accept-Encoding': 'identity' }
    }, res => {
      // 1. 状态码必须是 200（429 单独标注：Cloudflare 对测速接口有限速，
      //   「被限速」和「节点慢」是两回事，混在一起会让人误以为节点质量差。
      //   参考 CFData-WEB combined_refactor/tasks_speed.go:131-136。）
      if (res.statusCode !== 200) { res.resume(); return fin(false, res.statusCode === 429 ? '限速(429)' : 'HTTP ' + res.statusCode); }

      // 2. 严查是否为真实的 Cloudflare 边缘节点，过滤伪装/默认网页主机（如只返回几KB html 却算成上百Mbps的假节点）
      const server = String(res.headers['server'] || '').toLowerCase();
      const hasCfRay = !!res.headers['cf-ray'];
      // 从 cf-ray 尾部取三位 IATA 码，即流量真实落点的数据中心（colo）。
      // 订阅源标注的国家码与真实落点常常不一致，colo 才是可信的实测归因。
      colo = String(res.headers['cf-ray'] || '').split('-').pop() || '';
      const cType = String(res.headers['content-type'] || '').toLowerCase();
      if (!server.includes('cloudflare') && !hasCfRay) {
        res.resume();
        return fin(false, '非CF节点(Server:' + (server || 'none') + ')');
      }
      if (cType.includes('text/html')) {
        res.resume();
        return fin(false, '返回HTML非测速流');
      }

      res.on('data', c => {
        if (!ttfb) ttfb = Date.now() - t0;
        got += c.length;
        // 每 700ms 回调一次进度，让调用方能实时显示"已下载 xx%"，避免界面看起来卡住
        if (onProgress && Date.now() - lastTick >= 700) {
          lastTick = Date.now();
          const el = (Date.now() - t0) / 1000;          // 用总耗时算瞬时速度
          const cur = el > 0 ? (got * 8) / el / 1e6 : 0;
          try { onProgress({ got, bytes, pct: Math.min(100, Math.round(got / bytes * 100)), mbps: +cur.toFixed(1) }); } catch { /* 忽略 */ }
        }
      });
      res.on('end', () => {
        // 3. 校验接收字节数是否完整（至少达到请求字节数的 85%，防止对端提前截断造成虚假超高速）
        if (got < bytes * 0.85) {
          return fin(false, '数据截断(' + got + '/' + bytes + ')');
        }
        fin(true);
      });
      res.on('error', e => fin(false, e.code || e.message));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('dl-timeout')));
    guard = setTimeout(() => fin(false, 'guard-timeout'), timeout + 2500);
    req.on('error', e => fin(false, e.code || e.message));
    req.end();
  });
}

/**
 * 从采样时间线算出三种速度口径（纯计算，不碰网络，方便单测）。
 *
 * @param {Array<{t:number,got:number}>} timeline 相对时刻(ms) → 累计接收字节数
 * @param {number} warmMs 丢弃前多少毫秒（剥离 TCP 慢启动）
 * @param {number} netSec 净时长（秒）= (totalMs - ttfb)/1000
 * @param {number} got    累计接收字节数
 * @returns {{steadyMbps:number, overallMbps:number, peakMbps:number, ewmaMbps:number}}
 */
export function computeSpeedMetrics(timeline, warmMs, netSec, got) {
  let basePoint = null;
  for (const pt of timeline) {
    if (pt.t >= warmMs) { basePoint = pt; break; }
  }
  const endPoint = timeline[timeline.length - 1] || { t: netSec * 1000, got };
  let steadyMbps = 0;
  if (basePoint && endPoint.t > basePoint.t) {
    const deltaBytes = endPoint.got - basePoint.got;
    const deltaSec = (endPoint.t - basePoint.t) / 1000;
    steadyMbps = deltaSec > 0 ? (deltaBytes * 8) / deltaSec / 1e6 : 0;
  } else {
    steadyMbps = netSec > 0 ? (got * 8) / netSec / 1e6 : 0;
  }
  const overallMbps = netSec > 0 ? (got * 8) / netSec / 1e6 : 0;

  // 1 秒滑动窗口峰值。
  //   为什么不直接看「某两个相邻采样点之间」的瞬时值：单次采样间隔里的字节数会被
  //   内核缓冲/重传打散，用它做除数会得到 0 和尖峰交替的读数。
  //   固定 1 秒窗口把这种抖动抹平，同时还能抓住「这个节点最好能跑到多少」。
  //   借鉴 CFST-GUI internal/task/download.go:41（downloadSpeedWindow = time.Second）
  //   与 :777-795 windowSpeedLocked、:847-850（最高速率同样取滑动窗口速率）。
  const WIN_MS = 1000;
  let peakMbps = 0;
  {
    const pts = timeline.filter(pt => pt.t >= warmMs);
    let j = 0;
    for (let i = 0; i < pts.length; i++) {
      if (j < i) j = i;
      while (j < pts.length && pts[j].t - pts[i].t < WIN_MS) j++;
      if (j >= pts.length) break;
      const dt = (pts[j].t - pts[i].t) / 1000;
      const db = pts[j].got - pts[i].got;
      const rate = dt > 0 ? (db * 8) / dt / 1e6 : 0;
      if (rate > peakMbps) peakMbps = rate;
    }
    if (peakMbps === 0 && steadyMbps > 0) peakMbps = steadyMbps;   // 采样点太稀疏时退回稳态值
  }

  // EWMA（指数加权移动平均）速度 —— 借鉴 XIU2/CloudflareSpeedTest 的 task/download.go：
  //   它把测速窗口切成固定长度的小片，每片把「这片新增的字节数」换算成瞬时速度喂给 EWMA，
  //   最后用收敛值作为速度（那边用的是 VividCortex/ewma 这个库）。
  //   相比「整段简单平均」，EWMA 更看重最近的瞬时表现，但对单次采样的抖动又不敏感 ——
  //   正好对付 CF 节点「忽快忽慢」的毛病。
  //   公式：v = α·cur + (1−α)·v，α = 2/(N+1)；取 N = 5 → α ≈ 0.3333（ewma 库默认年龄）。
  const EWMA_SLICE_MS = 100, EWMA_ALPHA = 2 / 6;
  let ewmaMbps = 0;
  {
    const pts = timeline.filter(pt => pt.t >= warmMs);
    if (pts.length >= 2) {
      let v = 0, n = 0, sliceT = pts[0].t, sliceGot = pts[0].got;
      for (let i = 1; i < pts.length; i++) {
        const dt = pts[i].t - sliceT;
        if (dt < EWMA_SLICE_MS) continue;
        const rate = ((pts[i].got - sliceGot) * 8) / (dt / 1000) / 1e6;
        v = n === 0 ? rate : EWMA_ALPHA * rate + (1 - EWMA_ALPHA) * v;
        n++;
        sliceT = pts[i].t; sliceGot = pts[i].got;
      }
      ewmaMbps = n > 0 ? v : steadyMbps;   // 采样点太稀疏时退回稳态值
    } else ewmaMbps = steadyMbps;
  }

  return { steadyMbps, overallMbps, peakMbps, ewmaMbps };
}

/**
 * 现代稳态测速引擎：固定时长测速（Duration-based），并剥离 TCP 慢启动
 * 
 * 优势：
 * 1. 慢节点绝不死等：到达 duration 秒强制斩断，绝不卡死界面
 * 2. 快节点拉满极速：给足时间爬坡，丢弃前 warmSeconds 秒慢启动，测出真实的稳态极限带宽
 */
export function downloadTimed(ip, port, durationSeconds = 2.5, warmSeconds = 0.8, onProgress = null) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let ttfb = 0, got = 0, done = false, timer = null, guardTimer = null, colo = '';
    const timeline = [];

    const fin = (ok, err = '', retryAfter = 0) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (guardTimer) clearTimeout(guardTimer);
      try { req && req.destroy(); } catch {}

      const totalMs = Date.now() - t0;
      if (!ok) {
        return resolve({ ok: false, err: err || 'failed', retryAfter, totalMs, ttfb, mbps: 0, steadyMbps: 0, peakMbps: 0, ewmaMbps: 0, got, colo });
      }

      // 剥离慢启动，算出三种速度口径（纯计算部分抽成 computeSpeedMetrics，便于单测）
      const warmMs = warmSeconds * 1000;
      const netSecTotal = (totalMs - ttfb) / 1000;
      const { steadyMbps, overallMbps, peakMbps, ewmaMbps } = computeSpeedMetrics(timeline, warmMs, netSecTotal, got);
      resolve({
        ok: true,
        err: '',
        retryAfter: 0,
        totalMs,
        ttfb,
        got,
        colo,
        mbps: +steadyMbps.toFixed(2),       // 默认对外暴露的值即为稳态速度
        overallMbps: +overallMbps.toFixed(2),
        steadyMbps: +steadyMbps.toFixed(2),
        peakMbps: +peakMbps.toFixed(2),     // 1 秒滑动窗口峰值（判定指标可选，见 cfg.*.speedMetric）
        ewmaMbps: +ewmaMbps.toFixed(2),     // EWMA 加权平均（判定指标可选，见 cfg.*.speedMetric）
        duration: +netSecTotal.toFixed(2)
      });
    };

    // CF 官方接口单次最大允许 50MB (52428800)
    const bigBytes = 52428800;
    const req = https.request({
      host: ip, port, path: withBytes(SPEED_PATH, bigBytes), method: 'GET',
      servername: SPEED_HOST, rejectUnauthorized: false,
      headers: { Host: SPEED_HOST, 'User-Agent': UA, 'Accept-Encoding': 'identity' }
    }, res => {
      if (res.statusCode !== 200) {
        // 429 是 Cloudflare 对这个节点限速；实测 403 也常常是同一套拒绝（探针里
        //   speed.cloudflare.com/__down 的 12MB、以及 cf.xiu2.xyz、cf.090227.xyz 都出现过 403）。
        // 把 Retry-After 带回去，才能告诉用户「这个节点要等多久」，而不是干巴巴一个 0Mbps。
        const ra = Number(res.headers['retry-after']);
        const label = res.statusCode === 429 ? '限速(429)' : (res.statusCode === 403 ? '被拒(403)' : 'HTTP ' + res.statusCode);
        res.resume();
        return fin(false, label, Number.isFinite(ra) && ra > 0 ? ra : 0);
      }
      const server = String(res.headers['server'] || '').toLowerCase();
      const hasCfRay = !!res.headers['cf-ray'];
      colo = String(res.headers['cf-ray'] || '').split('-').pop() || '';
      const cType = String(res.headers['content-type'] || '').toLowerCase();
      if (!server.includes('cloudflare') && !hasCfRay) { res.resume(); return fin(false, '非CF节点'); }
      if (cType.includes('text/html')) { res.resume(); return fin(false, '返回HTML'); }

      let lastReport = 0;
      res.on('data', chunk => {
        const now = Date.now();
        if (!ttfb) {
          ttfb = now - t0;
          timer = setTimeout(() => fin(true), durationSeconds * 1000);
        }
        got += chunk.length;
        const relMs = now - (t0 + ttfb);
        timeline.push({ t: relMs, got });

        if (onProgress && now - lastReport >= 500) {
          lastReport = now;
          const curSec = relMs / 1000;
          const curMbps = curSec > 0 ? (got * 8) / curSec / 1e6 : 0;
          try { onProgress({ elapsedSec: +curSec.toFixed(1), targetSec: durationSeconds, curMbps: +curMbps.toFixed(1) }); } catch {}
        }
      });
      res.on('end', () => fin(true));
      res.on('error', e => fin(false, e.code || e.message));
    });

    req.setTimeout(4000, () => req.destroy(new Error('ttfb-timeout')));
    guardTimer = setTimeout(() => fin(false, 'guard-timeout'), (durationSeconds + 4) * 1000);
    req.on('error', e => fin(false, e.code || e.message));
    req.end();
  });
}

/**
 * 多连接测速：同一个 IP 同时开 connections 条连接，返回合计吞吐。
 *
 * 为什么要多条：单条 TCP 连接受流控/接收窗口限制，往往吃不满这个节点实际能给到的带宽，
 *   于是「单连接测出来的速度」会系统性偏低（实测同一节点 4 连接合计比单连接快约 1.5 倍）。
 *   而浏览器看视频/下载本身也是多连接，所以多连接的口径更接近真实体验。
 *   借鉴 CFST-GUI internal/task/download.go:34 `defaultDownloadGetConcurrency = 4`
 *   （其注释见 :42-44：默认单 IP 串行，但允许用并发换准确度）。
 *
 * 合计口径：只累加成功连接的吞吐；全部失败才算失败。
 *   ttfb 取各连接中最快的一个（代表「首字节要等多久」）。
 *
 * @param {number} connections 连接数，1 表示退回单连接（与 downloadTimed 完全一致）
 */
export async function downloadTimedMulti(ip, port, durationSeconds = 2.5, warmSeconds = 0.8, connections = 1, onProgress = null, metric = 'steady', limitedAsFail = true) {
  const n = Math.max(1, Math.min(16, Math.floor(Number(connections)) || 1));
  const isLimited = s => /限速\(429\)|被拒\(403\)/.test(String(s || ''));
  if (n === 1) {
    const r = await measureOnce(ip, port, durationSeconds, warmSeconds, onProgress);
    const m = metric === 'peak' ? (r.peakMbps || r.mbps || 0)
            : metric === 'ewma' ? (r.ewmaMbps || r.mbps || 0)
            : (r.mbps || 0);
    return { ...r, mbps: +m.toFixed(2), connections: 1, okCount: r.ok ? 1 : 0, limitedCount: (!r.ok && isLimited(r.err)) ? 1 : 0 };
  }

  const parts = await Promise.all(
    Array.from({ length: n }, () => measureOnce(ip, port, durationSeconds, warmSeconds, null))
  );
  const okParts = parts.filter(p => p.ok);
  const sum = k => okParts.reduce((a, p) => a + (Number(p[k]) || 0), 0);
  const steadyMbps = sum('steadyMbps');
  const overallMbps = sum('overallMbps');
  const peakMbps = sum('peakMbps');
  const ewmaMbps = sum('ewmaMbps');
  const ttfbList = okParts.map(p => p.ttfb).filter(v => v > 0);
  // 【限速可见性】多连接只要有一条成功就算成功，所以「4 条里 3 条吃 429」会被悄悄掩盖，
  //   最后只表现为「这个节点有点慢」。把受限条数和 Retry-After 暴露出来，日志才能分清
  //   「节点本来就慢」和「节点被 Cloudflare 限速了」——这两件事的处理方式完全不同。
  const limitedCount = parts.filter(p => !p.ok && isLimited(p.err)).length;
  const retryAfter = Math.max(0, ...parts.map(p => Number(p.retryAfter) || 0));
  // 【借鉴 CFST-GUI 的 429 语义】internal/task/download.go:492 把 429 当作「无效结果」
  //   （invalidDownloadResultWithRetryAfter("rate_limited", true, retryAfter)），随后按
  //   Retry-After 退避重试。我们等不起（实测 Retry-After 37~60 分钟），所以改成
  //   「只要有连接被限速，这一轮测量就判无效」—— 否则合计速度只是剩下几条连接的和，
  //   会系统性低估这个节点：既可能冤枉好节点，也可能让正在限流的节点混进排名。
  //   想退回旧行为（只标注、不判死）就把 limitedAsFail 设为 false。
  const limited = limitedAsFail !== false && limitedCount > 0;
  const okFinal = okParts.length > 0 && !limited;

  return {
    ok: okFinal,
    limitedCount,
    retryAfter,
    err: okFinal ? '' : (limited ? '限速(429)' : (limitedCount === n ? '限速(429)' : (parts.find(p => p.err)?.err || 'failed'))),
    totalMs: Math.max(...parts.map(p => Number(p.totalMs) || 0)),
    ttfb: ttfbList.length ? Math.min(...ttfbList) : 0,
    got: sum('got'),
    colo: okParts.find(p => p.colo)?.colo || '',
    protocol: okParts.find(p => p.protocol)?.protocol || 'h1',
    // mbps 是对外暴露的判定值：steady = 稳态均值（默认），peak = 1 秒滑动窗口峰值，ewma = 指数加权平均
    mbps: okFinal ? +(metric === 'peak' ? peakMbps : metric === 'ewma' ? ewmaMbps : steadyMbps).toFixed(2) : 0,
    overallMbps: okFinal ? +overallMbps.toFixed(2) : 0,
    steadyMbps: okFinal ? +steadyMbps.toFixed(2) : 0,
    peakMbps: okFinal ? +peakMbps.toFixed(2) : 0,
    ewmaMbps: okFinal ? +ewmaMbps.toFixed(2) : 0,
    duration: Math.max(...parts.map(p => Number(p.duration) || 0)),
    connections: n,
    okCount: okParts.length
  };
}

// ── 协议选项（借鉴 CFST-GUI internal/httpclient/client.go:25-29 的 Protocol*
//   与 internal/task/download.go:35 `defaultDownloadHTTPProtocol = ProtocolAuto`）──
//   'h1'   只用 HTTP/1.1（默认）
//   'h2'   用 HTTP/2（http2.connect）
//   'auto' 先看节点 ALPN：给 h2 就用 h2，否则 h1（每个节点多一次 TLS 握手）
//   'h3'   HTTP/3（QUIC）—— Node 核心没有 QUIC 实现，会退回 auto 并提示
// 实测提醒：社区里那些「优选 IP」绝大多数只协商 http/1.1（第三方中转/反代只做 h1 转发），
//   所以默认用 h1，不要白白多花一次握手。
let PROTOCOL = 'h1';
export function setProtocol(p) {
  const v = String(p || '').toLowerCase();
  PROTOCOL = ['h1', 'h2', 'auto', 'h3'].includes(v) ? v : 'h1';
  return PROTOCOL;
}
export function getProtocol() { return PROTOCOL; }

// ALPN 协商结果缓存（同一 IP 只握手一次）
const ALPN_CACHE = new Map();
export function negotiateProtocol(ip, port = 443, timeoutMs = 4000) {
  const key = `${ip}:${port}`;
  if (ALPN_CACHE.has(key)) return Promise.resolve(ALPN_CACHE.get(key));
  return new Promise(resolve => {
    let done = false;
    const fin = v => { if (done) return; done = true; ALPN_CACHE.set(key, v); resolve(v); };
    let sock;
    try {
      sock = tls.connect({
        host: ip, port, servername: SPEED_HOST, rejectUnauthorized: false,
        ALPNProtocols: ['h2', 'http/1.1']
      }, () => {
        const p = sock.alpnProtocol || '';
        try { sock.destroy(); } catch {}
        fin(p === 'h2' ? 'h2' : (p ? 'h1' : ''));
      });
      sock.setTimeout(timeoutMs, () => { try { sock.destroy(); } catch {} fin(''); });
      sock.on('error', () => { try { sock.destroy(); } catch {} fin(''); });
    } catch { fin(''); }
  });
}

/**
 * HTTP/2 版固定时长测速。返回结构与 downloadTimed 完全一致。
 * 为什么单独写一份而不是复用：Node 的 https.request 永远只说 HTTP/1.1，
 *   真要跑 h2 必须走 http2.connect，请求与响应事件模型都不同。
 */
export function downloadTimedH2(ip, port, durationSeconds = 2.5, warmSeconds = 0.8, onProgress = null) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let ttfb = 0, got = 0, done = false, timer = null, guardTimer = null, colo = '';
    const timeline = [];
    let session = null, stream = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (guardTimer) clearTimeout(guardTimer);
      try { stream && stream.close(); } catch {}
      try { session && session.destroy(); } catch {}
    };
    const fin = (ok, err = '', retryAfter = 0) => {
      if (done) return;
      done = true;
      cleanup();
      const totalMs = Date.now() - t0;
      if (!ok) return resolve({ ok: false, err: err || 'failed', retryAfter, totalMs, ttfb, mbps: 0, steadyMbps: 0, peakMbps: 0, ewmaMbps: 0, got, colo, protocol: 'h2' });
      const warmMs = warmSeconds * 1000;
      const netSecTotal = (totalMs - ttfb) / 1000;
      const { steadyMbps, overallMbps, peakMbps, ewmaMbps } = computeSpeedMetrics(timeline, warmMs, netSecTotal, got);
      resolve({
        ok: true, err: '', retryAfter: 0, totalMs, ttfb, got, colo, protocol: 'h2',
        mbps: +steadyMbps.toFixed(2),
        overallMbps: +overallMbps.toFixed(2),
        steadyMbps: +steadyMbps.toFixed(2),
        peakMbps: +peakMbps.toFixed(2),
        ewmaMbps: +ewmaMbps.toFixed(2),
        duration: +netSecTotal.toFixed(2)
      });
    };

    try {
      session = http2.connect(`https://${SPEED_HOST}:${port}`, {
        createConnection: () => tls.connect({
          host: ip, port, servername: SPEED_HOST, rejectUnauthorized: false, ALPNProtocols: ['h2']
        })
      });
    } catch (e) { return fin(false, e.code || e.message); }
    session.on('error', e => fin(false, e.code === 'ERR_HTTP2_ERROR' ? 'HTTP2协议错误' : (e.code || e.message)));
    session.on('goaway', () => fin(false, 'HTTP2-GOAWAY'));

    try {
      stream = session.request({
        ':method': 'GET',
        ':path': withBytes(SPEED_PATH, 52428800),
        'user-agent': UA,
        'accept-encoding': 'identity'
      });
    } catch (e) { return fin(false, e.code || e.message); }

    stream.on('response', headers => {
      const status = Number(headers[':status']);
      if (status !== 200) {
        const ra = Number(headers['retry-after']);
        const label = status === 429 ? '限速(429)' : (status === 403 ? '被拒(403)' : 'HTTP ' + status);
        return fin(false, label, Number.isFinite(ra) && ra > 0 ? ra : 0);
      }
      const server = String(headers['server'] || '').toLowerCase();
      const hasCfRay = !!headers['cf-ray'];
      colo = String(headers['cf-ray'] || '').split('-').pop() || '';
      const cType = String(headers['content-type'] || '').toLowerCase();
      if (!server.includes('cloudflare') && !hasCfRay) return fin(false, '非CF节点');
      if (cType.includes('text/html')) return fin(false, '返回HTML');
      // 头一到就开始计时：从此刻起跑满 durationSeconds 就掐断
      ttfb = Date.now() - t0;
      timer = setTimeout(() => fin(true), durationSeconds * 1000);
    });
    let lastReport = 0;
    stream.on('data', chunk => {
      const now = Date.now();
      got += chunk.length;
      const relMs = now - (t0 + ttfb);
      timeline.push({ t: relMs, got });
      if (onProgress && now - lastReport >= 500) {
        lastReport = now;
        const curSec = relMs / 1000;
        const curMbps = curSec > 0 ? (got * 8) / curSec / 1e6 : 0;
        try { onProgress({ elapsedSec: +curSec.toFixed(1), targetSec: durationSeconds, curMbps: +curMbps.toFixed(1) }); } catch {}
      }
    });
    stream.on('end', () => fin(true));
    stream.on('error', e => fin(false, e.code || e.message));

    guardTimer = setTimeout(() => fin(false, 'guard-timeout'), (durationSeconds + 4) * 1000);
  });
}

/** 按当前协议设置选一条测速通道（downloadTimedMulti 内部用） */
async function measureOnce(ip, port, durationSeconds, warmSeconds, onProgress) {
  const mode = getProtocol();
  if (mode === 'h1') return downloadTimed(ip, port, durationSeconds, warmSeconds, onProgress);
  if (mode === 'h2') return downloadTimedH2(ip, port, durationSeconds, warmSeconds, onProgress);
  if (mode === 'h3') {
    // Node 核心没有 QUIC/HTTP3 实现（要引 @nodejs/quic 之类的第三方库），如实退回 h1
    return downloadTimed(ip, port, durationSeconds, warmSeconds, onProgress);
  }
  // auto：先看节点给不给 h2
  const p = await negotiateProtocol(ip, port);
  return p === 'h2'
    ? downloadTimedH2(ip, port, durationSeconds, warmSeconds, onProgress)
    : downloadTimed(ip, port, durationSeconds, warmSeconds, onProgress);
}

/**
 * 轻量预筛：只下载很小的样本（默认 16KB）来判断节点是否真的能用。
 * 与 download() 的区别：
 *   - 收满 bytes 就立即结束，不等完整响应（因此耗时极短，通常 <1s）
 *   - 不做"完整字节数"校验（本来就只收一小段）
 *   - 保留 CF 身份校验（server/cf-ray）和 HTML 拦截，防止假节点混入
 * 用途：并发快速淘汰死节点，只把幸存者交给昂贵的串行精测。
 */
export function quickProbe(ip, port, bytes = 16384, timeout = 2500) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let ttfb = 0, got = 0, done = false, guard = null, colo = '';
    const fin = (ok, err) => {
      if (done) return; done = true;
      if (guard) clearTimeout(guard);
      try { req && req.destroy(); } catch { /* 忽略 */ }
      resolve({ ok, ms: Date.now() - t0, ttfb: ok ? ttfb : 0, got, colo, err: err || '' });
    };
    const req = https.request({
      host: ip, port, path: withBytes(SPEED_PATH, bytes), method: 'GET',
      servername: SPEED_HOST, rejectUnauthorized: false,
      headers: { Host: SPEED_HOST, 'User-Agent': UA, 'Accept-Encoding': 'identity' }
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return fin(false, res.statusCode === 429 ? '限速(429)' : 'HTTP ' + res.statusCode); }
      const server = String(res.headers['server'] || '').toLowerCase();
      const hasCfRay = !!res.headers['cf-ray'];
      colo = String(res.headers['cf-ray'] || '').split('-').pop() || '';
      const cType = String(res.headers['content-type'] || '').toLowerCase();
      if (!server.includes('cloudflare') && !hasCfRay) { res.resume(); return fin(false, '非CF'); }
      if (cType.includes('text/html')) { res.resume(); return fin(false, 'HTML'); }
      res.on('data', c => {
        if (!ttfb) ttfb = Date.now() - t0;
        got += c.length;
        if (got >= bytes) fin(true);            // 收满即停，不再等后续数据
      });
      res.on('end', () => fin(got > 0, got === 0 ? 'empty' : ''));
      res.on('error', e => fin(false, e.code || e.message));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    guard = setTimeout(() => fin(false, 'guard-timeout'), timeout + 1500);
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

/**
 * ============ 测速地址（多地址自动探活切换） ============
 *
 * 【借鉴自 CFData-WEB】combined_refactor/speed_url.go:17-50
 *   const autoSpeedURLValue = "auto"
 *   cmSpeedURL              = "cf.090227.xyz/__down?bytes=99999999"   // 移动专用
 *   mobileDedicatedSpeedURL = "speed.okl.abrdns.com"
 *   cloudflareSpeedURL      = "speed.cloudflare.com/__down?bytes=99999999"
 *   pickAutoSpeedURL()  →  是 "auto" 就先试当前默认，不行再 firstAvailableSpeedURL(...)
 *   它把测速地址做成可切换的：某个地址被墙/被限速/被弃用，不至于让整轮优选白跑。
 *
 * 本地实测印证了它的价值：同一时刻 speed.cloudflare.com 返回 200，
 *   而 cf.xiu2.xyz / cf.090227.xyz 返回 403，speed.okl.abrdns.com 仍能正常下载。
 */
export const SPEED_URL_AUTO = 'auto';

export const SPEED_URL_CANDIDATES = [
  { url: 'https://speed.cloudflare.com/__down?bytes=52428800', name: 'Cloudflare 官方' },
  { url: 'https://cf.090227.xyz/__down?bytes=99999999', name: '移动专用' },
  { url: 'https://speed.okl.abrdns.com', name: '备用' }
];

// 测速请求的 Host / path 由这里统一给出，避免散落在多处写死
let SPEED_HOST = 'speed.cloudflare.com';
let SPEED_PATH = '/__down?bytes=52428800';

/** 把用户写的地址规整成 {host, path}；写得不成 URL 就返回 null */
export function splitSpeedUrl(u) {
  if (!u) return null;
  try {
    const s = String(u);
    const x = new URL(s.includes('://') ? s : 'https://' + s);
    if (!x.hostname) return null;
    return { host: x.hostname, path: (x.pathname || '/') + (x.search || '') };
  } catch { return null; }
}

/** 把 path 里的 bytes= 换成指定值（地址本身没有 bytes 参数就原样返回） */
export function withBytes(path, bytes) {
  return /[?&]bytes=\d+/.test(String(path)) ? String(path).replace(/([?&]bytes=)\d+/, `$1${bytes}`) : path;
}

export function setSpeedUrl(u) {
  const p = splitSpeedUrl(u);
  if (!p) return false;
  SPEED_HOST = p.host;
  SPEED_PATH = p.path;
  return true;
}

export function getSpeedUrl() { return `https://${SPEED_HOST}${SPEED_PATH}`; }
export function getSpeedHost() { return SPEED_HOST; }
export function getSpeedPath() { return SPEED_PATH; }

/**
 * 自动挑一个能用的测速地址（CFData-WEB pickAutoSpeedURL 的等价实现）。
 *   pref 写具体地址 → 直接用，不猜
 *   pref 为 "auto" / 空 → 按候选顺序探活，第一个通的就用
 *   全都不同 → 回退官方地址并让调用方给出警告（不让整轮白跑，但把话说清楚）
 */
export async function pickAutoSpeedUrl(pref, log = () => {}) {
  if (pref && pref !== SPEED_URL_AUTO && splitSpeedUrl(pref)) {
    setSpeedUrl(pref);
    return { url: getSpeedUrl(), name: '配置指定', picked: false };
  }
  for (const c of SPEED_URL_CANDIDATES) {
    const r = await probeSpeedEndpoint(5000, c.url);
    if (r.ok) {
      setSpeedUrl(c.url);
      return { url: getSpeedUrl(), name: c.name, picked: c.url !== SPEED_URL_CANDIDATES[0].url, probe: r };
    }
    log(`   测速地址探活失败：${c.name} ${c.url}（${r.err || 'HTTP ' + r.code}）`);
  }
  setSpeedUrl(SPEED_URL_CANDIDATES[0].url);
  return { url: getSpeedUrl(), name: 'Cloudflare 官方', picked: false, allDead: true };
}

/**
 * 测速端点探活：确认这个测速地址到底下不下得动。
 *
 * 为什么需要它（借鉴 CFData-WEB `combined_refactor/speed_url.go:258-296` 的 checkSpeedURLAvailability）：
 *   整轮优选的每一秒都建立在「能连上测速端点」这个前提上。
 *   一旦换到被污染的网络、或 CF 调整了测速端点，程序仍会跑满几分钟，
 *   最后报「一个节点都不达标」—— 把「测速通道不通」误报成「所有节点都很差」。
 *   所以开跑前用 1KB 小样本探一次，不通就当场讲清楚，不白白浪费你的时间。
 *
 * 判定：HTTP 2xx 且真的读到字节；5 秒超时（与它一致）。
 * @param {number} timeoutMs
 * @param {string|null} url 不传就探当前生效的地址
 * @returns {Promise<{ok:boolean, code?:number, bytes?:number, ms:number, err?:string}>}
 */
export function probeSpeedEndpoint(timeoutMs = 5000, url = null) {
  const target = splitSpeedUrl(url) || { host: SPEED_HOST, path: SPEED_PATH };
  return new Promise(resolve => {
    const t0 = Date.now();
    let settled = false;
    let req = null;
    const fin = v => {
      if (settled) return;
      settled = true;
      try { req && req.destroy(); } catch { /* 忽略 */ }
      resolve({ ...v, ms: Date.now() - t0 });
    };
    req = https.request({
      host: target.host, port: 443, path: withBytes(target.path, 1024), method: 'GET',
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' },
      rejectUnauthorized: false,
      timeout: timeoutMs
    }, res => {
      let n = 0;
      res.on('data', c => {
        n += c.length;
        // 有的备用地址没有 bytes= 参数（例如 speed.okl.abrdns.com 直接吐一个大文件，
        //   实测能下 100MB），探活只需要「能拿到字节」这一个证据 ——
        //   读到 64KB 就主动断开，别为了探活把整个文件拖下来。
        if (n >= 65536) fin({ ok: res.statusCode >= 200 && res.statusCode < 300 && n > 0, code: res.statusCode, bytes: n });
      });
      res.on('end', () => fin({
        ok: res.statusCode >= 200 && res.statusCode < 300 && n > 0,
        code: res.statusCode, bytes: n
      }));
      res.on('error', e => fin({ ok: false, err: e.code || e.message }));
    });
    req.on('error', e => fin({ ok: false, err: e.code || e.message }));
    req.on('timeout', () => fin({ ok: false, err: 'timeout' }));
    req.end();
  });
}

/**
 * 链路复验（relink）：用你自己的站点域名，真实访问一次候选 IP。
 *
 * 为什么需要它：测速阶段连的是 speed.cloudflare.com/__down，只能证明"这个 IP 能下载 CF 的测速文件"，
 * 不能证明"它会把你的域名正确转发出去"。实测遇到过测速 20+Mbps、但换成你的域名直接 ECONNRESET 的节点。
 * 所以写入 DNS 之前再验一次：TCP + TLS + HTTP，SNI 和 Host 都必须是你的域名。
 *
 * 判定为可用的条件：HTTP 200 且收到响应体。
 *   - CF 对 Host 不匹配会返回 403/421，所以 Host 头必须一起带上（实战踩过：只给 SNI 会全部 403）。
 *   - 允许 3xx/4xx？不。站点正常情况下就是 200，非 200 说明这条链路对你的域名不算"可用"。
 *
 * @param {string} ip      候选 IP
 * @param {string} domain  你的站点域名（用来做 SNI 和 Host）
 * @param {number} timeoutMs 单次超时
 * @returns {Promise<{ok:boolean, code?:number, bytes?:number, colo?:string, ms:number, err?:string}>}
 */
export function relinkCheck(ip, domain, timeoutMs = 6000, port = 443) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let settled = false;
    let req = null;
    const fin = v => {
      if (settled) return;
      settled = true;
      try { req && req.destroy(); } catch { /* 忽略 */ }
      resolve({ ...v, ms: Date.now() - t0 });
    };
    req = https.request({
      host: ip, port, path: '/', method: 'GET',
      servername: domain,
      headers: { Host: domain, 'User-Agent': UA },
      rejectUnauthorized: false,
      timeout: timeoutMs
    }, res => {
      let n = 0;
      const head = [];
      let headLen = 0;
      res.on('data', c => {
        n += c.length;
        if (headLen < 2048) { head.push(c); headLen += c.length; }
      });
      res.on('end', () => {
        // 【不信任 200】借鉴 CFData-WEB `combined_refactor/tasks_nsb.go:937-939` 的思路：
        //   它的链路复验除状态码外还要求响应体确实来自目标服务。
        //   这里同理 —— CF 边缘在链路异常时也会回 200 + 一页错误说明，
        //   光看状态码会把「打得开但打不到你站点」的节点当成好的。
        const text = Buffer.concat(head).toString('utf8');
        const looksCfError = /cf-error-details|error code:?\s*1\d{3}|<title>[^<]*\b(Error|错误)\b/i.test(text);
        fin({
          ok: res.statusCode === 200 && n > 0 && !looksCfError,
          code: res.statusCode, bytes: n,
          err: (res.statusCode === 200 && n > 0 && looksCfError) ? 'CF错误页' : undefined,
          colo: String(res.headers['cf-ray'] || '').split('-').pop() || ''
        });
      });
      res.on('error', e => fin({ ok: false, err: e.code || e.message }));
    });
    req.on('error', e => fin({ ok: false, err: e.code || e.message }));
    req.on('timeout', () => fin({ ok: false, err: 'timeout' }));
    req.end();
  });
}

/**
 * 链路复验（带重试）—— 单次复验会因偶发抖动误杀好节点，所以默认试 3 次，任一次通过即算可用。
 *
 * 为什么必须重试：实测同一节点对同一域名的复验结果会在 HTTP 421 / 200 之间来回跳。
 *   HTTP 421 Misdirected Request 是 CF 边缘偶发拒绝（TLS 会话复用或路由抖动），
 *   不代表这个 IP 长期不可用。只测一次会把这类节点误判成坏的，
 *   导致明明可用的节点被剔除、最后凑不够 topN。
 *
 * @param {string} ip        候选 IP
 * @param {string} domain    你的站点域名
 * @param {number} tries     最多尝试次数（默认 3）
 * @param {number} timeoutMs 单次超时
 * @returns {Promise<{ok:boolean, code?:number, bytes?:number, colo?:string, ms:number, err?:string, attempts:number}>}
 */
export async function relinkCheckRetry(ip, domain, tries = 3, timeoutMs = 6000, port = 443) {
  const t0 = Date.now();
  const n = Math.max(1, Number(tries) || 1);
  let last = null;
  const errs = [];
  for (let i = 0; i < n; i++) {
    const r = await relinkCheck(ip, domain, timeoutMs, port);
    last = r;
    if (r.ok) return { ...r, ms: Date.now() - t0, attempts: i + 1 };
    errs.push(r.err || ('HTTP ' + r.code));
  }
  return { ...(last || { ok: false }), ok: false, ms: Date.now() - t0, attempts: n, err: errs.join(' / ') };
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

// ── 探测历史（快速模式靠它优先复用上次的好节点）──────────────────
export function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
export function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); } catch { /* 忽略 */ }
}

// ── 本地网络带宽探测（speedtest，不是到 CF 的速度）─────────────────
// 用来给快速模式定达标线：本地带宽 × ratio
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
  const info = { ip: '', asn: '', isp: '', isDirect: false };

  // 1. 优先使用国内直连接口（被代理软件分流直连，拿到你本地物理网卡的真实公网 IP 和运营商）
  try {
    const t = await httpGet('http://myip.ipip.net', 5000);
    if (t) {
      // 格式形如：当前 IP：203.0.113.5  来自于：中国 某省 某市  example.com
      const ipMatch = t.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
      if (ipMatch) {
        info.ip = ipMatch[1];
        info.isDirect = true;
        const fromMatch = t.match(/来自于[：:]\s*([^\r\n]+)/);
        if (fromMatch) {
          const raw = fromMatch[1].trim();
          info.isp = raw;
          if (/unicom|联通/i.test(raw)) info.asn = '联通';
          else if (/telecom|电信/i.test(raw)) info.asn = '电信';
          else if (/mobile|移动/i.test(raw)) info.asn = '移动';
          else info.asn = raw.split(/\s+/).pop();
        }
      }
    }
  } catch { /* 忽略 */ }

  if (!info.ip) {
    try {
      const t = await httpGet('http://ip.3322.net', 4000);
      const m = t && t.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})$/);
      if (m) {
        info.ip = m[1];
        info.isDirect = true;
      }
    } catch { /* 忽略 */ }
  }

  // 2. 如果国内直连接口全挂（例如人在国外），回退境外接口
  if (!info.ip) {
    try {
      const t = await httpGet('https://api.ip.sb/geoip', 6000);
      if (t) { const j = JSON.parse(t); info.ip = j.ip || ''; info.asn = j.asn ? 'AS' + j.asn : ''; info.isp = j.isp || j.organization || ''; }
    } catch { /* 忽略 */ }
  }
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
  const routeTag = info.isDirect ? '本地宽带直连' : '代理出口/境外';
  log(`网络指纹：${key}${info.isp ? '（' + info.isp + '）' : ''}${info.ip ? '  出口 IP ' + info.ip + ' [' + routeTag + ']' : ''}`);
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
  // 去掉 UTF-8 BOM（记事本/PowerShell 保存时常会带上，会导致 JSON.parse 报错）
  if (text && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = String(text || '');
  // 注释一律替换成等长空白（而不是直接删掉），这样 JSON.parse 报出的 position
  // 才能对应回原文件的行列 —— 用户改配置写错时能精确指出第几行第几列。
  let out = '', inStr = false, inLine = false, inBlock = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } else out += ' '; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; out += '  '; i++; } else out += (c === '\n' ? '\n' : ' '); continue; }
    if (inStr) {
      out += c;
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; out += '  '; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; out += '  '; i++; continue; }
    out += c;
  }
  // 顺手干掉对象/数组结尾多余逗号（同样用空白顶替，保持偏移量）
  out = out.replace(/,\s*([}\]])/g, (m) => ' ' + m.slice(1));
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
  // ── 把简写形式（domains 字符串数组）展开成内部统一的 records 对象数组 ──
  //  支持三种写法，可混用：
  //    1) "domains": ["a.com", "b.com"]              ← 最简单，推荐
  //    2) "records": [{name:"a.com", topN:5, ...}]   ← 完整写法，可逐条定制
  //    3) 两者同时存在：以 records 为准，domains 里未出现在 records 的会被补进来
  const defaults = { type: 'A', ttl: 300, proxied: false, topN: 3, filter: { mode: 'deny', tokens: [] }, ...(ucf.defaults || {}) };
  const built = [];
  if (Array.isArray(ucf.domains)) {
    for (const d of ucf.domains) {
      if (typeof d === 'string' && d.trim()) {
        built.push({ ...defaults, name: d.trim() });
      } else if (d && typeof d === 'object' && d.name) {
        built.push({ ...defaults, ...d });      // 允许 domains 里直接写对象
      }
    }
  }
  const explicit = Array.isArray(ucf.records) ? ucf.records.filter(r => r && r.name) : [];
  for (const r of explicit) {
    const idx = built.findIndex(b => b.name === r.name);
    if (idx >= 0) built[idx] = { ...built[idx], ...r };   // records 里的同名项覆盖 defaults
    else built.push({ ...defaults, ...r });
  }
  // 关键：把 name 里明显是示例/非法的挑出来提示（不阻断，写入时 CF 也会拒绝）
  const suspicious = built.filter(r => /\.example\.(com|org|net)$/i.test(r.name) || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(r.name));

  const missing = [];
  if (!ucf.apiToken) missing.push('apiToken');
  if (!ucf.zoneId) missing.push('zoneId');
  if (!built.length) missing.push('domains（或 records）');

  const uploadReady = missing.length === 0;
  // 无论默认配置里写了什么，上传信息一律以用户文件为准
  cfg.cloudflare = uploadReady
    ? { ...ucf, records: built, defaults, suspicious }
    : { ...(ucf || {}), apiToken: '', zoneId: '', records: [], defaults, suspicious: [] };
  return { cfg, user, userPath, uploadReady, missing, userError, suspicious, userConfigExists: !!(userPath && fs.existsSync(userPath)) };
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
// ── 数据源评分：按历史实测命中率给每个源打分，决定测试优先级 ──────────
// 两个模式共用这一份逻辑，避免各写一份导致不一致。
//
// 评分依据（全部来自实际测速结果，不用订阅源标注的任何数值）：
//   1. 该源历史命中率 = 达标数 / 测试数
//   2. 小样本用贝叶斯平滑，避免"测1中1"就被当成神源
//   3. 平均速度做小幅加权
//   4. tier 只作基础底色（fresh 略优于 legacy），不主导排序
export function readSourceStats(statFile, ttlDays = 14) {
  const store = readJson(statFile, { sources: {} });
  const srcStats = {};
  const now = Date.now();
  const ttlMs = Number(ttlDays) * 86400000;
  for (const [label, v] of Object.entries(store.sources || {})) {
    if (!v || !v.updatedAt) continue;
    if (now - Date.parse(v.updatedAt) > ttlMs) continue;   // 太久没更新的记录作废
    srcStats[label] = v;
  }
  return srcStats;
}

export function makeScoreOf(srcStats) {
  return function scoreOf(label, tier) {
    const s = srcStats[label];
    const base = tier === 'legacy' ? 0.55 : 0.6;
    if (!s || (s.tested || 0) === 0) return base;           // 冷启动给基础分
    const tested = s.tested || 0, hit = s.hit || 0;
    const smoothed = (hit + 0.2 * 8) / (tested + 8);        // 贝叶斯平滑
    const speedFactor = Math.min(1, (s.avgMbps || 0) / 20);
    return +(base * (0.4 + smoothed * 1.2 + speedFactor * 0.2)).toFixed(3);
  };
}

// 给一组节点打上源评分，并按分组规则排序
//   groupOf: 返回一个数字表示分组优先级（越小越优先），用于同分时的次要排序
export function rankBySourceScore(rows, scoreOf, groupOf) {
  return rows.map(r => {
    const label = r.sourceLabel || r.tier || 'unknown';
    return { ...r, srcLabel: label, srcScore: scoreOf(label, r.tier) };
  }).sort((a, b) => {
    const g = (groupOf ? groupOf(a) - groupOf(b) : 0);
    if (g !== 0) return g;
    return b.srcScore - a.srcScore;                          // 源评分高的优先
  });
}

// 把一个源的表现写入统计档案（指数滑动平均，近期权重更高）
export function updateSourceStats(statFile, perSource) {
  const store = readJson(statFile, { sources: {} });
  store.sources ||= {};
  const blend = (a, b, w = 0.4) => (a == null ? b : a * (1 - w) + b * w);
  for (const [label, v] of Object.entries(perSource || {})) {
    const old = store.sources[label] || {};
    store.sources[label] = {
      tested: Math.round(blend(old.tested, v.tested)),
      hit: Math.round(blend(old.hit, v.hit)),
      avgMbps: +blend(old.avgMbps, v.okCount ? v.sumMbps / v.okCount : 0).toFixed(2),
      lastRun: { tested: v.tested, hit: v.hit, at: new Date().toISOString() },
      updatedAt: new Date().toISOString()
    };
  }
  writeJson(statFile, store);
  return store.sources;
}
