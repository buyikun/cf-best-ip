# CF 优选 IP 自动化工具 — 开发约定

> 这份文件是**给你（开发者）自己看的**，不随 Release 发布。
> 下载使用者请看 README.md 即可，不需要这份文件。

## 目录分工

| 目录 | 用途 | 规则 |
|---|---|---|
| `D:\ai\cfip-work` | **自用版**，跑真实账号配置 | 只做"同步"，不在这里改代码 |
| `D:\ai\cfip-share` | **开发/分享版**，代码唯一改动源 | **所有改动都在这里做** |

## 改动流程

1. **只在 `cfip-share` 里改代码**
2. 改完在 share 里实测（用 `--dry-run`，不碰 Cloudflare）
3. 测完清理 `var\` 和临时脚本（`t-*.mjs` / `test-*.mjs`）
4. **询问是否同步到自用版**（`cfip-work`）—— 需要时再同步
5. **询问是否推送到 GitHub** —— 不要自动推送

> ⚠️ 不要每改一点就立刻 push。积攒到你确认可以发布了，再问一次。

## 同步到自用版

改动的文件拷过去即可。常用命令（在 PowerShell 里执行）：

```powershell
$s = 'D:\ai\cfip-share'
$w = 'D:\ai\cfip-work'

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
- [ ] 敏感信息扫描通过，重点查这六类：

```powershell
$s = 'D:\ai\cfip-share'
$patterns = @{
  '真实域名'     = 'fandai|buyikun|dpdns'
  '本机路径'     = 'D:\\ai|C:\\Users|Administrator'
  '真实凭据'     = 'cfut_[A-Za-z0-9]{25,}|d109dd11629'
  '网络指纹'     = 'AS36352|23\.94|HostPapa'
  '真实IP'       = '193\.181|202\.144|185\.209|91\.192'
  'GitHub令牌'   = 'ghp_[A-Za-z0-9]{30,}'
}
foreach ($k in $patterns.Keys) {
  $h = Select-String -Path "$s\README.md","$s\*.cmd","$s\*.jsonc","$s\src\*" -Pattern $patterns[$k] -ErrorAction SilentlyContinue
  if ($h) { "⚠ [$k] $($h.Count) 处" } else { "✅ [$k] 无" }
}
```

- [ ] 检查过 git 历史（重建后只有 1 个提交，历史里也不该有敏感信息）

## 打包 Release

用 `git archive` 打包，会自动排除 `.gitattributes` / `.gitignore`（它们对使用者无意义）：

```powershell
git archive --format=zip --prefix=CF-BestIP/ -o out.zip HEAD
```

## 当前版本状态

- 仓库：https://github.com/buyikun/cf-best-ip
- 版本：v1.0.0
- 提交历史：重建为单一初始提交（清理过泄露内容）
