# CF 优选 IP 自动化（两种方案）

把「从线上订阅挑最快 IP → 用 Cloudflare API 替换 DNS A 记录」做成两条可复用的流水线。

## 三分钟上手（第一次用只看这里）

**第 1 步 · 装 Node.js**（没装的话）
到 <https://nodejs.org/zh-cn/download> 下载 **LTS 版**，一路"下一步"装完即可。
装完双击 `run-fast.cmd` 若仍提示找不到 Node，重启一次电脑就好。

**第 2 步 · 填你自己的 Cloudflare 信息**
用记事本打开 **`user.config.jsonc`**，只填三处（文件里每项都有中文注释）：

| 要填的 | 去哪拿 |
|---|---|
| `apiToken` | dash.cloudflare.com → 头像 → My Profile → API Tokens → 权限选 `Zone → DNS → Edit` |
| `zoneId` | dash.cloudflare.com 点进该域名 → 右下角 Overview 面板里的 Zone ID |
| `records` | 改成你自己的子域名（例如 `sub.你的域名.com`），条数随意 |

> **不填也能跑**：程序会自动进入**演示模式**——只测速、打印方案，几十秒出结果，绝不碰你的 DNS。
> 想先看效果，直接做第 3 步。

**第 3 步 · 双击运行**

| 双击 | 用途 |
|---|---|
| `run-fast.cmd` | 日常用（推荐）：先体检现有 IP，达标几秒收工；不达标才重新优选 |
| `run-full.cmd` | 想挖出最快的节点时用：全量测速，6-8 分钟 |
| `make-desktop-shortcuts.cmd` | 把上面两个放到桌面（可选） |

结果看 `logs\latest.log`；每次改动 DNS 前的完整记录备份在 `backups\`（只留最近 3 份）。

整个文件夹可以直接拷给别人：**没有写死任何本机路径**，配置、缓存、日志、备份都在脚本旁边，
唯一的外部依赖是 Node.js。别人拿到后照着上面三步走即可。

---

## 两种方案对比

| | 🚀 快速早停方案 | 🔬 全量方案 |
|---|---|---|
| 入口 | `run-fast.cmd`（双击） / `node cfip-fast.mjs` | `run-full.cmd`（双击） / `node cfip-auto.mjs` |
| 耗时 | **约 2-4 分钟** | 约 6-8 分钟 |
| 探测方式 | 按序**串行**逐个测，达到达标线的节点凑够 N 个就停 | TCP 门控 → HTTP 粗筛 → 存活节点全部测 3 轮 |
| 达标线 | 本地网络带宽 × 2/3（可改绝对值） | 无（只按实测速度排名） |
| 上传 | 优中选优 **3 个** | 每条记录 **5 个** |
| 适合 | 日常自动跑、快速更新 | 想挖出极致速度的节点 |
| 弱点 | 网络波动时可能选不到最快的节点 | 慢 |

> 两者都支持 `--dry-run`（只出方案、绝不碰 Cloudflare）和 `--force`（无视"无变化/质量保护"强制写入）。

---

## 一键运行

- **双击 `run-fast.cmd`** → 快速方案，跑完窗口不会立刻关闭（方便看结果）
- **双击 `run-full.cmd`** → 全量方案
- 命令行（可带参数、不暂停）：
  ```cmd
  run-cfip.cmd                      :: 默认快速方案
  run-cfip.cmd fast --dry-run       :: 只出方案，不写 Cloudflare
  run-cfip.cmd full                 :: 全量方案
  node cfip-fast.mjs --probe 40 --target 5    :: 临时缩小探测规模/目标数量
  ```

### 桌面快捷方式（文件夹里带了生成脚本）

桌面上的「CF优选-快速模式」「CF优选-全量模式」随时可以用这个脚本重建（换电脑、误删、想改名都用它）：

- **双击 `添加桌面快捷方式.cmd`** —— 最省事，跑完会暂停让你看结果
- 或者用命令（在 `D:\ai\cfip-work` 目录下执行）：

  ```powershell
  # 创建两个桌面快捷方式
  powershell -NoProfile -ExecutionPolicy Bypass -File make-desktop-shortcuts.ps1

  # 删除桌面快捷方式
  powershell -NoProfile -ExecutionPolicy Bypass -File make-desktop-shortcuts.ps1 -Remove

  # 自定义快捷方式名字前缀（默认 CF优选）
  powershell -NoProfile -ExecutionPolicy Bypass -File make-desktop-shortcuts.ps1 -Prefix "优选"
  ```

脚本细节：桌面路径自动探测（兼容 OneDrive 重定向的桌面）、快捷方式的**工作目录锁定为本文件夹**
（保证日志/缓存/备份都落在 `D:\ai\cfip-work\`）、不需要管理员权限，创建前会检查目标文件是否存在。

## 拷给别人用（不需要任何额外步骤）

直接把整个文件夹复制给对方（或压缩成 zip 发过去），**不用改任何路径**：

- 项目里**没有写死本机路径**：配置、缓存、日志、备份全部相对脚本所在目录
- 唯一外部依赖是 **Node.js 18+**；没装时双击 `run-fast.cmd` 会给中文提示 + 下载地址
- 桌面快捷方式脚本会自动探测对方的桌面（兼容 OneDrive 重定向）
- **对方第一次运行如果没填配置，会自动进入演示模式**：只测速、打印一份真实结果，
  几十秒就结束，不会碰他的 DNS —— 先看到效果，再去填配置

⚠️ **发出去之前务必清空你自己的凭据**：把 `user.config.jsonc` 里的 `apiToken`、`zoneId` 清空
（`records` 改成 `example.com` 之类的占位值），或者干脆删掉这个文件（程序会自动走演示模式）。
`logs\`、`backups\`、`cache\`、`state.json` 里可能含有你的域名和 IP 记录，也建议一并删掉再打包。

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

| 文件 | 作用 |
|---|---|
| **`user.config.jsonc`** | ★ **你填写的变量文件**：CF 凭据、域名、阈值等，注释详细；不填就不上传 |
| `cfip.config.json` | 程序内置默认参数（凭据段是占位，永远不会被使用） |
| `cfip-fast.mjs` | 快速早停方案主流程 |
| `cfip-auto.mjs` | 全量方案主流程 |
| `cfip-lib.mjs` | 两者共用的工具（源拉取/解析、探测、CF API、DoH 校验、配置加载、本地带宽探测、旧文件清理） |
| `run-fast.cmd` / `run-full.cmd` | 双击即跑 |
| `run-cfip.cmd` | 命令行通用入口 |
| `make-desktop-shortcuts.ps1` | 在桌面创建/删除一键运行快捷方式（支持 `-Remove`、`-Prefix`） |
| `make-desktop-shortcuts.cmd` | 上面那个脚本的双击入口 |
| `cf-api.mjs` | 手工运维小工具：`node cf-api.mjs list` 列记录 / `set <域名> <ip,ip,...>` 指定记录 |
| `logs/latest.log` | 最近一次运行日志（只保留最近 3 次 + latest） |
| `backups/` | 每次写入前的完整 DNS 记录备份（只保留最近 3 份，可回滚） |
| `cache/` | 订阅缓存、探测历史、各网络的带宽/阈值档案 |
| `state.json` | 最近一次运行结果快照 |

---

## 快速方案的判定逻辑（重点）

目标：**快速模式下要的是「可用」，不是「最好」**——最好交给全量方案。

0. **网络指纹**：`出口 IP 段 + ASN`（例如 `AS36352|23.94`）。
   换 WiFi / 换运营商会变成新指纹 → 自动重新校准阈值；网络换回去时，直接复用之前存的档案。
1. **达标线（IP 可用参考值）**：默认 `targetMbps: 8`。
   依据：实测多数 CF 节点落在 5-13Mbps，8Mbps 足够流畅 1080p；调高会更挑、但重新优选频率也上升。
   也可以设 `targetMbps: 0` 切到自动模式：`本地带宽 × targetRatio`（封顶 `targetMaxMbps`），
   结果按网络指纹存进 `cache/bandwidth.json` 档案，**下次同网络直接复用**，`targetTtlDays`（默认 30 天）后重新校准。
2. **现状体检（最省事的一步）**：直接解析 DNS 里正在用的 IP，每个测 `healthRounds`（默认 2）次取最好值
   （单次测量噪声极大：同一个 IP 有时 0Mbps、有时 300Mbps，必须多测）。
   **只要有 `uploadCount`（3）个仍达标 → 立即收工，完全不重新优选**，实测这种情形全程 **7 秒**。
3. **不达标才重新优选**：候选按「在用 IP → 历史活节点 → 订阅标注速度」排序，**串行**逐个测，
   凑够 `targetCount`（10）个达标节点、且至少测满 `minProbe`（60）个就停。
4. **优中选优**：入围节点复核 `verifyRounds`（2）轮取中位数，最终取最快 `uploadCount`（3）个写入 Cloudflare。
5. **质量保护**：本次最佳 < 上次运行最佳 × `guardRatio`（默认 0.5）时跳过写入，网络变差时不让它越换越差。

## 定时巡检（DSH 自动化任务）

已注册 DSH 定时任务，**每晚 19:00-23:00 每小时**跑一次（大陆 CF 使用高峰期，cron `0 19-23 * * *`，Asia/Shanghai）：

- 任务 ID：`schedule-bccb34a0-69ad-460a-ba12-117279bf5b1e`
- 名称：CF优选IP高峰期巡检
- 多数情况下走「现状体检」分支，几秒结束；不达标才做完整优选（2-5 分钟）

> 注意：改这个任务请**删除后重建**，不要用 `schedule_update`——实测它会把 cron 表达式写坏成"每周某天"。
> 该任务依赖 DSH 在运行；DSH 关闭期间不会触发。

## 全量方案流程

1. 多源订阅合并去重（约 1100 个节点）
2. TCP 门控（并发，很便宜）→ HTTP 粗筛（并发小样本，把已失效的节点筛掉）
3. 存活节点**串行**跑 `rounds`（默认 3）轮完整下载，取中位数排名
4. 按记录的 `filter`（如 `fandai` 排除 JP）取前 `topN` 个写入 Cloudflare

## 订阅源

`source.urls` 里按顺序合并（`merge: true`）以下 4 路：

```
raw.githubusercontent.com/HandsomeMJZ/cfip/.../full_ips.txt   ← 主源
cf.junzhen.qzz.io/full_ips.txt                                ← 上游 README 推荐的 R2 线路
cf.junzhen.qzz.io/full_ips_bj.txt                             ← 北京电信线路
cdn.jsdelivr.net/gh/HandsomeMJZ/cfip@main/full_ips.txt        ← jsDelivr 镜像
```

> ⚠️ 实测这些上游数据本身较旧（GitHub 主源最后提交 2026-09-07），标称高速的节点大面积失效。
> 所以两种方案都**不信任标称值**，一律本地重测；每轮还会查 GitHub commit 时间，超过 6 小时打印过期告警。
> 线上全部拉不到时回退 `cache/full_ips.txt`，再不行才用本地快照。

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
| `fast.probeConcurrency` | 1 | **必须保持 1**：并发测速会互抢带宽，实测能把 77Mbps 压成 8Mbps |
| `fast.maxProbe` / `maxSeconds` | 80 / 300 | 单轮最多测几个 / 探测阶段时间上限 |
| `fast.qualityGuard` / `guardRatio` | true / 0.5 | 质量保护开关与阈值 |
| `fast.localBandwidthMbps` | 0 | 0=自动测本地带宽；也可直接填死（如 100） |
| `probe.candidates` | 150 | 全量方案进入粗筛的节点数 |
| `probe.rounds` | 3 | 全量方案正式测速轮数 |

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
