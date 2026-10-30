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
import { pruneOldFiles, loadConfig, findBaseDir, loadSource as loadSourceLib, quickProbe, download, downloadTimed, pool, median } from './cfip-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = findBaseDir(HERE);   // 根目录（配置与 var\ 所在层），程序可放在 src\ 子目录
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const CONFIG_PATH = path.resolve(HERE, opt('--config', 'cfip.config.json'));   // 内置默认配置随程序在 src\
const USER_CONFIG_PATH = path.resolve(BASE, opt('--user-config', 'user.config.jsonc'));  // 用户配置在根目录
const { cfg, userPath, uploadReady, userError, missing, suspicious, userConfigExists } = loadConfig(CONFIG_PATH, USER_CONFIG_PATH);
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

  // 2. 候选池：去重后全部纳入，不做任何优先级排序
  //    全量模式的目标是「挖最快节点」，实测才是唯一依据。
  //    订阅源标注的速度与实测毫无相关性（标称 10.27M 的实测失败、
  //    标称 4.09M 的实测 5.56M），源的新旧/评分只代表历史，不影响本轮结果。
  //    排序只会改变测试先后，不改变最终排名，所以干脆不排序。
  const P = Number(cfg.probe.port);
  const gatePool = all.map(r => ({ ...r, port: P }));
  log(`候选池：共 ${gatePool.length} 个（全部纳入，不排序、不截断）`);

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
  const screenPool = gatePool;   // 全量：不设上限，一个都不跳过
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
  const prelim = testList.map(c => {
    const ok = c.samples.filter(s => s.ok);
    return { ...c, mbps: median(ok.map(s => s.mbps)), ttfb: median(ok.map(s => s.ttfb)), okRate: ok.length / c.samples.length };
  }).filter(r => r.okRate >= cfg.probe.minOkRate && r.mbps >= cfg.probe.minMedianMbps)
    .sort((a, b) => (b.mbps - a.mbps) || (a.ttfb - b.ttfb));

  log(`初测合格：${prelim.length} 个（要求 ok率≥${cfg.probe.minOkRate}，速度≥${cfg.probe.minMedianMbps}Mbps）`);
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
  // 【安全护栏】筛选结果为 0 个节点时，绝不参与写入。
  //   否则 keep 为空集合 → 该域名现有 A 记录会被全部删除。
  //   典型误配：filter.mode="allow" 但国家码拼错（如写成 SGP 而不是 SG）。
  const actionable = [];
  for (const p of plan) {
    if (p.ips.length === 0) log(`   ⚠ ${p.rec.name}：按 filter 筛选后 0 个节点，已跳过该域名（不会清空现有记录）`);
    else actionable.push(p);
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
    log('结论：所有记录已是最优集合，跳过写入。');
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
