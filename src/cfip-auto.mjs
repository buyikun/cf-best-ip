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
import { pruneOldFiles, loadConfig, findBaseDir, loadSource as loadSourceLib, quickProbe, download, downloadTimed, pool, median, relinkCheckRetry } from './cfip-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = findBaseDir(HERE);   // 根目录（配置与 var\ 所在层），程序可放在 src\ 子目录
const argv = process.argv.slice(2);
// 参数解析：`--dry-run` / `--dry-run=true` / `--dry-run=1` 三种写法都要认
//（旧写法只认 argv.includes('--dry-run')，写 --dry-run=true 会被当成没开 dry-run，真去写 DNS）
const flag = n => argv.some(a => a === n || a === `${n}=true` || a === `${n}=1`);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const kv = argv.find(a => a.startsWith(`${n}=`));
  return kv ? kv.slice(n.length + 1) : d;
};
// 数值参数统一校验：与快速模式保持一致。
//   以前直接 Number() 转换，写成 --candidates abc 会变 NaN，
//   survivors.slice(0, NaN) 得到空数组，最后报「无可用节点」误导成网络故障。
const optNum = (n, d, min = 1, max = 1e9) => {
  const raw = opt(n);
  if (raw === undefined) return d;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    console.error(`参数 ${n} 的值「${raw}」不合法，应为 ${min}~${max} 之间的数字`);
    process.exit(2);
  }
  return v;
};

const CONFIG_PATH = path.resolve(HERE, opt('--config', 'cfip.config.json'));   // 内置默认配置随程序在 src\
const USER_CONFIG_PATH = path.resolve(BASE, opt('--user-config', 'user.config.jsonc'));  // 用户配置在根目录
const { cfg, userPath, uploadReady, userError, missing, suspicious, userConfigExists } = loadConfig(CONFIG_PATH, USER_CONFIG_PATH);
if (!uploadReady) cfg.behavior.dryRun = true;   // 没填凭据 = 强制只测速，绝不写 DNS
const FORCE = flag('--force');
const VERBOSE = flag('--verbose');
const DRY_RUN = flag('--dry-run') || cfg.behavior.dryRun === true;
if (opt('--candidates') !== undefined) cfg.probe.candidates = optNum('--candidates', cfg.probe.candidates, 0, 100000);
if (opt('--rounds') !== undefined) cfg.probe.rounds = optNum('--rounds', cfg.probe.rounds, 1, 20);
if (opt('--port') !== undefined) cfg.probe.port = optNum('--port', cfg.probe.port, 1, 65535);
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
  const minutes = Number(cfg.behavior.globalTimeoutMinutes || 60);
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
// 解析统一由 cfip-lib.mjs 的 loadSource/parseAny 负责（支持 HTML 表格 + 纯文本 + 国家码白名单）。
// 这里原本有一份私有的 parseLines 和三个正则，但它从未被任何代码调用（死代码），
// 且不认识 free-nodes 系源的国家码写法，已于清理中删除，避免日后误用。


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

// 统一走公共库的 loadSource（支持 HTML 表格源、多源合并、tier 分级）
async function loadSource() {
  return loadSourceLib(cfg.source, CFG_DIR, log);
}

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
log(`配置：${path.basename(CONFIG_PATH)}${uploadReady ? ' + ' + path.basename(userPath) : '（未配置上传信息）'}${DRY_RUN ? '  [DRY-RUN 不写 Cloudflare]' : ''}${FORCE ? '  [--force]' : ''}`);
if (suspicious && suspicious.length) {
  log('');
  log('  ⚠ 检测到疑似示例/无效域名：');
  for (const s of suspicious) log(`     - ${s.name}`);
  log('     这些域名不在你的 Cloudflare 账号下，写入时会失败（其余域名不受影响）。');
  log('     请打开 user.config.jsonc，把 domains 里的名字改成你自己的域名。');
  log('');
}
if (!uploadReady) {
  log('');
  // 配置写错时先给出明确的错误，别让用户以为是"没配置"
  if (userError) {
    log('  ┌────────────────────────────────────────────────────────────┐');
    log('  │  ⚠ 你的配置文件有问题，已退回“只测速”模式                  │');
    log('  └────────────────────────────────────────────────────────────┘');
    log(`  ${userError}`);
    log('');
  } else if (userConfigExists && missing && missing.length) {
    log('  ┌────────────────────────────────────────────────────────────┐');
    log('  │  配置文件已找到，但还缺少上传必需项，本次 = 只测速模式      │');
    log('  └────────────────────────────────────────────────────────────┘');
    log(`  未填的项：${missing.join(' / ')}`);
    log('  提示：这三项都要填齐才会真正上传（文件里每项都有中文说明）');
    log('');
  } else {
    log('  ┌────────────────────────────────────────────────────────────┐');
    log('  │  还没有配置 Cloudflare，本次运行 = 演示模式                │');
    log('  │  · 只测速、只打印结果，绝不会改动你的 DNS                  │');
    log('  │  · 想正式使用：把 user.config.jsonc.example 改名为         │');
    log('  │      user.config.jsonc，然后填三样：                        │');
    log('  │      apiToken / zoneId / domains（文件里每项都有中文说明） │');
    log('  └────────────────────────────────────────────────────────────┘');
    log('');
  }
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
  log(`源记录：${all.length} 条`);
  if (!all.length) throw new Error('源文件没有可解析的 IP');

  // 2. 候选池：按各域名 filter 前置排除，只测「有可能会被写入」的节点
  //    全量模式的目标是「挖最快节点」，实测才是唯一依据。
  //    订阅源标注的速度与实测毫无相关性（标称 10.27M 的实测失败、
  //    标称 4.09M 的实测 5.56M），源的新旧/评分只代表历史，不影响本轮结果。
  //
  //    【前置排除】出方案时是按每个域名的 filter 筛的，凡是被所有域名都排除掉的节点，
  //    实测多少都快都没用 —— 测了也是白测，纯浪费几十分钟。
  //    所以这里在测速前就把它们剔掉，只留下「至少被一个域名想要」的节点。
  //    判定用并集：只要某个域名的 filter 想要它，就保留。
  //    （某域名 filter 为空 tokens = 不筛选 = 全都要，此时等于不排除，行为同以前。）
  const wantedByAny = (cc) => {
    const c = String(cc || '').toUpperCase();
    for (const rec of (cfg.cloudflare.records || [])) {
      const f = rec.filter;
      if (!f || !f.tokens || f.tokens.length === 0) return true;   // 有条记录不限国家 = 全都想要
      const set = new Set(f.tokens.map(t => String(t).toUpperCase()));
      const mode = String(f.mode || 'deny').toLowerCase();
      if (mode === 'allow' ? set.has(c) : !set.has(c)) return true;
    }
    return false;
  };
  const P = Number(cfg.probe.port);
  const allRows = all.map(r => ({ ...r, port: P, wanted: wantedByAny(r.cc) ? 1 : 0 }));
  const wantedRows = allRows.filter(r => r.wanted);
  // 【安全阀】filter 一个都没命中时绝不照做 —— 那会让本轮没有任何候选，
  //   上游换个写法、或国家码拼错，就可能导致站点彻底没有可用 IP（11-06 踩过）。
  //   minFilterKeep 以下的极端情况同样回退，宁可多测也不冒"无候选"的险。
  const minFilterKeep = Math.max(1, Number(cfg.probe.minFilterKeep ?? 5));
  let gatePool;
  if (wantedRows.length >= minFilterKeep) {
    gatePool = wantedRows;
    log(`候选池：源里 ${allRows.length} 个 → 按 filter 前置排除掉 ${allRows.length - wantedRows.length} 个必然用不上的节点，只测 ${gatePool.length} 个`);
  } else if (wantedRows.length > 0) {
    gatePool = allRows;
    log(`⚠ filter 只命中 ${wantedRows.length} 个（少于安全值 ${minFilterKeep}），本次不做前置排除，回退测全部 ${allRows.length} 个`);
  } else {
    gatePool = allRows;
    log(`⚠ filter 没有命中任何节点（国家码可能拼错了）—— 为避免本轮无候选，回退测全部 ${allRows.length} 个`);
  }

  // 3. 并发预筛（16KB 小样本）—— 全量模式不做任何上限，全部节点都筛
  //    注意：这里不做 TCP 门控——实测在 TUN 代理环境下 TCP 握手会被本地接管，
  //    死节点也显示"可达"（实测 1038/1038 全通），没有筛选价值。
  //    改用 HTTP 小样本，能穿透代理触及真实节点，判定准确率实测 100%。
  //    并发实测：1157 个节点，并发8=367s / 并发16=183s / 并发32=92s，
  //    且三种并发的存活数几乎一致（322/324/329），说明提高并发不影响判定准确率
  //    （预筛只看通不通，不测速度，所以不存在抢带宽问题）。
  const screenBytes = Number(cfg.probe.screenBytes ?? 16384);
  const screenConc = Math.max(1, Number(cfg.probe.screenConcurrency ?? 32));
  const screenTimeout = Number(cfg.probe.screenTimeoutMs ?? 2500);
  const screenPool = gatePool;   // 已在候选池阶段按 filter 前置排除
  log(`---- 阶段1/3：并发预筛 ${screenPool.length} 个（${(screenBytes / 1024).toFixed(0)}KB 样本，并发 ${screenConc}）----`);
  log('   正在并发连接各节点，结果会逐个出现…');

  const survivors = [];
  const tS = Date.now();
  let doneCnt = 0;
  await pool(screenPool, screenConc, async c => {
    const r = await quickProbe(c.ip, c.port, screenBytes, screenTimeout);
    doneCnt++;
    if (r.ok) {
      survivors.push(c);
      if (VERBOSE) log(`   [${doneCnt}/${screenPool.length}] OK ${c.ip} (${r.ms}ms)`);
    } else if (VERBOSE) {
      log(`   [${doneCnt}/${screenPool.length}] X  ${c.ip} (${r.err})`);
    }
    if (doneCnt % 25 === 0 || doneCnt === screenPool.length) {
      log(`   预筛进度 ${doneCnt}/${screenPool.length}，存活 ${survivors.length} 个`);
    }
  });
  const screenSec = ((Date.now() - tS) / 1000).toFixed(1);
  const killPct = screenPool.length ? ((1 - survivors.length / screenPool.length) * 100).toFixed(0) : 0;
  log(`预筛完成：${survivors.length}/${screenPool.length} 存活（淘汰 ${killPct}%），耗时 ${screenSec}s`);
  if (!survivors.length) {
    throw new Error(
      `预筛 ${screenPool.length} 个节点全部失败，现有 DNS 记录保持不变。\n`
      + `     排查建议：\n`
      + `       1) 数据源可能整体失效（查日志里"上游已 N 小时未更新"的告警）\n`
      + `       2) 网络异常，试试浏览器能否打开 https://speed.cloudflare.com\n`
      + `       3) 检查 probe.screenBytes/screenTimeoutMs 是否被调得过于苛刻`
    );
  }

  // 4. 阶段2：全部幸存者各初测 1 轮（每节点固定跑 1.5 秒，快速筛出有希望的）
  //    理由：幸存者里绝大多数要么失败、要么速度远不够，各跑 1.5 秒立即硬掐断，绝不多等。
  const capN = Number(cfg.probe.candidates ?? 0);
  const testList = capN > 0 ? survivors.slice(0, capN) : survivors;   // 0 = 不限制，全部测
  log(`---- 阶段2/3：初测 ${testList.length} 个幸存者（每节点严格跑 1.5 秒硬掐断，绝不死等）----`);

  let initIdx = 0;
  for (const c of testList) {
    initIdx++;
    const d = await downloadTimed(c.ip, c.port, 1.5, 0.4, p => {
      log(`   初测 [${initIdx}/${testList.length}] ${c.ip.padEnd(15)} 测速中(${p.elapsedSec}s) ${p.curMbps}Mbps`);
    });
    (c.samples ||= []).push(d);
  }
  log(`初测完成：${testList.length} 个`);

  // 5. 阶段3：对初测排名靠前的再复核若干轮（固定跑 3.0 秒，剥离 0.8s 慢启动求稳态极限）
  const verifyTop = Math.max(1, Number(cfg.probe.verifyTopN ?? 15));
  const verifyRounds = Math.max(0, Number(cfg.probe.verifyRounds ?? 2));
  // 前置排除已经在候选池那里做过了（只测 filter 想要的节点），
  // 这里不再需要额外的排序干预：留下来的节点本来就都是「至少被一个域名想要」的。
  const prelim = testList.map(c => {
    const ok = c.samples.filter(s => s.ok);
    return { ...c, mbps: median(ok.map(s => s.mbps)), ttfb: median(ok.map(s => s.ttfb)), okRate: ok.length / c.samples.length };
  }).filter(r => r.okRate >= cfg.probe.minOkRate && r.mbps >= cfg.probe.minMedianMbps)
    .sort((a, b) => (b.mbps - a.mbps) || (a.ttfb - b.ttfb));

  log(`初测合格：${prelim.length} 个（要求 ok率≥${cfg.probe.minOkRate}，速度≥${cfg.probe.minMedianMbps}Mbps）`);
  {
    const w = prelim.filter(r => r.wanted).length;
    if (w < prelim.length) log(`filter 命中 ${w} 个，复核时优先安排（其余 ${prelim.length - w} 个作后备）`);
  }
  if (prelim.length && verifyRounds > 0) {
    const verifyList = prelim.slice(0, verifyTop);
    log(`---- 阶段3/3：复核前 ${verifyList.length} 名 × ${verifyRounds} 轮（每轮跑 3.0 秒求稳态极限，剥离慢启动）----`);
    for (let r = 1; r <= verifyRounds; r++) {
      let j = 0;
      for (const c of verifyList) {
        j++;
        const d = await downloadTimed(c.ip, c.port, 3.0, 0.8, p => {
          log(`   复核 第${r}轮 [${j}/${verifyList.length}] ${c.ip.padEnd(15)} 测速中(${p.elapsedSec}s) ${p.curMbps}Mbps`);
        });
        (c.samples ||= []).push(d);
      }
      log(`复核第 ${r}/${verifyRounds} 轮完成`);
    }
  }

  const screened = testList;

  // 6. 中位数排名（候选池已按 filter 前置排除，这里只按实测速度排）
  const ranked = screened.map(c => {
    const ok = c.samples.filter(s => s.ok);
    const mbps = median(ok.map(s => s.mbps));
    return { ...c, mbps, ttfb: median(ok.map(s => s.ttfb)), okRate: ok.length / c.samples.length };
  }).filter(r => r.okRate >= cfg.probe.minOkRate && r.mbps >= cfg.probe.minMedianMbps)
    .sort((a, b) => (b.mbps - a.mbps) || (a.ttfb - b.ttfb));

  log(`合格节点：${ranked.length} 个（要求 ok率≥${cfg.probe.minOkRate}，中位速度≥${cfg.probe.minMedianMbps}Mbps）`);
  for (const r of ranked.slice(0, 12)) log(`   ${r.ip.padEnd(16)} ${r.cc} ${String(r.mbps).padStart(6)}Mbps  ttfb=${r.ttfb}ms  ok=${Math.round(r.okRate * 100)}%`);
  if (!ranked.length) throw new Error('没有节点通过质量门槛，保留现有 DNS 记录不变');

  // 6. 逐记录出方案（带链路复验）
  //    【为什么必须复验】测速走的是 speed.cloudflare.com 这个通道，
  //    有些节点能测出很高速度，但用你自己的域名去访问根本打不开
  //    （典型：SNI 敏感的中转/反代 IP、或已被拉黑的节点）。
  //    写进 DNS 前用真实域名做一次 HTTPS 请求，打不开的直接剔除并由后面的候选补上。
  const plan = [];
  const relinkCache = new Map();          // `${domain}|${ip}` → 结果，同一对只测一次
  const relinkOne = async (domain, ip) => {
    const key = `${domain}|${ip}`;
    if (!relinkCache.has(key)) relinkCache.set(key, await relinkCheckRetry(ip, domain, 3));
    return relinkCache.get(key);
  };
  const relinkDead = [];
  let relinkTried = 0;
  for (const rec of (cfg.cloudflare.records || [])) {
    // 全量模式沿用每个域名自己的 topN（不做全局硬上限，这一点和快速模式不同）
    const limit = Math.max(1, Number(rec.topN ?? 3));
    const candidates = applyFilter(ranked, rec.filter);
    const picked = [];
    const triedIps = new Set();
    const maxTry = Math.min(candidates.length, Math.max(limit * 4, limit + 5));
    for (const cand of candidates) {
      if (picked.length >= limit || triedIps.size >= maxTry) break;
      triedIps.add(cand.ip);
      relinkTried++;
      const rr = await relinkOne(rec.name, cand.ip);
      if (rr.ok) picked.push({ ...cand, relinkColo: rr.colo });
      else relinkDead.push({ name: rec.name, ip: cand.ip, err: rr.err || ('HTTP ' + rr.code) });
    }
    plan.push({ rec, ips: picked.map(r => r.ip), detail: picked });
  }
  if (relinkTried) {
    log(`---- 链路复验：试了 ${relinkTried} 次，剔除 ${relinkDead.length} 个「测速能过、但你的域名打不开」的节点 ----`);
    for (const d of relinkDead) log(`   ✘ ${d.ip.padEnd(16)} ${d.name} → ${d.err}`);
    if (!relinkDead.length) log('   ✔ 全部通过，没有需要剔除的节点');
  }
  log('---- 目标方案 ----');
  for (const p of plan) log(`   ${p.rec.name} (${p.rec.type}, top${p.rec.topN}) <- ${p.ips.join(', ') || '(空)'}`);
  // 【安全护栏】筛选结果为 0 个节点时，绝不参与写入。
  //   否则 keep 为空集合 → 该域名现有 A 记录会被全部删除。
  //   典型误配：filter.mode="allow" 但国家码拼错（如写成 SGP 而不是 SG）。
  const actionable = [];
  const blocked = [];
  for (const p of plan) {
    if (p.ips.length === 0) {
      p.next = []; p.same = true;
      blocked.push(p);
      log(`   ⚠ ${p.rec.name}：按 filter 筛选后 0 个节点，已跳过该域名（不会清空现有记录）`);
    } else actionable.push(p);
  }

  // 7. 与现状比对
  const current = uploadReady ? await listRecords() : [];
  let changed = false;
  for (const p of actionable) {
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
    // 【提示要如实】与快速模式保持一致：不能笼统说「已是最优集合」。
    //   若域名全被 filter 筛成 0 个节点，真实情况是「没有可选 IP、现有记录可能已失效」，
    //   说成「最优」会让用户以为一切正常，而站点实际可能已经打不开。
    if (actionable.length === 0 && blocked.length > 0) {
      log('结论：本次没有可写入的节点，DNS 记录保持不变。');
      log('   ⚠ 上面列出的域名都被 filter 筛成了 0 个节点 —— 现有记录若已不可用，站点就会打不开。');
      log('   建议放宽 filter（改成 "mode": "deny" 且 tokens 留空即不限国家），详见 user.config.jsonc 里的注释。');
    } else if (blocked.length > 0) {
      log(`结论：可更新的 ${actionable.length} 个域名已是最优集合，跳过写入（另有 ${blocked.length} 个域名被 filter 筛成 0 个节点）。`);
    } else {
      log('结论：所有记录已是最优集合，跳过写入。');
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastRunAt: new Date().toISOString(), skipped: true, plan: actionable.map(p => ({ name: p.rec.name, ips: p.next })) }, null, 2));
    throw new ExitError(0);
  }

  const targets = FORCE ? actionable : actionable.filter(p => !p.same);
  if (DRY_RUN) throw new Error('内部保护：dry-run 状态下不应进入写入流程');

  // 8. 备份
  if (cfg.behavior.backupBeforeWrite) {
    const bak = path.join(BAK_DIR, `cf-backup-${RUN_ID}.json`);
    fs.writeFileSync(bak, JSON.stringify(current, null, 2), 'utf8');
    log(`已备份现有记录：${bak}`);
  }

  // 9. 写入（先增后删，避免中途失败导致记录变少）
  for (const p of targets) {
    const existing = current.filter(r => r.name === p.rec.name && r.type === p.rec.type);
    const keep = new Set(p.next);
    const toDelete = existing.filter(r => !keep.has(r.content));
    const have = new Set(existing.map(r => r.content));
    const toAdd = p.next.filter(ip => !have.has(ip));
    // ① 先新增
    try {
      for (const ip of toAdd) {
        await createRecord({
          type: p.rec.type, name: p.rec.name, content: ip,
          ttl: p.rec.ttl ?? 300, proxied: p.rec.proxied ?? false, comment: 'cf-best-ip-auto'
        });
        log(`   ADD ${p.rec.name} ${ip}`);
      }
    } catch (e) {
      log(`   ✗ ${p.rec.name} 新增失败，跳过这条记录（保持现状不改动）：${e.message}`);
      continue;
    }
    // ② 新增成功后再删旧
    try {
      for (const r of toDelete) { await deleteRecord(r.id); log(`   DEL ${p.rec.name} ${r.content}`); }
    } catch (e) {
      log(`   ✗ ${p.rec.name} 删除旧记录失败：${e.message}`);
    }
  }

  // 10. 验证
  log('---- 验证 ----');
  const after = await listRecords();
  let allOk = true;
  for (const p of actionable) {
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
