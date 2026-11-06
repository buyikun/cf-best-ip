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
  createLogger, loadSource, download, downloadTimed, quickProbe, pool, median,
  createCf, dohCheck, applyFilter, readJson, writeJson, relinkCheckRetry,
  measureLocalBandwidth, getNetworkProfile, readProfileStore, saveProfileStore, pruneOldFiles, loadConfig, findBaseDir
} from './cfip-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 根目录：配置文件与 var\ 运行目录所在的那一层（程序可以放在 src\ 子目录里）
const BASE = findBaseDir(HERE);
const argv = process.argv.slice(2);
// 参数识别：既认 `--dry-run`，也认 `--dry-run=true` / `--dry-run=1`。
//   （以前只用 argv.includes('--dry-run')，写成 --dry-run=true 会被当成没开 dry-run，
//     于是本该只演算的调试运行真的去改 DNS 了 —— 这是必须堵死的坑。）
const flag = n => argv.some(a => a === n || a === `${n}=true` || a === `${n}=1`);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const kv = argv.find(a => a.startsWith(`${n}=`));
  return kv ? kv.slice(n.length + 1) : d;
};
// 数值参数统一过一遍：非数字或非法值直接报错退出，不要带着 NaN 往下跑
//   否则 --probe abc 会让 slice(0, NaN) 返回空数组，报出「无可用节点」这种误导性的错误。
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
const { cfg, userPath, uploadReady, missing, userError, userConfigExists, suspicious } = loadConfig(CONFIG_PATH, USER_CONFIG_PATH);
if (!uploadReady) cfg.behavior.dryRun = true;   // 没填凭据 = 强制只测速，绝不写 DNS
const DRY = flag('--dry-run') || cfg.behavior.dryRun === true;
const F = {
  targetRatio: 0.6667, floorMbps: 2, targetCount: 10, minProbe: 60, uploadCount: 3,
  maxProbe: 80, probeConcurrency: 1, probeBytes: 1048576, probeTimeoutMs: 2500,
  verifyRounds: 2, maxSeconds: 480, historyFile: 'var/history.json', historyTtlHours: 12,
  bandwidthCacheFile: 'var/bandwidth.json', bandwidthCacheHours: 24, bandwidthSeconds: 4,
  targetMbps: 0, targetTtlDays: 30, healthCheck: true, qualityGuard: true, guardRatio: 0.5,
  fallbackAfterProbes: 30, localBandwidthMbps: 0,
  // 阶段1 并发预筛参数（轻量样本，只判断是否真能用，不追求速度准确）
  screenBytes: 16384, screenConcurrency: 8, screenTimeoutMs: 2500,
  sourceStatFile: 'var/source-stats.json', sourceStatTtlDays: 14, sourceStatWarmup: 30,
  ...(cfg.fast || {})
};
if (opt('--target')) F.targetMbps = optNum('--target', F.targetMbps, 0.1, 10000);
if (opt('--ratio')) F.targetRatio = optNum('--ratio', F.targetRatio, 0.05, 1);
if (opt('--probe')) F.maxProbe = optNum('--probe', F.maxProbe, 1, 100000);
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
  log('正在识别网络指纹（探测本地宽带出口）…');
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
  //    healthAllDead：现有 IP 全部不通/不达标 → 站点此刻处于打不开状态。
  //    后面若 filter 把候选筛成 0 个，就要降级「放弃 filter、优先保可用」，
  //    否则会跳过写入，让站点继续宕机（2026-11-06 真实踩过这个坑）。
  //    另外：DNS 里此刻没有任何 A 记录时，站点同样打不开，也按"已宕机"处理。
  let healthAllDead = uploadReady && curIps.length === 0;
  if (healthAllDead) log('   ⚠ 当前 DNS 没有任何 A 记录 —— 站点是打不开的，本次以「先恢复可用」为第一优先');
  let goodNow = [];   // 体检中达标的现役 IP（后面补齐数量时要优先保留它们）
  if (F.healthCheck && curIps.length) {
    log('---- 现状体检 ----');
    const healthRounds = Math.max(1, Number(F.healthRounds ?? 2));
    // 升级为「固定时长稳态测速」：每节点跑 2.5 秒，剥离 0.8s 慢启动
    // 慢节点绝不死等（2.5s 硬掐断），快节点拉满稳态带宽，精准判断现有 IP 是否真正合格
    const good = goodNow;
    for (const ip of curIps) {
      const samples = [];
      for (let r = 0; r < healthRounds; r++) {
        samples.push(await downloadTimed(ip, P, 2.5, 0.8));
      }
      const best = samples.filter(s => s.ok).sort((a, b) => b.mbps - a.mbps)[0];
      const ok = !!best && best.mbps >= target;
      const shown = best ? `${best.mbps}Mbps` : `不通(${samples[0]?.err || '?'})`;
      log(`   ${ip.padEnd(16)} ${shown.padEnd(12)} ${healthRounds > 1 ? `(${healthRounds} 次取最好) ` : ''}${ok ? '✔ 达标' : '✘ 不达标'}`);
      if (ok) good.push({ ip, mbps: best.mbps, ttfb: best.ttfb, cc: fresh[ip]?.cc || '' });
    }
    // 【要凑够数量，不能按现有条数打折扣】
    //   以前是 Math.min(uploadCount, curIps.length)：DNS 里只有 3 条时门槛就降成 3，
    //   3 个达标就收工 —— 结果永远补不到 uploadCount 个。
    //   现在要求「达标数」和「记录数」都够 uploadCount 才算收工，否则去优选补齐。
    const need = Math.max(1, Number(F.uploadCount ?? 3));
    const enoughCount = good.length >= need;
    const enoughRecords = curIps.length >= need;
    if (enoughCount && enoughRecords) {
      log(`结论：现有 ${good.length}/${curIps.length} 个 IP 仍达标，无需重新优选。`);
      saveHistory(good.sort((a, b) => b.mbps - a.mbps));
      writeJson(STATE_FILE, {
        lastRunAt: new Date().toISOString(), mode: 'fast', networkKey: net.key, healthPassed: true,
        target, targetSrc, inUse: curIps, stillGood: good.map(g => ({ ip: g.ip, mbps: g.mbps }))
      });
      throw new ExitError(0);
    }
    if (!enoughCount) {
      log(`   仅 ${good.length} 个仍达标（需要 ${need} 个），进入重新优选`);
    } else {
      log(`   达标的 ${good.length} 个够了，但 DNS 里只有 ${curIps.length} 条记录（想要 ${need} 条），进入优选补齐`);
    }
    healthAllDead = good.length === 0;
    if (healthAllDead) log('   ⚠ 现有 IP 全部不通/不达标 —— 站点此刻是打不开的，本次以「先恢复可用」为第一优先');
  }

  // 4. 拉源 + 按「数据源历史表现」动态排序
  const all = await loadSource(cfg.source, CFG_DIR, log);
  log(`源记录：${all.length} 条`);
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
  // 【前置排除：filter 用不上的节点，测速前就剔掉，不浪费精测时间】
  //   出方案时是按每个域名的 filter 筛的，凡是被所有域名都排除掉的节点，
  //   实测多少都快都没用 —— 测了也是白测。
  //   判定用并集：只要某个域名的 filter 想要它，就保留。
  //   （某域名 filter 为空 tokens = 不筛选 = 全都要，此时等于不排除，行为同以前。）
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
  // 给每个节点打上所属源的优先级分数
  const withScoreAll = all.map(r => {
    const label = r.sourceLabel || r.tier || 'unknown';
    return { ...r, srcLabel: label, srcScore: scoreOf(label, r.tier), wanted: wantedByAny(r.cc) ? 1 : 0 };
  });
  // 【安全阀】filter 一个都没命中时绝不照做 —— 那会让本轮没有任何候选，
  //   上游换个写法、或国家码拼错，就可能导致站点彻底没有可用 IP（11-06 踩过）。
  const minFilterKeep = Math.max(1, Number(F.minFilterKeep ?? 5));
  const wantedTotal = withScoreAll.filter(r => r.wanted).length;
  let withScore = withScoreAll;
  if (wantedTotal >= minFilterKeep) {
    withScore = withScoreAll.filter(r => r.wanted);
    log(`候选池：源里 ${withScoreAll.length} 个 → 按 filter 前置排除掉 ${withScoreAll.length - wantedTotal} 个必然用不上的节点，只测 ${withScore.length} 个`);
  } else if (wantedTotal > 0) {
    log(`⚠ filter 只命中 ${wantedTotal} 个（少于安全值 ${minFilterKeep}），本次不做前置排除，回退测全部 ${withScoreAll.length} 个`);
  } else {
    log(`⚠ filter 没有命中任何节点（国家码可能拼错了）—— 为避免本轮无候选，回退测全部 ${withScoreAll.length} 个`);
  }

  // 排序：历史实测过的活节点最优先 → 源分数高的优先
  // （不参考标称速度：实测与实际毫无相关性，只会引入噪声）
  const histRanked = withScore.filter(r => fresh[r.ip])
    .sort((a, b) => (fresh[b.ip].mbps - fresh[a.ip].mbps));
  const histIps = new Set(histRanked.map(r => r.ip));
  const restAll = withScore.filter(r => !histIps.has(r.ip) && r.port === P)
    .sort((a, b) => (b.srcScore - a.srcScore));
  // 现役 IP 不参与前置排除：它们是 DNS 里正在用的，体检已判过，
  //   达标的话早在体检分支就收工了，走到这里说明需要补齐或替换。
  const curRanked = curIps.map(ip => withScoreAll.find(r => r.ip === ip) || { ip, port: P, cc: '', fileMs: 0, fileMbps: 0, srcLabel: '(现用)', srcScore: 9 });
  const seenIp = new Set();
  const queue = [...curRanked, ...histRanked, ...restAll]
    .filter(r => (seenIp.has(r.ip) ? false : (seenIp.add(r.ip), true)))
    .slice(0, F.maxProbe)
    .map(r => ({ ...r, port: P }));

  // 打印源优先级，方便观察分级是否合理
  const bySrc = {};
  for (const r of withScoreAll) {   // 用全量源统计，但标注哪些被前置排除
    const k = r.srcLabel;
    (bySrc[k] ||= { n: 0, score: r.srcScore, tier: r.tier, kept: 0 });
    bySrc[k].n++;
    if (r.wanted) bySrc[k].kept++;
  }
  log('---- 数据源优先级（历史表现 + 新鲜度）----');
  Object.entries(bySrc).sort((a, b) => b[1].score - a[1].score).forEach(([k, v]) => {
    const s = srcStats[k];
    const hist = s ? `  上次: 测${s.tested}中${s.hit}达标 均速${(s.avgMbps || 0).toFixed(1)}Mbps` : '  (暂无历史)';
    const keep = withScore === withScoreAll ? `${String(v.n).padStart(4)}个` : `${String(v.kept).padStart(4)}/${String(v.n).padStart(4)}个`;
    log(`   ${v.score.toFixed(2)}  ${k.padEnd(28)} ${keep}${hist}`);
  });
  log(`候选队列：${queue.length} 个（按源优先级排序测试）`);

  // 5. 两阶段测速：并发预筛（淘汰死节点）→ 串行精测（准确测速）
  //    为什么这样拆：预筛只关心"通不通"，并发不抢带宽也无所谓；精测要准，必须串行。
  const tested = new Map();
  let stopped = false, adjusted = false, warned = false;
  const minProbe = Math.max(1, Number(F.minProbe ?? 60));
  const deadline = Date.now() + F.maxSeconds * 1000;
  const srcTagOf = c => (c.srcLabel ? ` 〔${c.srcLabel.slice(0, 12)}〕` : '');

  // ── 阶段1：并发预筛 ────────────────────────────────────────────
  const screenBytes = Number(F.screenBytes ?? 16384);
  const screenConc = Math.max(1, Number(F.screenConcurrency ?? 8));
  const screenTimeout = Number(F.screenTimeoutMs ?? 2500);
  const survivors = [];
  if (screenBytes > 0 && queue.length > 1) {
    log(`---- 阶段1/2：并发预筛 ${queue.length} 个（${(screenBytes / 1024).toFixed(0)}KB 样本，并发 ${screenConc}）----`);
    log(`   正在并发连接各节点，结果会逐个出现…`);
    const tS = Date.now();
    let doneCnt = 0;
    const total = queue.length;
    await pool(queue, screenConc, async c => {
      const r = await quickProbe(c.ip, c.port, screenBytes, screenTimeout);
      doneCnt++;
      const tag = r.ok ? '✓' : '✗';
      const info = r.ok ? `${r.ms}ms` : (r.err || '失败');
      const srcTag = srcTagOf(c);
      if (r.ok) survivors.push(c);
      // 每个节点完成都立即输出，让人明确看到进度在走（不会像卡死）
      const aliveNow = survivors.length;
      log(`   [${doneCnt}/${total}] ${tag} ${c.ip.padEnd(15)} ${info.padEnd(14)}${srcTag}  (存活 ${aliveNow})`);
    });
    const screenSec = ((Date.now() - tS) / 1000).toFixed(1);
    const killRate = queue.length ? ((1 - survivors.length / queue.length) * 100).toFixed(0) : 0;
    log(`预筛完成：${survivors.length}/${queue.length} 存活（淘汰 ${killRate}%），耗时 ${screenSec}s`);
    log(`---- 阶段2/2：串行精测存活节点（准确测速，避免并发抢带宽）----`);
  } else {
    log('---- 边测边收（达标即计数，凑够就停）----');
    survivors.push(...queue);
  }

  const testQueue = survivors;   // 只对存活者做精测

  // ── 阶段2：串行精测 + 早停 ─────────────────────────────────────
  await pool(testQueue, Math.max(1, Number(F.probeConcurrency)), async c => {
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
    // 阶段2 精测：每节点固定跑 1.5 秒，时间一到硬斩断，绝不死等拖延！
    const idx = tested.size + 1;
    const d = await downloadTimed(c.ip, c.port, 1.5, 0.4, p => {
      log(`   精测 [${idx}/${testQueue.length}] ${c.ip.padEnd(15)} 测速中(${p.elapsedSec}s) ${p.curMbps}Mbps`);
    });
    tested.set(c.ip, d);
    const prog = `${tested.size}/${testQueue.length}`;       // 整体进度，让用户看到还在动
    const srcTag = srcTagOf(c);
    // 门槛预选：由于 1.5s 短测时间较短，按 target * preselectRatio 做宽松预选进复核
    const preselect = Math.max(F.floorMbps, +(target * Number(F.preselectRatio ?? 0.4)).toFixed(2));
    if (d.ok && d.mbps >= preselect) {
      collected.push({ ip: c.ip, cc: c.cc, port: c.port, mbps: d.mbps, ttfb: d.ttfb, srcLabel: c.srcLabel || '' });
      const shown = Math.min(collected.length, F.targetCount);
      const tag = d.mbps >= target ? '' : `（预选，待复核确认≥${target}）`;
      log(`   [${shown}/${F.targetCount}] ✓ ${c.ip} ${c.cc} ${d.mbps}Mbps/${d.ttfb}ms${tag}${srcTag}`);
      if (collected.length >= F.targetCount) {
        if (tested.size >= minProbe) { stopped = true; log(`   已凑够 ${F.targetCount} 个候选，提前停止（共精测 ${tested.size} 个）`); }
        else if (!warned) { warned = true; log(`   已凑够 ${F.targetCount} 个候选，为保证质量继续多测到 ${minProbe} 个再停`); }
      }
    } else if (d.ok) {
      log(`   ${prog} ✗ ${c.ip} ${c.cc} ${d.mbps}Mbps 低于预选线(${preselect})${srcTag}`);
    } else {
      log(`   ${prog} ✗ ${c.ip} 失败(${d.err})${srcTag}`);
    }
  });
  // 精测阶段结束提示
  if (survivors.length) log(`精测完成：共测 ${tested.size} 个存活节点`);

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
  // 【复核名额要留够余量】复核结果是「已达标节点」里再取前 wantMin 名，
  //   但后面还要按每个域名的 filter 再筛一遍。filter 收紧（比如只留港/新/韩）时，
  //   复核结果里往往只有一两个符合 —— 名额太少就会"筛完不够数"。
  //   所以按 uploadCount 的 3 倍起步，且不低于 targetCount。
  const wantMin = Math.max(F.uploadCount * 3, F.targetCount);
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
  // 阶段3 复核：升级为「固定时长稳态测速」，每节点严格跑 3.0 秒（剥离前 0.8s 慢启动）
  // 彻底避免固定 4MB 遇到慢节点要卡 16 秒的痛点，跑满 3 秒立即算稳态速度并评级！
  const verifySec = Number(F.verifyDurationSec ?? 3.0);
  const warmSec = Number(F.verifyWarmSec ?? 0.8);
  log(`---- 复核 ${finalists.length} 名（${F.verifyRounds} 轮串行，每轮严格跑 ${verifySec} 秒求稳态极限）----`);
  for (let r = 1; r <= F.verifyRounds; r++) {
    let i = 0;
    for (const c of finalists) {
      i++;
      const d = await downloadTimed(c.ip, c.port, verifySec, warmSec, p => {
        log(`   复核 第${r}轮 [${i}/${finalists.length}] ${c.ip.padEnd(15)} 测速中(${p.elapsedSec}s) ${p.curMbps}Mbps`);
      });
      (c.samples ||= []).push(d);
      const st = d.ok ? `${d.mbps}Mbps (稳态)` : `失败(${d.err})`;
      log(`   复核 第${r}轮 [${i}/${finalists.length}] ${c.ip.padEnd(15)} → ${st}`);
    }
  }
  // 最终排名用大样本复核结果，并以真实速度重新判定达标
  // 排序：直接按实测速度从快到慢（延迟只作为并列时的次键，不参与主要排序）
  const ranked = finalists.map(c => {
    const ok = (c.samples || []).filter(s => s.ok);
    // colo 取自复核样本里最常见的那一个（anycast 可能换落点，取众数比取最后一次更稳）
    const coloCount = {};
    for (const s of ok) if (s.colo) coloCount[s.colo] = (coloCount[s.colo] || 0) + 1;
    const colo = Object.keys(coloCount).sort((a, b) => coloCount[b] - coloCount[a])[0] || '';
    return { ...c, colo, mbps: median(ok.map(s => s.mbps)) || c.mbps, ttfb: median(ok.map(s => s.ttfb)) || c.ttfb, okRate: ok.length / Math.max(1, (c.samples || []).length) };
  }).filter(r => r.okRate >= 0.5)
    .sort((a, b) => b.mbps - a.mbps || a.ttfb - b.ttfb);

  const passed = ranked.filter(r => r.mbps >= target);
  log('---- 复核排名（按实测速度）----');
  for (const r of ranked) {
    const mark = r.mbps >= target ? '✔ 达标' : `✘ 低于${target}`;
    const colo = r.colo ? ` ${String(r.colo).padEnd(4)}` : '';
    log(`   ${r.ip.padEnd(16)} ${String(r.cc).padEnd(4)}${colo} ${String(r.mbps).padStart(7)}Mbps  ttfb=${String(r.ttfb).padStart(4)}ms  ${mark}`);
  }
  log(`复核结论：${passed.length}/${ranked.length} 个真实达标（≥${target}Mbps）`);
  if (!passed.length) throw new Error(`复核后没有节点达到 ${target}Mbps，保留现有 DNS 记录不变`);
  // 后续方案只用真正达标的节点
  const finalRanked = passed;
  // 7. 方案 + 比对（只用真实达标的节点）
  //    【降级兜底】如果现有 IP 全挂了（站点打不开），而 filter 又把这个域名筛成 0 个节点，
  //    那"守 filter"的代价是站点继续宕机 —— 此时放弃 filter，先恢复可用。
  //    这正是快速模式的初衷：「我目的是可用，而不是最好用」。
  //
  //    【链路复验 relink】测速打的是 speed.cloudflare.com，跟你自己的域名通不通是两回事。
  //    实测遇到过「测速 20+Mbps、但换成真实域名直接 ECONNRESET」的节点。
  //    所以写 DNS 之前，用「域名本身」做 SNI + Host 打一次真实请求，打不开的直接剔除。
  //    这是最后一道闸，宁可少写几个 IP，也不要把打不开的 IP 写进去。
  const relinkCache = new Map();      // `${domain}|${ip}` → relinkCheck 结果，同一个 IP 只测一次
  const relinkOne = async (domain, ip) => {
    const key = `${domain}|${ip}`;
    if (!relinkCache.has(key)) relinkCache.set(key, await relinkCheckRetry(ip, domain, 3));
    return relinkCache.get(key);
  };
  const relinkDead = [];
  let relinkTried = 0;
  const plan = [];
  for (const rec of (cfg.cloudflare.records || [])) {
    const limit = Math.min(rec.topN ?? F.uploadCount, F.uploadCount);
    let candidates = applyFilter(finalRanked, rec.filter);
    let relaxed = false;
    if (candidates.length === 0 && healthAllDead) {
      candidates = finalRanked.slice();
      relaxed = true;
    }
    // 逐个做链路复验，凑够 limit 个就停；最多试 limit*4 个，避免大量打不开的节点拖长耗时
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
    // 【保住现役能用的】只是「数量不够、要补齐」时（healthAllDead=false），
    //   现役达标的 IP 优先占位，只用新优选的补足空额，
    //   避免为了凑够 5 个而把正在正常工作的 3 个也一起换掉。
    let keptInUse = [];
    if (!relaxed && !healthAllDead && goodNow.length) {
      const pickedIps = new Set(picked.map(r => r.ip));
      keptInUse = goodNow.filter(g => !pickedIps.has(g.ip));
      if (keptInUse.length) {
        const room = Math.max(0, limit - picked.length);
        const keep = keptInUse.slice(0, room);
        picked.push(...keep);
        keptInUse = keep;
      } else {
        keptInUse = [];
      }
    }
    plan.push({ rec, detail: picked, ips: picked.map(r => r.ip), relaxed, keptInUse });
  }
  if (relinkTried) {
    log(`---- 链路复验：试了 ${relinkTried} 次，剔除 ${relinkDead.length} 个「测速能过、但你的域名打不开」的节点 ----`);
    for (const d of relinkDead) log(`   ✘ ${d.ip.padEnd(16)} ${d.name} → ${d.err}`);
    if (!relinkDead.length) log('   ✔ 全部通过，没有需要剔除的节点');
  }
  log('---- 上传方案 ----');
  for (const p of plan) {
    const tail = p.relaxed ? '  ← 已暂时忽略 filter（先恢复可用）' : '';
    log(`   ${p.rec.name} <- ${p.ips.join(', ') || '(空)'}${tail}`);
    if (p.keptInUse?.length) {
      log(`      （其中 ${p.keptInUse.map(g => g.ip).join(', ')} 是现役可用、本次保留）`);
    }
  }
  // 【安全护栏】筛选结果为 0 个节点时，绝不参与写入。
  //   否则 toAdd 为空、toDelete 为全部现有记录 → 会把该域名的 A 记录清空。
  //   典型误配：filter.mode="allow" 但国家码拼错（如写成 SGP 而不是 SG）。
  const blocked = [];
  const actionable = [];
  for (const p of plan) {
    if (p.ips.length === 0) { p.next = []; p.same = true; blocked.push(p); }
    else actionable.push(p);
  }
  for (const p of blocked) {
    log(`   ⚠ ${p.rec.name}：按 filter 筛选后 0 个节点，已跳过该域名（不会清空现有记录）`);
  }
  let changed = false;
  for (const p of actionable) {
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
    saveHistory(finalRanked);
    throw new ExitError(0);
  }
  if (!changed && cfg.behavior.skipIfUnchanged && !flag('--force')) {
    // 【提示要如实】不能笼统说「已是最优集合」：
    //   若域名全被 filter 筛成 0 个节点，真实情况是「没有可选 IP、现有记录可能已失效」，
    //   说成「最优」会让用户以为一切正常，而站点实际可能已经打不开。
    if (actionable.length === 0 && blocked.length > 0) {
      log('结论：本次没有可写入的节点，DNS 记录保持不变。');
      log('   ⚠ 上面列出的域名都被 filter 筛成了 0 个节点 —— 现有记录若已不可用，站点就会打不开。');
      log('   建议放宽 filter（改成 "mode": "deny" 且 tokens 留空即不限国家），详见 user.config.jsonc 里的注释。');
    } else if (blocked.length > 0) {
      log(`结论：可更新的 ${actionable.length} 个域名已是最优集合，跳过写入（另有 ${blocked.length} 个域名被 filter 筛成 0 个节点）。`);
    } else {
      log('结论：已是最优集合，跳过写入。');
    }
    saveHistory(finalRanked);
    writeJson(STATE_FILE, { lastRunAt: new Date().toISOString(), mode: 'fast', networkKey: net.key, skipped: true, target, plan: actionable.map(p => ({ name: p.rec.name, ips: p.next })) });
    throw new ExitError(0);
  }
  // 质量保护：本次明显不如上次时不要替换
  const lastBest = Number(hist.lastRunBest || 0) || Math.max(0, ...Object.values(fresh).map(v => v.mbps || 0));
  const guardRatio = Number(F.guardRatio ?? 0.5);
  if (F.qualityGuard !== false && lastBest > 0 && finalRanked[0].mbps < lastBest * guardRatio && !flag('--force')) {
    log(`   质量保护触发：本次最佳 ${finalRanked[0].mbps}Mbps < 上次运行最佳 ${lastBest}Mbps × ${guardRatio}，跳过写入（要强制请加 --force）`);
    saveHistory(finalRanked);
    writeJson(STATE_FILE, { lastRunAt: new Date().toISOString(), mode: 'fast', guarded: true, lastBest, best: finalRanked[0].mbps });
    throw new ExitError(0);
  }
  if (DRY) throw new Error('内部保护：dry-run 状态下不应进入写入流程');

  // 8. 备份 + 写入
  const targets = flag('--force') ? actionable : actionable.filter(p => !p.same);
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
  for (const p of actionable) {
    const got = after.filter(r => r.name === p.rec.name && r.type === p.rec.type).map(r => r.content).sort();
    const ok = got.length === p.next.length && got.every((v, i) => v === p.next[i]);
    if (!ok) allOk = false;
    log(`   权威记录 ${p.rec.name}: ${ok ? 'OK' : '不一致！'} [${got.join(',')}]`);
    if (cfg.behavior.verifyDoh) {
      const pub = await dohCheck(p.rec.name);
      log(`   公网解析 ${p.rec.name}: ${p.next.every(ip => pub.includes(ip)) ? 'OK' : '缓存未过期/待刷新（TTL 300s）'} [${pub.join(',')}]`);
    }
  }
  saveHistory(finalRanked);
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
