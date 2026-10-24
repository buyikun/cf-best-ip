# CF 优选 IP 自动化（两种方案）

把「从线上订阅挑最快 IP → 用 Cloudflare API 替换 DNS A 记录」做成两条可复用的流水线。

## 三分钟上手（第一次用只看这里）

**第 1 步 · 装 Node.js**（没装的话）
到 <https://nodejs.org/zh-cn/download> 下载 **LTS 版**，一路"下一步"装完即可。
装完双击 `run-fast.cmd` 若仍提示找不到 Node，重启一次电脑就好。

> 它唯一的运行依赖就是 Node.js 18+，其余都是 Windows 自带。

**第 2 步 · 填你自己的 Cloudflare 信息**

先把 `user.config.jsonc.example` **改名为 `user.config.jsonc`**（去掉 `.example`）。

> ⚠️ Windows 默认隐藏扩展名，改名时容易变成 `user.config.jsonc.example.txt`。
> 建议先在资源管理器「查看」里勾选 **文件扩展名** 再改名。

然后用记事本打开它，只填三处（文件里每项都有中文注释）：

| 要填的 | 去哪拿 |
|---|---|
| `apiToken` | dash.cloudflare.com → 头像 → My Profile → API Tokens → 权限选 `Zone → DNS → Edit` |
| `zoneId` | dash.cloudflare.com 点进该域名 → 右下角 Overview 面板里的 Zone ID |
| `records` | 改成你自己的子域名（例如 `sub.你的域名.com`），条数随意 |

> **不填也能跑**：程序会自动进入**演示模式**——只测速、打印方案，几十秒出结果，绝不碰你的 DNS。
> 想先看效果，直接做第 3 步。
>
> 三项缺任意一项都不会上传。程序会明确告诉你缺的是哪项；如果配置写错了语法，
> 还会指出**第几行第几列**附近有问题。

**第 3 步 · 双击运行**

| 双击 | 用途 |
|---|---|
| `run-fast.cmd` | 日常用（推荐）：先体检现有 IP，达标几秒收工；不达标才重新优选 |
| `run-full.cmd` | 想挖出最快的节点时用：全量测速，6-8 分钟 |
| `make-desktop-shortcuts.cmd` | 把上面两个放到桌面（可选） |

**看结果 / 回滚**
- `var\logs\latest.log` —— 最近一次运行的完整日志（自动保留最近 3 次）
- `var\backups\` —— 每次改动 DNS 之前的完整备份，可据此回滚（保留最近 3 份）

整个文件夹可以直接拷给别人：**没有写死任何本机路径**，配置、缓存、日志、备份都在脚本旁边，
唯一的外部依赖是 Node.js。别人拿到后照着上面三步走即可。

### 文件夹结构

```
run-fast.cmd  run-full.cmd  run-cfip.cmd    ← 双击或命令行入口
make-desktop-shortcuts.cmd                  ← 建桌面图标
user.config.jsonc                           ← 你的配置（由 .example 改名而来）
README.md                                   ← 本文档
src\                                        ← 程序本体，不用动
  cfip-fast.mjs  cfip-auto.mjs  cfip-lib.mjs  cf-api.mjs
  cfip.config.json                          ← 内置默认参数
  make-desktop-shortcuts.ps1
var\                                        ← 运行产物，删了也不影响（会自动重建）
  logs\  backups\  cache\  state.json
```

---

## 常见问题

**提示找不到 Node.js**
没安装，或装了没重启。装 LTS 版后重启电脑即可。

**改完配置怎么生效**
保存文件就行，下次运行自动读取，不需要重启任何东西。

**提示"上游已 XXX 小时未更新"**
订阅源本身很久没更新了，不影响使用——程序会自己实测筛掉失效节点。
不过活节点会越来越少，遇到这种情况建议换订阅源（见下方「订阅源」）。

**测出来的速度和标注差很多**
正常。上游标注是别人测的、时间也久远，本程序一律以你本地实测为准。

**想换订阅源**
改 `user.config.jsonc` 里的 `source.urls`，可填多个，会自动合并去重。

**运行后多出了 var\ 文件夹**
那是运行产物（日志/备份/缓存），删掉也不影响，下次运行自动重建。

**为什么运行后根目录没变多文件**
所有运行日志与备份都写进 `var\` 了，根目录保持整洁。

---

## 两种方案对比

| | 🚀 快速模式 | 🔬 全量模式 |
|---|---|---|
| 入口 | `run-fast.cmd`（双击） / `node cfip-fast.mjs` | `run-full.cmd`（双击） / `node cfip-auto.mjs` |
| 耗时 | **约 2-4 分钟** | 约 6-8 分钟 |
| 探测方式 | **并发预筛（16KB）→ 串行精测**，达到达标线的节点凑够 N 个就停 | **全量预筛（不设上限）→ 幸存者各测 1 轮 → 前几名复核** |
| 达标线 | 本地网络带宽 × 2/3（可改绝对值） | 无（只按实测速度排名） |
| 上传 | 优中选优 **3 个** | 每条记录 **5 个** |
| 适合 | 日常自动跑、快速更新 | 想挖出极致速度的节点 |
| 弱点 | 网络波动时可能选不到最快的节点 | 慢 |

> 两者都支持 `--dry-run`（只出方案、绝不碰 Cloudflare）和 `--force`（无视"无变化/质量保护"强制写入）。

---

## 一键运行

- **双击 `run-fast.cmd`** → 快速方案，跑完窗口不会立刻关闭（方便看结果）
- **双击 `run-full.cmd`** → 全量模式
- 命令行（可带参数、不暂停）：
  ```cmd
  run-cfip.cmd                      :: 默认快速方案
  run-cfip.cmd fast --dry-run       :: 只出方案，不写 Cloudflare
  run-cfip.cmd full                 :: 全量模式
  node cfip-fast.mjs --probe 40 --target 5    :: 临时缩小探测规模/目标数量
  ```

### 桌面快捷方式（文件夹里带了生成脚本）

桌面上的「CF优选-快速模式」「CF优选-全量模式」随时可以用这个脚本重建（换电脑、误删、想改名都用它）：

- **双击 `make-desktop-shortcuts.cmd`** —— 最省事，跑完会暂停让你看结果
- 或者用命令（**在本文件夹根目录下执行**）：

  ```powershell
  # 创建两个桌面快捷方式
  powershell -NoProfile -ExecutionPolicy Bypass -File src\make-desktop-shortcuts.ps1

  # 删除桌面快捷方式
  powershell -NoProfile -ExecutionPolicy Bypass -File src\make-desktop-shortcuts.ps1 -Remove

  # 自定义快捷方式名字前缀（默认 CF优选）
  powershell -NoProfile -ExecutionPolicy Bypass -File src\make-desktop-shortcuts.ps1 -Prefix "优选"
  ```

脚本细节：桌面路径自动探测（兼容 OneDrive 重定向的桌面）、快捷方式的**工作目录锁定为本文件夹所在目录**
（保证日志/缓存/备份都落在本文件夹里）、不需要管理员权限，创建前会检查目标文件是否存在。

## 拷给别人用（不需要任何额外步骤）

直接把整个文件夹复制给对方（或压缩成 zip 发过去），**不用改任何路径**：

- 项目里**没有写死本机路径**：配置、缓存、日志、备份全部相对脚本所在目录
- 唯一外部依赖是 **Node.js 18+**；没装时双击 `run-fast.cmd` 会给中文提示 + 下载地址
- 桌面快捷方式脚本会自动探测对方的桌面（兼容 OneDrive 重定向）
- **对方第一次运行如果没填配置，会自动进入演示模式**：只测速、打印一份真实结果，
  几十秒就结束，不会碰他的 DNS —— 先看到效果，再去填配置

⚠️ **发出去之前务必清空你自己的凭据**：把 `user.config.jsonc` 里的 `apiToken`、`zoneId` 清空
（`records` 改成 `example.com` 之类的占位值），或者干脆删掉这个文件（程序会自动走演示模式）。
`var\` 目录里可能含有你的域名和 IP 记录，也建议一并删掉再打包。

对方拿到后的三步：**装 Node.js → 填 `user.config.jsonc` → 双击 `run-fast.cmd`**。

## 要改配置？只改这一个文件

**`user.config.jsonc`** 是给你填写的变量文件（JSONC 格式，支持 `//` 和 `/* */` 注释，字段旁边全都有中文说明）：

- Cloudflare 的 `apiToken` / `zoneId` / 要替换的 `records`（域名列表）
- 达标线 `targetMbps`、写入数量 `uploadCount`、订阅源 `source.urls` 等常用项

两条硬规则：

1. **不填就不上传**：`apiToken`、`zoneId`、`records` 任意一项为空（`""` 或 `[]`），
   脚本就只做测速、打印方案，**绝不调用 Cloudflare 写接口**（日志会明确写"只测速模式"）。
   想临时彻底停掉上传，把 `apiToken` 清空即可；或者在 `behavior.dryRun` 填 `true`。
2. **凭据只认这个文件**：`cfip.config.json` 里的 `cloudflare` 段只是占位，填什么都没用。

没写在 `user.config.jsonc` 里的项，会自动回退用 `cfip.config.json` 的内置默认值。

> ⚠️ `user.config.jsonc` 含明文 Token，别截图外发、别提交到公开仓库。

## 文件

| 文件（相对本文件夹） | 作用 |
|---|---|
| **`user.config.jsonc`** | ★ **你填写的变量文件**：CF 凭据、域名、阈值等，注释详细；不填就不上传 |
| `update.cmd` | ★ **一键在线升级**：双击即可从 GitHub 更新最新代码，自动保留你的个人配置与历史记录 |
| `README.md` | 本文档 |
| `run-fast.cmd` / `run-full.cmd` | 双击即跑（快速模式 / 全量模式） |
| `run-cfip.cmd` | 命令行通用入口，可带 `fast`/`full` 和参数 |
| `make-desktop-shortcuts.cmd` | 双击在桌面创建两个快捷方式 |
| `src\cfip-fast.mjs` | 快速模式主流程 |
| `src\cfip-auto.mjs` | 全量模式主流程 |
| `src\cfip-lib.mjs` | 两者共用的工具（源拉取/解析、探测、CF API、DoH 校验、配置加载、带宽探测、旧文件清理） |
| `src\cfip.config.json` | 程序内置默认参数（凭据段是占位，永远不会被使用） |
| `src\update.ps1` | 一键在线升级核心脚本（带多线路加速与用户配置保护） |
| `src\make-desktop-shortcuts.ps1` | 快捷方式脚本本体（支持 `-Remove`、`-Prefix`） |
| `src\cf-api.mjs` | 手工运维小工具：`node src\cf-api.mjs list` 列记录 / `set <域名> <ip,ip,...>` 指定记录 |
| `var\logs\latest.log` | 最近一次运行日志（只保留最近 3 次 + latest） |
| `var\backups\` | 每次写入前的完整 DNS 记录备份（只保留最近 3 份，可回滚） |
| `var\cache\` | 订阅缓存、探测历史、各网络的带宽/阈值档案、数据源表现统计 |
| `var\state.json` | 最近一次运行结果快照 |

---

## 快速方案的判定逻辑（重点）

目标：**快速模式下要的是「可用」，不是「最好」**——最好交给全量模式。

0. **网络指纹**：`出口 IP 段 + ASN`（例如 `AS12345|1.2`，具体值因网络而异）。
   换 WiFi / 换运营商会变成新指纹 → 自动重新校准阈值；网络换回去时，直接复用之前存的档案。
1. **达标线（IP 可用参考值）**：默认 `targetMbps: 8`。
   依据：实测多数 CF 节点落在 5-13Mbps，8Mbps 足够流畅 1080p；调高会更挑、但重新优选频率也上升。
   也可以设 `targetMbps: 0` 切到自动模式：`本地带宽 × targetRatio`（封顶 `targetMaxMbps`），
   结果按网络指纹存进 `var/cache/bandwidth.json` 档案，**下次同网络直接复用**，`targetTtlDays`（默认 30 天）后重新校准。
2. **现状体检（最省事的一步）**：直接解析 DNS 里正在用的 IP，每个测 `healthRounds`（默认 2）次取最好值
   （单次测量噪声极大：同一个 IP 有时 0Mbps、有时 300Mbps，必须多测）。
   **只要有 `uploadCount`（3）个仍达标 → 立即收工，完全不重新优选**，实测这种情形全程 **7 秒**。
3. **不达标才重新优选**，分两个阶段：
   - **阶段1 · 并发预筛**：用 16KB 极小样本、并发 32 路，快速判断每个候选"到底通不通"。
     实测判定准确率 **100%**（不误放死节点、不漏掉活节点），通常 4 秒筛完数百个节点。
     > 预筛不关心速度准不准，所以并发开大也不受影响——这也是它快的原因。
   - **阶段2 · 串行精测**：只对预筛存活的节点做测速，每节点严格跑 1.5 秒硬掐断，绝不多等。
     因为并发会互抢带宽（实测能把 77Mbps 压成 8Mbps，排名完全失真）。
     凑够 `targetCount`（10）个候选、且至少测满 `minProbe`（60）个就停。
4. **复核定生死**：入围节点采用**固定时长稳态测速**复核 `verifyRounds`（2）轮，每节点严格跑 3.0 秒，
   剥离前 0.8 秒慢启动求稳态极限，取中位数后按真实达标线重新判定，最终取最快 `uploadCount`（3）个写入 Cloudflare。
5. **质量保护**：本次最佳 < 上次运行最佳 × `guardRatio`（默认 0.5）时跳过写入，网络变差时不让它越换越差。

### ⚠ 为什么升级为「固定时长稳态测速」

这是实测发现并攻克的重要网络传输机制痛点：

**1. 慢节点绝不死等（避免卡死感）**：
- 如果按“固定下载 4MB”，遇到 1~2Mbps 的龟速节点，单个节点要卡在屏幕前**死等整整 16 秒**！
- 升级为“固定跑 2.5~3 秒”后，不管对端多慢，时间一到立即掐断，彻底消灭“卡死感”！

**2. 快节点拉满极限（剥离 TCP 慢启动）**：
- TCP 协议刚建立连接时有慢启动爬坡期，小文件还没加速完就传完了（实测 1MB 会被低估 3~6 倍）；
- 新引擎给足 2.5~3.0 秒加速时间，并自动丢弃前 0.8 秒慢启动，只采纳稳态净速率，精准还原节点真实带宽！

实测对照数据：

| IP | 固定下载 4MB 耗时/速度 | 固定跑 2.5s 稳态速度 | 本地带宽占比 |
|---|---|---|---|
| 172.64.52.127 | 16.2 秒 / 2.20 Mbps (卡死) | **实跑 2.5 秒 / 稳态 2.96 Mbps** | 3.2% [普通] |
| 185.209.85.248 | 2.0 秒 / 24.91 Mbps (被拉低) | **实跑 2.5 秒 / 稳态 105.54 Mbps** | 114.6% [极速(S级)] |
| 162.159.61.183 | 2.2 秒 / 22.75 Mbps (被拉低) | **实跑 2.5 秒 / 稳态 81.76 Mbps** | 88.7% [极速(S级)] |

## 定时自动运行

本项目本身不带调度器，用系统自带的计划任务即可。以 Windows「任务计划程序」为例：

- **程序**：`<本文件夹>\src\cfip-fast.mjs`（用 `node` 执行）
- **起始于**：本文件夹根目录
- **建议时间**：大陆上网高峰时段（19:00-23:00），这样选出的 IP 在高峰期也好用

多数情况下运行会走「现状体检」分支，几秒就结束；只有 IP 不达标时才做完整优选（2-5 分钟）。

> 提示：不要用 `--force`，否则每次都会重写 DNS 记录，失去"无变化跳过"的保护。

## 全量模式流程

目标：**把所有候选都实测一遍，挖出真正最快的节点**。全程只用实测数据判断。

1. 多源订阅合并去重（约 1100 个节点），**全部纳入，不排序、不截断**
2. **阶段1 · 预筛**：每个节点下载 16KB 小样本，淘汰死节点。
   不设数量上限（一个都不跳过），并发 32 时 1157 个约 92 秒完成。
3. **阶段2 · 初测**：幸存者各测 1 轮（1MB），排出初步名次
4. **阶段3 · 复核**：对初测前 `verifyTopN`（默认 15）名，用 **4MB 大样本**补测
   `verifyRounds`（默认 2）轮，测准真实速度后再定最终名次
5. 按记录的 `filter`（例如某条记录设了排除 JP，就只用非日本节点）取前 `topN` 个写入 Cloudflare

> 为什么复核要用 4MB：初测的 1MB 会因 TCP 慢启动低估 3~6 倍（实测某节点 1MB 测得 2.68Mbps，
> 4MB 测得 16.53Mbps）。用 1MB 的数值排名会选错节点。
>
> 为什么不用订阅源标注的速度排队：实测该值与真实速度毫无相关性
> （标称 10.27M 的实测失败，标称 4.09M 的实测 5.56M，标称值平均虚高 1.5 倍）。
> 为什么不用源的历史评分排队：全量模式要把所有候选都测，排序只改变先后、不改变结果。

## 订阅源

`source.urls` 支持两种写法：纯字符串，或 `{url, tier, name}` 对象。

```jsonc
"urls": [
  { "url": "https://api.uouin.com/cloudflare.html", "tier": "fresh",  "name": "麒麟优选" },
  { "url": "https://cf.junzhen.qzz.io/full_ips.txt", "tier": "fresh",  "name": "junzhen四川联通" },
  { "url": "https://cf.junzhen.qzz.io/full_ips_bj.txt", "tier": "fresh", "name": "junzhen北京电信" },
  { "url": "https://raw.githubusercontent.com/HandsomeMJZ/cfip/...", "tier": "legacy", "name": "GitHub主源" }
]
```

**两种格式都能解析**：
- 纯文本订阅（`1.2.3.4:443#JP [7M]`、`1.2.3.4:443#JP [45ms 12Mbps]`）
- **HTML 表格**（如麒麟优选 `api.uouin.com/cloudflare.html`，自动识别 `序号/运营商/IP/丢包率` 四列）
  运营商会映射成 `TEL/UNI/CMB` 存进 `cc` 字段，所以国家码过滤也能用

### 数据源按「历史表现」动态分级

这是本项目的一个核心设计——**不是按配置顺序死板地测，而是按每个源的实际表现排序**：

1. 每次运行记录各源的「测了几个 / 中了几个 / 平均速度」，存进 `var/source-stats.json`
2. 下次运行时按命中率排序（贝叶斯平滑，避免小样本极端值），表现好的源**优先测**
3. `tier` 只作底色：`fresh` 基础分 0.6，`legacy` 基础分 0.55
4. 表现记录 14 天后自动作废（`sourceStatTtlDays`）

实测效果：某个源上一轮测 8 个只中 1 个，下一轮它的得分就从 0.60 掉到 0.48，排到队尾。

> ⚠️ 上游数据质量差异很大：GitHub 主源最后提交 2026-09-07，标称高速的节点大面积失效。
> 所以两种方案都**不信任标称值**，一律本地重测；还会查 GitHub commit 时间，超过 6 小时打印过期告警。
> 线上全部拉不到时回退 `var/cache/full_ips.txt`，再不行才用本地快照。

## 关键参数速查（cfip.config.json）

| 参数 | 默认 | 说明 |
|---|---|---|
| `fast.targetMbps` | 8 | ★「IP 可用」参考阈值；填 0 改为按网络自动校准 |
| `fast.targetRatio` / `targetMaxMbps` | 0.6667 / 20 | 自动模式下：本地带宽 × 比例，封顶 20Mbps |
| `fast.targetTtlDays` | 30 | 网络档案里的校准值多少天后重新测 |
| `fast.healthRounds` | 2 | 现状体检每个 IP 测几次取最好（单次噪声大，别调成 1） |
| `fast.healthCheck` | true | 现状体检开关（`--skip-health` 可临时跳过） |
| `fast.targetCount` / `minProbe` | 10 / 60 | 凑够几个达标节点就停 / 至少测多少个才允许停 |
| `fast.uploadCount` | 3 | 最终写入几个 IP |
| `fast.screenBytes` | 16384 | 预筛样本大小；`0` = 关闭预筛，退回逐个精测 |
| `fast.screenConcurrency` | 32 | 预筛并发数，开大更快（预筛不测速度，不怕抢带宽） |
| `fast.probeConcurrency` | 1 | **精测阶段必须保持 1**：并发会互抢带宽，实测能把 77Mbps 压成 8Mbps |
| `fast.probeDurationSec` | 1.5 | 精测固定跑 1.5 秒硬掐断，绝不多等 |
| `fast.preselectRatio` | 0.4 | 精测预选门槛 = 达标线 × 该比例（短测会低估，故宽松预选） |
| `fast.verifyDurationSec` | 3.0 | 复核固定跑 3.0 秒（**测准稳态极限速度的关键**，见上文说明） |
| `fast.verifyWarmSec` | 0.8 | 剥离前 0.8 秒慢启动，只计算稳态速度 |
| `fast.maxProbe` / `maxSeconds` | 80 / 300 | 单轮最多测几个 / 探测阶段时间上限 |
| `fast.qualityGuard` / `guardRatio` | true / 0.5 | 质量保护开关与阈值 |
| `fast.localBandwidthMbps` | 0 | 0=自动测本地带宽；也可直接填死（如 100） |
| `probe.screenConcurrency` | 32 | 全量模式预筛并发（全量预筛不设数量上限） |
| `probe.candidates` | 0 | 全量模式初测多少个幸存者；`0` = 全部测 |
| `probe.probeDurationSec` | 1.5 | 全量模式初测每节点跑 1.5 秒硬掐断 |
| `probe.verifyTopN` / `verifyRounds` | 15 / 2 | 全量模式复核前几名、复核几轮 |
| `probe.verifyDurationSec` | 3.0 | 全量模式复核跑 3.0 秒求稳态极限 |
| `probe.verifyWarmSec` | 0.8 | 剥离前 0.8 秒慢启动 |

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（含"无变化跳过""质量保护跳过""dry-run 结束"） |
| 1 | 失败（源不可用 / 无可用节点 / API 报错），现有记录未被改动 |
| 2 | 全局超时，放弃写入 |
| 3 | 写入完成但验证不一致，需看日志 |

## 注意事项

- 两个方案都不会在失败时破坏现状：候选全不通、没有节点过质量门槛、API 报错等情况直接退出。
- `--dry-run` 已做双重保护：流程提前返回 + 写入前断言，实测确认不会产生任何写入。
- DNS 的 A 记录只能存 IP、不能存端口，所以探测统一用 **443**；只在 8443/2096 之类端口可用的节点会被淘汰。
- 本机若开着 mihomo/Clash 的 TUN，TCP 层探测会被"假接通"，真正的筛选靠 HTTP 下载那一步。
