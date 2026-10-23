# CF 优选 IP 自动化工具 — 开发约定

> 这份文件是给**开发者**看的，下载使用者请看 README.md。

## 目录分工

| 目录 | 用途 | 规则 |
|---|---|---|
| `示例\自用目录` | **自用版**，跑真实账号配置 | 只做"同步"，不在这里改代码 |
| `示例\分享目录` | **开发/分享版**，代码唯一改动源 | **所有改动都在这里做** |

> 实际路径按你的习惯填，两处分别对应"跑真实配置的目录"和"对外分发的目录"。

## 改动流程

1. **只在分享目录里改代码**
2. 改完实测（用 `--dry-run`，不碰 Cloudflare）
3. 测完清理 `var\` 和临时脚本（`t-*.mjs` / `test-*.mjs`）
4. **询问是否同步到自用版** —— 需要时再同步
5. **询问是否推送到 GitHub** —— 不要自动推送

> ⚠️ 不要每改一点就立刻 push。积攒到确认可以发布了，再问一次。

## 同步到自用版

改动的文件拷过去即可（把两个变量换成你的实际路径）：

```powershell
$s = '分享目录的绝对路径'
$w = '自用目录的绝对路径'

# 同步源码（按实际改动的文件选）
foreach ($n in @('cfip.config.json','cfip-lib.mjs','cfip-fast.mjs','cfip-auto.mjs','cf-api.mjs')) {
    Copy-Item "$s\src\$n" "$w\src\$n" -Force
}

# 同步文档与模板
Copy-Item "$s\README.md" "$w\README.md" -Force
Copy-Item "$s\user.config.jsonc.example" "$w\user.config.jsonc.example" -Force

# 不要同步 user.config.jsonc（那是自用版的真实配置）
```

## 推送前检查清单

- [ ] `git status --short` 确认没有测试脚本残留
- [ ] `var\` 已清空（日志/缓存/备份都是运行产物）
- [ ] **敏感信息扫描通过**，重点查这六类（把示例值换成你自己的真实值再扫）

```powershell
$dir = '分享目录的绝对路径'

# 按需替换成你自己的真实值
$patterns = @{
    '真实域名'   = '你的域名关键词'
    '本机路径'   = 'C:\\Users\\你的用户名|某个盘符:\\你的工程目录'
    '真实凭据'   = 'AA[A-Za-z0-9_]{25,}|[0-9a-f]{32}'   # 各类 Token / ZoneID
    '网络指纹'   = 'AS\d+|你的出口IP段'
    '真实IP'     = '你的常用节点IP前缀'
    'GitHub令牌' = 'ghp_[A-Za-z0-9]{30,}'
}

foreach ($k in $patterns.Keys) {
    $h = Select-String -Path "$dir\README.md","$dir\*.cmd","$dir\*.jsonc","$dir\src\*" -Pattern $patterns[$k] -ErrorAction SilentlyContinue
    if ($h) { "⚠ [$k] $($h.Count) 处" } else { "✅ [$k] 无" }
}
```

- [ ] 检查过 git 历史 —— 历史里也不该有敏感信息（`git log --all -p | Select-String ...`）

> 如果历史里已经有泄露，最彻底的办法是重建仓库：
> `rm -rf .git` → `git init` → 提交 → `git push --force`。
> 这会丢失提交历史，但确保干净。

## 打包 Release

用 `git archive` 打包，会自动排除 `.gitattributes` / `.gitignore` / `DEVELOPMENT.md`：

```powershell
git archive --format=zip --prefix=CF-BestIP/ -o out.zip HEAD
```

## 已知的坑

| 问题 | 说明 |
|---|---|
| `.cmd` 必须是 CRLF | 用 LF 会导致 cmd.exe 解析异常，双击闪退。已用 `.gitattributes` 锁定 |
| PowerShell 脚本要 UTF-8 BOM | 否则中文乱码变成乱码语句报错 |
| 并发测速会让结果失真 | 实测 3 并发能把 77Mbps 压成 8Mbps，所以探测并发固定为 1 |
| 单次测速噪声极大 | 同一 IP 可能 0Mbps 也可能 300Mbps，健康检查必须多轮取最好 |
