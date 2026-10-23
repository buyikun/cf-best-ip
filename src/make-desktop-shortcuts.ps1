<#
  CF 优选 IP —— 在桌面创建 / 删除一键运行快捷方式

  用法（在本文件夹打开 PowerShell，或在任意位置用完整路径）：
    # 创建两个桌面快捷方式
    powershell -NoProfile -ExecutionPolicy Bypass -File make-desktop-shortcuts.ps1

    # 删除桌面快捷方式
    powershell -NoProfile -ExecutionPolicy Bypass -File make-desktop-shortcuts.ps1 -Remove

    # 自定义快捷方式名字前缀
    powershell -NoProfile -ExecutionPolicy Bypass -File make-desktop-shortcuts.ps1 -Prefix "优选"

  说明：
    · 桌面路径自动探测（支持 OneDrive 重定向的桌面）
    · 快捷方式的工作目录固定为本脚本所在目录，保证日志/缓存/备份都落在正确位置
    · 不需要管理员权限
#>
param(
  [switch]$Remove,
  [string]$Prefix = 'CF优选'
)

$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # 本脚本在 src\，根目录是上一级
$desktop = [Environment]::GetFolderPath('Desktop')

$items = @(
  [pscustomobject]@{
    Name   = "$Prefix-快速模式.lnk"
    Target = (Join-Path $root 'run-fast.cmd')
    Desc   = 'CF优选 IP（快速模式）：先体检现有 IP，达标即收工；不达标才重新优选'
  },
  [pscustomobject]@{
    Name   = "$Prefix-全量模式.lnk"
    Target = (Join-Path $root 'run-full.cmd')
    Desc   = 'CF优选 IP（全量模式）：全量测速，挖出最快的节点'
  }
)

if ($Remove) {
  foreach ($i in $items) {
    $p = Join-Path $desktop $i.Name
    if (Test-Path -LiteralPath $p) {
      Remove-Item -LiteralPath $p -Force
      Write-Host "已删除: $p"
    } else {
      Write-Host "未找到: $p"
    }
  }
  return
}

$ws = New-Object -ComObject WScript.Shell
foreach ($i in $items) {
  if (-not (Test-Path -LiteralPath $i.Target)) {
    Write-Warning "目标不存在，跳过: $($i.Target)"
    continue
  }
  $p = Join-Path $desktop $i.Name
  $sc = $ws.CreateShortcut($p)
  $sc.TargetPath       = $i.Target
  $sc.WorkingDirectory = $root
  $sc.Description      = $i.Desc
  $sc.IconLocation     = 'shell32.dll,13'
  $sc.Save()
  Write-Host "已创建: $p"
}
Write-Host "脚本目录: $root"
Write-Host "桌面目录: $desktop"
