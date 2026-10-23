#!/usr/bin/env node
/**
 * CF 优选 —— 快速模式（推荐日常使用）
 * ---------------------------------------------------------------
 * 目标：**快速模式下要的是「可用」，不是「最好」**（最好交给全量模式）
 *
 * 流程：
 *   0. 识别网络指纹（出口 IP + ASN）——换 WiFi / 换运营商会自动重新校准
 *   1. 取达标线：本网络档案里上次校准的值 → 没有才重新测本地带宽 × ratio
 *   2. 现状体检：直接解析/测试 DNS 里正在用的 IP
 *        只要有 uploadCount 个仍达标 → 立刻收工，完全不重新优选
 *   3. 否则按序（在用 IP → 历史活节点 → 标注速度）串行实测，凑够 targetCount 个就停
 *   4. 优中选优：复核后取最快 uploadCount 个写入 Cloudflare，并把本次校准出的阈值记入档案
 *
 * 用法：
 *   node cfip-fast.mjs                    # 正常执行
 *   node cfip-fast.mjs --dry-run          # 只出方案，绝不写 Cloudflare
 *   node cfip-fast.mjs --force            # 无视"无变化/质量保护"强制写入
 *   node cfip-fast.mjs --skip-health      # 跳过现状体检，强制重新优选
 *   node cfip-fast.mjs --target 10        # 临时指定达标线(Mbps)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLogger, loadSource, download, pool, median,
  createCf, dohCheck, applyFilter, readJson, writeJson,
  measureLocalBandwidth, getNetworkProfile, readProfileStore, saveProfileStore, pruneOldFiles, loadConfig, findBaseDir
} from './cfip-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 根目录：配置文件与 var\ 运行目录所在的那一层（程序可以放在 src\ 子目录里）
const BASE = findBaseDir(HERE);
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const CONFIG_PATH = path.resolve(HERE, opt('--config', 'cfip.config.json'));   // 内置默认配置随程序在 src\
const USER_CONFIG_PATH = path.resolve(BASE, opt('--user-config', 'user.config.jsonc'));  // 用户配置在根目录
const { cfg, userPath, uploadReady, missing, userError, userConfigExists, suspicious } = loadConfig(CONFIG_PATH, USER_CONFIG_PATH);
if (!uploadReady) cfg.behavior.dryRun = true;   // 没填凭据 = 强制只测速，绝不写 DNS
const DRY = flag('--dry-run') || cfg.behavior.dryRun === true;
const F = {
  targetRatio: 0.6667, floorMbps: 2, targetCount: 10, minProbe: 60, uploadCount: 3,
  maxProbe: 80, probeConcurrency: 1, probeBytes: 1048576, probeTimeoutMs: 2500,
  verifyRounds: 2, maxSeconds: 300, historyFile: 'var/history.json', historyTtlHours: 12,
  bandwidthCacheFile: 'var/bandwidth.json', bandwidthCacheHours: 24, bandwidthSeconds: 4,
  targetMbps: 0, targetTtlDays: 30, healthCheck: true, qualityGuard: true, guardRatio: 0.5,
  fallbackAfterProbes: 30, localBandwidthMbps: 0,
  sourceStatFile: 'var/source-stats.json', sourceStatTtlDays: 14, sourceStatWarmup: 30,
  ...(cfg.fast || {})
};
if (opt('--target')) F.targetMbps = Number(opt('--target'));
if (opt('--ratio')) F.targetRatio = Number(opt('--ratio'));
if (opt('--probe')) F.maxProbe = Number(opt('--probe'));
if (flag('--skip-health')) F.healthCheck = false;

const CFG_DIR = BASE;
const LOG_DIR = path.resolve(CFG_DIR, cfg.behavior.logDir || 'var/logs');
const BAK_DIR = path.resolve(CFG_DIR, cfg.behavior.backupDir || 'var/backups');
const STATE_FILE = path.resolve(CFG_DIR, cfg.behavior.stateFile || 'var/state-fast.json');
const HISTORY_FILE = path.resolve(CFG_DIR, F.historyFile || 'var/history.json');
const BW_FILE = path.resolve(CFG_DIR, F.bandwidthCacheFile || 'var/bandwidth.json');
const STAT_FILE = path.resolve(CFG_DIR, F.sourceStatFile || 'var/source-stats.json');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const { log, flush } = createLogger(LOG_DIR, RUN_ID);
fs.mkdirSync(BAK_DIR, { recursive: true });

const hard = setTimeout(() => { log('!! 全局超时，放弃本次写入'); flush(); process.exit(2); }, (cfg.behavior.globalTimeoutMinutes || 15) * 60000);
function done(code) { clearTimeout(hard); flush(); process.exitCode = code; setTimeout(() => process.exit(code), 250); }
// 提前结束必须用 throw，绝不能只调 done()——否则后面的写入代码还会继续跑
class ExitError extends Error { constructor(code) { super('early-exit'); this.code = code; this.isExit = true; } }

const P = Number(cfg.probe.port || 443);
const TOKEN = process.env.CF_TOKEN || cfg.cloudflare.apiToken;
const ZONE = process.env.CF_ZONE || cfg.cloudflare.zoneId;

log('=========== CF 优选（快速模式）开始 ===========');
log(`配置：${path.basename(CONFIG_PATH)}${uploadReady ? ' + ' + path.basename(userPath) : (userConfigExists ? '（用户配置存在但未填全）' : '（未配置用户变量文件）')}`);
// 域名填成示例值时，启动就提醒（别等到写入时才失败）
if (uploadReady && suspicious && suspicious.length) {
  log('');
  log('  ⚠ 检测到示例域名还没改成你自己的：');
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
    log('  │  ⚠ 你的配置文件有问题，已退回"只测速"模式                  │');
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
    log('  │      apiToken / zoneId / records（文件里每项都有中文说明） │');
    log('  └────────────────────────────────────────────────────────────┘');
    log('');
  }
  // 只测速模式：缩小规模，几十秒就出结果
  F.maxProbe = Math.min(Number(F.maxProbe) || 80, 8);
  F.targetCount = Math.min(Number(F.targetCount) || 10, 3);
  F.minProbe = Math.min(Number(F.minProbe) || 60, 4);
  F.healthCheck = false;
}
try {
  // 清理历史文件：备份和日志各只留最近 N 份
  const keepBak = Number(cfg.behavior.keepBackups ?? 3);
  const keepLog = Number(cfg.behavior.keepLogs ?? 3);
  const prB = pruneOldFiles(BAK_DIR, /^cf-backup-.*\.json$/, keepBak, log);
  const prL = pruneOldFiles(LOG_DIR, /^cfip-.*\.log$/, keepLog, null);
  if (prB || prL) log(`已清理历史文件：备份 ${prB} 个、日志 ${prL} 个（各保留最近 ${keepBak} 份）`);

  // 0. 网络指纹 + 历史
  const net = await getNetworkProfile(log);
  const hist = readJson(HISTORY_FILE, { ips: {} });
  const fresh = {};
  const now = Date.now();
  for (const [ip, v] of Object.entries(hist.ips || {})) {
    if (v && v.at && (now - Date.parse(v.at)) / 3600000 <= F.historyTtlHours) fresh[ip] = v;
  }
  const collected = [];   // 供 saveHistory 使用
  function saveHistory(list) {
    const ips = { ...fresh };
    for (const r of list) ips[r.ip] = { mbps: r.mbps, ttfb: r.ttfb, cc: r.cc || '', at: new Date().toISOString() };
    for (const c of collected) if (!ips[c.ip]) ips[c.ip] = { mbps: c.mbps, ttfb: c.ttfb, cc: c.cc, at: new Date().toISOString() };
    writeJson(HISTORY_FILE, { updatedAt: new Date().toISOString(), networkKey: net.key, lastRunBest: list[0]?.mbps || 0, ips });
  }

  // 1. 当前 DNS 记录（现状体检 + 队列优先都用它）
  const cf = createCf({ apiToken: TOKEN, zoneId: ZONE });
  let current = [];
  if (uploadReady) {
    try { current = await cf.list(); } catch (e) { log(`   读取当前 DNS 记录失败：${e.message}`); }
  }
  const names = new Set((cfg.cloudflare.records || []).map(r => r.name));
  const curIps = [...new Set(current.filter(r => r.type === 'A' && names.has(r.name)).map(r => r.content))];
  log(uploadReady ? `当前 DNS 在用 ${curIps.length} 个 IP：${curIps.join(', ') || '(无)'}` : '未配置上传，跳过现状体检');

  // 2. 达标线：本网络上次校准值优先
  const profStore = readProfileStore(BW_FILE);
  profStore.profiles ||= {};
  const prof = profStore.profiles[net.key] || {};
  const ttlDays = Number(F.targetTtlDays || 30);
  const autoMode = Number(F.targetMbps) <= 0;   // 只有自动模式才允许中途降级校准
  let target = 0, targetSrc = '', needCalibrate = false;
  if (Number(F.targetMbps) > 0) {
    target = Number(F.targetMbps); targetSrc = '命令行/配置指定的绝对值';
  } else if (prof.effectiveTarget > 0 && prof.targetMeasuredAt
    && (now - Date.parse(prof.targetMeasuredAt)) / 86400000 <= ttlDays) {
    target = prof.effectiveTarget;
    targetSrc = `本网络档案（${new Date(prof.targetMeasuredAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 校准）`;
  } else {
    needCalibrate = true;
    let baseline = 0, bwSrc = '';
    if (Number(F.localBandwidthMbps) > 0) { baseline = Number(F.localBandwidthMbps); bwSrc = '配置指定'; }
    else {
      const bw = await measureLocalBandwidth({
        seconds: F.bandwidthSeconds, cacheFile: BW_FILE, cacheTtlHours: F.bandwidthCacheHours,
        profileKey: net.key, log
      });
      baseline = bw.mbps; bwSrc = bw.source;
    }
    const cap = Number(F.targetMaxMbps || 999);
    target = baseline > 0 ? Math.max(F.floorMbps, Math.min(cap, +(baseline * F.targetRatio).toFixed(2))) : F.floorMbps;
    targetSrc = baseline > 0
      ? `本地带宽 ${baseline}Mbps(${bwSrc}) × ${F.targetRatio}${baseline * F.targetRatio > cap ? `（封顶 ${cap}）` : ''}`
      : `探测失败，取下限`;
  }
  log(`达标线：${target}Mbps（${targetSrc}）`);

  // 3. 现状体检：DNS 里正在用的 IP 达标就不折腾（快速模式的初衷：可用即可）
  if (F.healthCheck && curIps.length) {
    log('---- 现状体检 ----');
    const healthRounds = Math.max(1, Number(F.healthRounds ?? 2));
    const good = [];
    for (const ip of curIps) {
      const samples = [];
      for (let r = 0; r < healthRounds; r++) samples.push(await download(ip, P, F.probeBytes, F.probeTimeoutMs));
      const best = samples.filter(s => s.ok).sort((a, b) => b.mbps - a.mbps)[0];
      const ok = !!best && best.mbps >= target;
      const shown = best ? `${best.mbps}Mbps` : `不通(${samples[0]?.err || '?'})`;
      log(`   ${ip.padEnd(16)} ${shown.padEnd(12)} ${healthRounds > 1 ? `(${healthRounds} 次取最好) ` : ''}${ok ? '✔ 达标' : '✘ 不达标'}`);
      if (ok) good.push({ ip, mbps: best.mbps, ttfb: best.ttfb, cc: fresh[ip]?.cc || '' });
    }
    const need = Math.min(F.uploadCount, curIps.length);
    if (good.length >= need) {
      log(`结论：现有 ${good.length}/${curIps.length} 个 IP 仍达标，无需重新优选。`);
      saveHistory(good.sort((a, b) => b.mbps - a.mbps));
      writeJson(STATE_FILE, {
        lastRunAt: new Date().toISOString(), mode: 'fast', networkKey: net.key, healthPassed: true,
        target, targetSrc, inUse: curIps, stillGood: good.map(g => ({ ip: g.ip, mbps: g.mbps }))
      });
      throw new ExitError(0);
    }
    log(`   仅 ${good.length} 个仍达标（需要 ${need} 个），进入重新优选`);
  }

  // 4. 拉源 + 按「数据源历史表现」动态排序
  const all = await loadSource(cfg.source, CFG_DIR, log);
  log(`源记录：${all.length} 条，其中带速度标注 ${all.filter(r => r.fileMbps > 0).length} 条`);
  if (!all.length) throw new Error('源里没有可解析的 IP');

  // ── 读数据源表现档案，算出每个源的优先级分数 ──────────────────
  // 档案记录每次运行中「该源贡献了多少个达标节点 / 测了多少个 / 平均速度」
  const statStore = readJson(STAT_FILE, { sources: {} });
  const statTtlMs = Number(F.sourceStatTtlDays ?? 14) * 86400000;
  const srcStats = {};
  for (const [label, v] of Object.entries(statStore.sources || {})) {
    if (!v || !v.updatedAt) continue;
    if (now - Date.parse(v.updatedAt) > statTtlMs) continue;      // 太久没更新的表现记录作废
    srcStats[label] = v;
  }
  // 优先级分数 = 历史命中率（达标数/测试数），小样本用贝叶斯平滑避免极端值
  // 命中率高的源优先；平均速度只做小幅加权；tier 只作基础底色（新鲜源略优）
  function scoreOf(label, tier) {
    const s = srcStats[label];
    const base = tier === 'legacy' ? 0.55 : 0.6;      // 同类源的基础分
    if (!s || (s.tested || 0) === 0) return base;      // 真正冷启动：给基础分
    const tested = s.tested || 0, hit = s.hit || 0;
    // 贝叶斯平滑：先验 20% 命中率、权重 8 次（小样本会向 0.2 收敛，样本多了才信实测）
    const smoothed = (hit + 0.2 * 8) / (tested + 8);
    const speedFactor = Math.min(1, (s.avgMbps || 0) / 20);
    // 平滑命中率为主（权重 1.0），速度微调（最多 +0.2），整体乘 tier 底色
    return +(base * (0.4 + smoothed * 1.2 + speedFactor * 0.2)).toFixed(3);
  }
  // 给每个节点打上所属源的优先级分数
  const withScore = all.map(r => {
    const label = r.sourceLabel || r.tier || 'unknown';
    return { ...r, srcLabel: label, srcScore: scoreOf(label, r.tier) };
  });

  // 排序：历史实测过的活节点最优先 → 源分数高的优先 → 同源内标注速度高的优先
  const histRanked = withScore.filter(r => fresh[r.ip]).sort((a, b) => fresh[b.ip].mbps - fresh[a.ip].mbps);
  const histIps = new Set(histRanked.map(r => r.ip));
  const restAll = withScore.filter(r => !histIps.has(r.ip) && r.port === P)
    .sort((a, b) => (b.srcScore - a.srcScore) || (b.fileMbps - a.fileMbps) || (a.fileMs - b.fileMs));
  const curRanked = curIps.map(ip => withScore.find(r => r.ip === ip) || { ip, port: P, cc: '', fileMs: 0, fileMbps: 0, srcLabel: '(现用)', srcScore: 9 });
  const seenIp = new Set();
  const queue = [...curRanked, ...histRanked, ...restAll]
    .filter(r => (seenIp.has(r.ip) ? false : (seenIp.add(r.ip), true)))
    .slice(0, F.maxProbe)
    .map(r => ({ ...r, port: P }));

  // 打印源优先级，方便观察分级是否合理
  const bySrc = {};
  for (const r of withScore) {
    const k = r.srcLabel;
    (bySrc[k] ||= { n: 0, score: r.srcScore, tier: r.tier });
    bySrc[k].n++;
  }
  log('---- 数据源优先级（历史表现 + 新鲜度）----');
  Object.entries(bySrc).sort((a, b) => b[1].score - a[1].score).forEach(([k, v]) => {
    const s = srcStats[k];
    const hist = s ? `  上次: 测${s.tested}中${s.hit}达标 均速${(s.avgMbps || 0).toFixed(1)}Mbps` : '  (暂无历史)';
    log(`   ${v.score.toFixed(2)}  ${k.padEnd(28)} ${String(v.n).padStart(4)}个${hist}`);
  });
  log(`候选队列：${queue.length} 个（按源优先级排序测试）`);

  // 5. 顺序测试 + 早停
  const tested = new Map();
  let stopped = false, adjusted = false, warned = false;
  const minProbe = Math.max(1, Number(F.minProbe ?? 60));
  const deadline = Date.now() + F.maxSeconds * 1000;
  log('---- 边测边收（达标即计数，凑够就停）----');
  await pool(queue, Math.max(1, Number(F.probeConcurrency)), async c => {
    if (stopped) return;
    if (Date.now() > deadline) { if (!stopped) { stopped = true; log(`   ! 达到时间上限 ${F.maxSeconds}s，停止探测`); } return; }
    if (collected.some(x => x.ip === c.ip)) return;
    if (!adjusted && autoMode && collected.length === 0 && tested.size >= (F.fallbackAfterProbes ?? 30)) {
      adjusted = true;
      const okVals = [...tested.values()].filter(d => d.ok).map(d => d.mbps);
      if (okVals.length) {
        const nt = Math.max(F.floorMbps, +(Math.max(...okVals) * F.targetRatio).toFixed(2));
        if (nt < target) { log(`   达标线 ${target}Mbps 偏高（跨境很难达到本地带宽的 ${F.targetRatio}），自动校准为 观测峰值×${F.targetRatio} = ${nt}Mbps`); target = nt; targetSrc = '本轮实测校准'; }
      }
    }
    const d = await download(c.ip, c.port, F.probeBytes, F.probeTimeoutMs);
    tested.set(c.ip, d);
    if (d.ok && d.mbps >= target) {
      collected.push({ ip: c.ip, cc: c.cc, port: c.port, mbps: d.mbps, ttfb: d.ttfb, srcLabel: c.srcLabel || '' });
      const shown = Math.min(collected.length, F.targetCount);
      const srcTag = c.srcLabel ? ` 〔${c.srcLabel.slice(0, 12)}〕` : '';
      log(`   [${shown}/${F.targetCount}] ${c.ip} ${c.cc} ${d.mbps}Mbps/${d.ttfb}ms${srcTag}`);
      if (collected.length >= F.targetCount) {
        if (tested.size >= minProbe) { stopped = true; log(`   已凑够 ${F.targetCount} 个达标节点，提前停止（共测 ${tested.size} 个，队列还剩 ${queue.length - tested.size} 个没测）`); }
        else if (!warned) { warned = true; log(`   已凑够 ${F.targetCount} 个，为保证质量继续多测到 ${minProbe} 个再停`); }
      }
    } else if (!d.ok && cfg.behavior.verbose) log(`   - ${c.ip} 不通(${d.err})`);
  });

  // ── 更新数据源表现档案（供下次按表现排序）────────────────────
  {
    const per = {};
    for (const [ip, d] of tested.entries()) {
      const q = queue.find(x => x.ip === ip);
      const label = q?.srcLabel || 'unknown';
      (per[label] ||= { tested: 0, hit: 0, sumMbps: 0, okCount: 0 });
      per[label].tested++;
      if (d.ok) { per[label].okCount++; per[label].sumMbps += d.mbps; }
      if (d.ok && d.mbps >= target) per[label].hit++;
    }
    const store = readJson(STAT_FILE, { sources: {} });
    store.sources ||= {};
    for (const [label, v] of Object.entries(per)) {
      const old = store.sources[label] || {};
      // 指数滑动平均，让近期表现权重更高（旧记录占 60%，本次占 40%）
      const blend = (a, b, w = 0.4) => (a == null ? b : a * (1 - w) + b * w);
      store.sources[label] = {
        tested: Math.round(blend(old.tested, v.tested)),
        hit: Math.round(blend(old.hit, v.hit)),
        avgMbps: +blend(old.avgMbps, v.okCount ? v.sumMbps / v.okCount : 0).toFixed(2),
        lastRun: { tested: v.tested, hit: v.hit, at: new Date().toISOString() },
        updatedAt: new Date().toISOString()
      };
    }
    writeJson(STAT_FILE, store);
    log('---- 数据源本轮表现（已记入档案，下次按此排序）----');
    for (const [label, v] of Object.entries(per)) {
      const rate = v.tested ? Math.round((v.hit / v.tested) * 100) : 0;
      log(`   ${label.padEnd(28)} 测${String(v.tested).padStart(3)} 中${String(v.hit).padStart(2)} (${rate}%)`);
    }
  }
  log(`探测结束：共测 ${tested.size} 个，达标 ${collected.length} 个（达标线 ${target}Mbps）`);
  if (!tested.size) throw new Error('一个节点都没测成，保留现有 DNS 记录不变');

  // 6. 优中选优
  let candidateList = collected.slice();
  const wantMin = Math.max(F.uploadCount * 2, F.targetCount);
  if (candidateList.length < wantMin) {
    const have = new Set(candidateList.map(x => x.ip));
    const extras = [...tested.entries()]
      .filter(([ip, d]) => d.ok && !have.has(ip))
      .map(([ip, d]) => ({ ip, cc: (queue.find(q => q.ip === ip) || {}).cc || '', port: P, mbps: d.mbps, ttfb: d.ttfb }))
      .sort((a, b) => b.mbps - a.mbps)
      .slice(0, wantMin - candidateList.length);
    if (extras.length) log(`   达标只有 ${candidateList.length} 个，补入已测最快的 ${extras.length} 个一起复核`);
    candidateList = candidateList.concat(extras);
  }
  const finalists = candidateList.sort((a, b) => b.mbps - a.mbps).slice(0, wantMin);
  log(`---- 复核前 ${finalists.length} 名（${F.verifyRounds} 轮串行）----`);
  for (let r = 1; r <= F.verifyRounds; r++) {
    for (const c of finalists) {
      const d = await download(c.ip, c.port, cfg.probe.bytes || F.probeBytes, cfg.probe.downloadTimeoutMs || 6000);
      (c.samples ||= []).push(d);
    }
    log(`   第 ${r}/${F.verifyRounds} 轮复核完成`);
  }
  const ranked = finalists.map(c => {
    const ok = (c.samples || []).filter(s => s.ok);
    return { ...c, mbps: median(ok.map(s => s.mbps)) || c.mbps, ttfb: median(ok.map(s => s.ttfb)) || c.ttfb, okRate: ok.length / Math.max(1, (c.samples || []).length) };
  }).filter(r => r.okRate >= 0.5).sort((a, b) => b.mbps - a.mbps || a.ttfb - b.ttfb);
  log('---- 复核排名 ----');
  for (const r of ranked) log(`   ${r.ip.padEnd(16)} ${r.cc} ${String(r.mbps).padStart(7)}Mbps  ttfb=${r.ttfb}ms`);
  if (!ranked.length) throw new Error('复核后没有稳定节点，保留现有 DNS 记录不变');

  // 7. 方案 + 比对
  const plan = (cfg.cloudflare.records || []).map(rec => {
    const limit = Math.min(rec.topN ?? F.uploadCount, F.uploadCount);
    const picked = applyFilter(ranked, rec.filter).slice(0, limit);
    return { rec, detail: picked, ips: picked.map(r => r.ip) };
  });
  log('---- 上传方案 ----');
  for (const p of plan) log(`   ${p.rec.name} <- ${p.ips.join(', ') || '(空)'}`);
  let changed = false;
  for (const p of plan) {
    const cur = current.filter(r => r.name === p.rec.name && r.type === p.rec.type).map(r => r.content).sort();
    const next = [...p.ips].sort();
    p.next = next; p.same = cur.length === next.length && cur.every((v, i) => v === next[i]);
    if (!p.same) changed = true;
    log(`   ${p.rec.name}: 现状[${cur.join(',')}] -> [${next.join(',')}] ${p.same ? '（无变化）' : '（将更新）'}`);
  }

  // 把本次校准出的达标线记入「本网络档案」，下次直接复用
  if (needCalibrate || adjusted) {
    profStore.profiles[net.key] = {
      ...(profStore.profiles[net.key] || {}),
      effectiveTarget: target, targetMeasuredAt: new Date().toISOString(), targetSrc,
      asn: net.asn, isp: net.isp, egressIp: net.ip
    };
    saveProfileStore(BW_FILE, profStore);
    log(`已把达标线 ${target}Mbps 记入本网络档案（${net.key}），下次运行直接复用`);
  }

  // 【硬保证】只测速模式 / dry-run：在任何写入动作之前就退出
  if (DRY) {
    log(flag('--dry-run')
      ? 'DRY-RUN：以上为方案，未调用 Cloudflare 写接口。'
      : '只测速模式（未配置 Cloudflare 凭据 / behavior.dryRun=true）：未调用 Cloudflare 写接口，DNS 记录未变动。');
    saveHistory(ranked);
    throw new ExitError(0);
  }
  if (!changed && cfg.behavior.skipIfUnchanged && !flag('--force')) {
    log('结论：已是最优集合，跳过写入。');
    saveHistory(ranked);
    writeJson(STATE_FILE, { lastRunAt: new Date().toISOString(), mode: 'fast', networkKey: net.key, skipped: true, target, plan: plan.map(p => ({ name: p.rec.name, ips: p.next })) });
    throw new ExitError(0);
  }
  // 质量保护：本次明显不如上次时不要替换
  const lastBest = Number(hist.lastRunBest || 0) || Math.max(0, ...Object.values(fresh).map(v => v.mbps || 0));
  const guardRatio = Number(F.guardRatio ?? 0.5);
  if (F.qualityGuard !== false && lastBest > 0 && ranked[0].mbps < lastBest * guardRatio && !flag('--force')) {
    log(`   质量保护触发：本次最佳 ${ranked[0].mbps}Mbps < 上次运行最佳 ${lastBest}Mbps × ${guardRatio}，跳过写入（要强制请加 --force）`);
    saveHistory(ranked);
    writeJson(STATE_FILE, { lastRunAt: new Date().toISOString(), mode: 'fast', guarded: true, lastBest, best: ranked[0].mbps });
    throw new ExitError(0);
  }
  if (DRY) throw new Error('内部保护：dry-run 状态下不应进入写入流程');

  // 8. 备份 + 写入
  const targets = flag('--force') ? plan : plan.filter(p => !p.same);
  const failed = [];          // 写入失败的记录（不中断整体流程）
  if (cfg.behavior.backupBeforeWrite) {
    const bak = path.join(BAK_DIR, `cf-backup-${RUN_ID}.json`);
    fs.writeFileSync(bak, JSON.stringify(current, null, 2), 'utf8');
    log(`已备份现有记录：${bak}`);
  }
  for (const p of targets) {
    const existing = current.filter(r => r.name === p.rec.name && r.type === p.rec.type);
    const keep = new Set(p.next);
    // 先只删「新集合里不需要的」，但保留一份待删清单，等新增全部成功后再删，避免中途失败导致记录清空
    const toDelete = existing.filter(r => !keep.has(r.content));
    const have = new Set(existing.map(r => r.content));
    const toAdd = p.next.filter(ip => !have.has(ip));

    // ① 先新增（失败就跳过这条记录，不动现有的）
    try {
      for (const ip of toAdd) {
        await cf.create({ type: p.rec.type, name: p.rec.name, content: ip, ttl: p.rec.ttl ?? 300, proxied: p.rec.proxied ?? false, comment: 'cf-best-ip-fast' });
        log(`   ADD ${p.rec.name} ${ip}`);
      }
    } catch (e) {
      log(`   ✗ ${p.rec.name} 新增失败，跳过这条记录（保持现状不改动）：${e.message}`);
      failed.push({ name: p.rec.name, reason: e.message });
      continue;
    }
    // ② 新增成功后才删除旧记录
    try {
      for (const r of toDelete) { await cf.del(r.id); log(`   DEL ${p.rec.name} ${r.content}`); }
    } catch (e) {
      log(`   ✗ ${p.rec.name} 删除旧记录失败：${e.message}`);
      failed.push({ name: p.rec.name, reason: e.message });
    }
  }
  if (failed.length) {
    log('');
    log(`  ⚠ 有 ${failed.length} 条记录写入失败，其余记录已正常更新：`);
    for (const f of failed) log(`     - ${f.name}：${f.reason}`);
    log('     常见原因：该域名不在你填的 zoneId 所属域名下（例如还留着示例 sub2.example.com）');
    log('              请检查 user.config.jsonc 的 records，把它改成你自己的域名，或删掉不需要的那条');
  }

  // 9. 验证
  log('---- 验证 ----');
  const after = await cf.list();
  let allOk = true;
  for (const p of plan) {
    const got = after.filter(r => r.name === p.rec.name && r.type === p.rec.type).map(r => r.content).sort();
    const ok = got.length === p.next.length && got.every((v, i) => v === p.next[i]);
    if (!ok) allOk = false;
    log(`   权威记录 ${p.rec.name}: ${ok ? 'OK' : '不一致！'} [${got.join(',')}]`);
    if (cfg.behavior.verifyDoh) {
      const pub = await dohCheck(p.rec.name);
      log(`   公网解析 ${p.rec.name}: ${p.next.every(ip => pub.includes(ip)) ? 'OK' : '缓存未过期/待刷新（TTL 300s）'} [${pub.join(',')}]`);
    }
  }
  saveHistory(ranked);
  writeJson(STATE_FILE, {
    lastRunAt: new Date().toISOString(), mode: 'fast', networkKey: net.key, ok: allOk, target, targetSrc,
    testedCount: tested.size, collectedCount: collected.length,
    applied: targets.map(p => ({ name: p.rec.name, ips: p.next })),
    ranking: ranked.map(r => ({ ip: r.ip, cc: r.cc, mbps: r.mbps, ttfb: r.ttfb }))
  });
  log(allOk ? '=========== 完成：写入并验证通过 ===========' : '=========== 完成：但验证存在偏差，请查看日志 ===========');
  done(allOk ? 0 : 3);
} catch (e) {
  if (e && e.isExit) done(e.code);
  else { log(`!! 任务失败：${e.message}`); done(1); }
}
