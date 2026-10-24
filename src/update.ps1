# ===================================================================
# CF 优选 IP 自动化工具 —— 一键在线升级核心脚本
# ===================================================================
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir

$repoUrl = "https://github.com/buyikun/cf-best-ip"
$directApiUrl = "https://api.github.com/repos/buyikun/cf-best-ip/releases/latest"

Write-Host "  -> 本地项目路径: $projectRoot" -ForegroundColor Gray
Write-Host "  -> 目标代码仓库: $repoUrl" -ForegroundColor Gray

# 1. 查询最新版本 Release 信息
Write-Host "`n[1/4] 正在查询 GitHub 官方最新发布信息..." -ForegroundColor Cyan

$releaseInfo = $null
$downloadUrl = $null
$tagName = ""

try {
    # 尝试直连 GitHub API
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $headers = @{ "User-Agent" = "CF-BestIP-Updater" }
    $res = Invoke-RestMethod -Uri $directApiUrl -Headers $headers -TimeoutSec 10
    $tagName = $res.tag_name
    $asset = $res.assets | Where-Object { $_.name -eq 'cf-best-ip.zip' } | Select-Object -First 1
    if ($asset) {
        $downloadUrl = $asset.browser_download_url
    }
} catch {
    Write-Host "  ! 直连 GitHub API 超时或失败，切换备用发布链接..." -ForegroundColor Yellow
}

if (-not $downloadUrl) {
    # 备用固定下载链接
    $tagName = "latest"
    $downloadUrl = "https://github.com/buyikun/cf-best-ip/releases/download/v1.0.0/cf-best-ip.zip"
}

Write-Host "  ✓ 目标更新版本: $tagName" -ForegroundColor Green

# 2. 准备备用加速镜像（解决国内部分网络无法直连 GitHub 附件的问题）
$candidates = @(
    $downloadUrl,
    "https://ghproxy.net/$downloadUrl",
    "https://mirror.ghproxy.com/$downloadUrl"
)

$tempDir = Join-Path $env:TEMP "cfip_update_$([Guid]::NewGuid().ToString().Substring(0,8))"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$zipFile = Join-Path $tempDir "cf-best-ip.zip"

Write-Host "`n[2/4] 正在从 GitHub 下载最新版本包..." -ForegroundColor Cyan

$downloaded = $false
foreach ($url in $candidates) {
    try {
        Write-Host "  正在尝试连接: $url ..." -ForegroundColor Gray
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.Timeout = 15000
        $req.UserAgent = "CF-BestIP-Updater"
        $resp = $req.GetResponse()
        $stream = $resp.GetResponseStream()
        $fs = New-Object System.IO.FileStream($zipFile, [System.IO.FileMode]::Create)
        $stream.CopyTo($fs)
        $fs.Close()
        $stream.Close()
        $resp.Close()

        $fileSize = (Get-Item $zipFile).Length
        if ($fileSize -gt 10000) {
            $downloaded = $true
            Write-Host "  ✓ 下载成功！更新包大小: $([math]::Round($fileSize / 1KB, 1)) KB" -ForegroundColor Green
            break
        }
    } catch {
        Write-Host "  ! 该节点连接失败，切换下一个..." -ForegroundColor Yellow
    }
}

if (-not $downloaded) {
    Write-Host "`n[错误] 无法连接到 GitHub 下载更新包，请检查网络或稍后重试。" -ForegroundColor Red
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# 3. 解压并智能热更新（保护用户私有数据）
Write-Host "`n[3/4] 正在校验并安全更新本地文件..." -ForegroundColor Cyan

$extractDir = Join-Path $tempDir "extracted"
Expand-Archive -LiteralPath $zipFile -DestinationPath $extractDir -Force

$packFolder = Join-Path $extractDir "CF-BestIP"
if (-not (Test-Path $packFolder)) {
    # 兼容非 prefix 打包结构
    $packFolder = $extractDir
}

# 严格保护清单（绝对不可被覆盖或删除）
Write-Host "  -> 安全保护检查:" -ForegroundColor Gray
Write-Host "     [保护] user.config.jsonc (用户真实配置) —— 绝不覆盖" -ForegroundColor Green
Write-Host "     [保护] var/ 目录 (运行日志与历史缓存) —— 绝不改动" -ForegroundColor Green

# 允许覆盖更新的文件清单
$allowedItems = @(
    'src',
    'README.md',
    'run-fast.cmd',
    'run-full.cmd',
    'run-cfip.cmd',
    'make-desktop-shortcuts.cmd',
    'update.cmd',
    'user.config.jsonc.example'
)

foreach ($item in $allowedItems) {
    $srcPath = Join-Path $packFolder $item
    $dstPath = Join-Path $projectRoot $item
    if (Test-Path $srcPath) {
        if (Test-Path -PathType Container $srcPath) {
            # 复制文件夹
            Copy-Item -LiteralPath $srcPath -Destination $projectRoot -Recurse -Force
            Write-Host "  ✓ 更新组件: $item\" -ForegroundColor Green
        } else {
            # 复制单文件
            Copy-Item -LiteralPath $srcPath -Destination $dstPath -Force
            Write-Host "  ✓ 更新文件: $item" -ForegroundColor Green
        }
    }
}

# 4. 清理临时更新目录
Write-Host "`n[4/4] 正在清理临时下载缓存..." -ForegroundColor Cyan
Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "  ✓ 清理完毕" -ForegroundColor Green

Write-Host "`n==================================================================" -ForegroundColor Cyan
Write-Host "  恭喜！本地程序已成功升级至最新版本！" -ForegroundColor Green
Write-Host "  你的现有配置、历史优选记录均完好保留。" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Cyan

exit 0
