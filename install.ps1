<#
.SYNOPSIS
  把 dsh-auto-restart 装进一个或多个 DSH profile。幂等，可重复执行。

.DESCRIPTION
  做三件事，按顺序：
    1. 用官方通道 `dsh plugin --profile <名字> add <插件目录>` 把它挂进 profile 的
       dependencies（本地目录，pnpm 会记成 link:，不拷贝文件、不联网）。
    2. 把包名写进该 profile package.json 的 dsh.profile.bundles —— 只有进了这个列表，
       启动时才会被加载。这一步官方 CLI 不管，必须自己加。
    3. 打印结果供核对。

  全程只动 %USERPROFILE%\.dsh\profiles\<名字>\，不碰插件源码，不启动、不重启任何 DSH。

.PARAMETER Profile
  要装进去的 profile 名：web / desktop / both。默认 web。

.PARAMETER PluginDir
  插件源码目录。默认是本脚本所在目录。

.PARAMETER DshCli
  找不到 dsh.cmd 时手工指定。

.EXAMPLE
  .\install.ps1                 # 装进网页端 profile
  .\install.ps1 -Profile both   # 两端都装
  .\install.ps1 -Profile desktop -PluginDir 'D:\DeepSeek Harness\dsh-auto-restart'
#>
[CmdletBinding()]
param(
  [ValidateSet('web', 'desktop', 'both')]
  [string]$Profile = 'web',
  [string]$PluginDir = $PSScriptRoot,
  [string]$DshCli
)

$ErrorActionPreference = 'Stop'
$PkgName = 'dsh-auto-restart'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok  ($msg) { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }

# ---------- 1. 定位 dsh.cmd ----------
function Find-DshCli {
  if ($DshCli -and (Test-Path -LiteralPath $DshCli)) { return $DshCli }

  $candidates = @()
  foreach ($root in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $root) { continue }
    $candidates += Join-Path $root 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
    $candidates += Join-Path $root 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  }
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  $onPath = Get-Command 'dsh' -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  throw "没找到 dsh.cmd。请用 -DshCli 指定，例如 -DshCli 'C:\...\resources\runtime\cli\bin\dsh.cmd'"
}

# ---------- 2. 依赖已就绪检查 ----------
if (-not (Test-Path -LiteralPath (Join-Path $PluginDir 'package.json'))) {
  throw "PluginDir 里没有 package.json：$PluginDir"
}
$pluginPkg = Get-Content -LiteralPath (Join-Path $PluginDir 'package.json') -Raw | ConvertFrom-Json
if ($pluginPkg.name -ne $PkgName) {
  throw "插件目录的包名是 '$($pluginPkg.name)'，不是 '$PkgName'，可能拷错了目录。"
}
$PluginDir = (Resolve-Path -LiteralPath $PluginDir).Path

$cli = Find-DshCli
Write-Ok "dsh.cmd: $cli"
Write-Ok "插件目录: $PluginDir"

# ---------- 3. 逐个 profile 安装 ----------
$targets = if ($Profile -eq 'both') { @('web', 'desktop') } else { @($Profile) }

foreach ($p in $targets) {
  Write-Step "profile: $p"
  $profDir   = Join-Path $env:USERPROFILE ".dsh\profiles\$p"
  $profPkg   = Join-Path $profDir 'package.json'

  if (-not (Test-Path -LiteralPath $profPkg)) {
    Write-Warn2 "这个 profile 还没初始化过（$profDir 不存在）。"
    Write-Warn2 "先用它启动一次 DSH，让它把 profile 建出来，再回来跑本脚本。"
    Write-Warn2 "  网页端： dsh web --no-open"
    Write-Warn2 "  桌面端： 直接打开 DeepSeek Harness"
    continue
  }

  # 3a. 交给官方 CLI 改 dependencies
  Write-Host "    dsh plugin --profile $p add $PluginDir"
  & $cli plugin --profile $p add $PluginDir 2>&1 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
  if ($LASTEXITCODE -ne 0) {
    Write-Warn2 "pnpm 退出码 $LASTEXITCODE，先看看上面的输出。"
    continue
  }

  # 3b. 把包名写进 bundles（官方 CLI 不管这一步）
  $raw = Get-Content -LiteralPath $profPkg -Raw
  $obj = $raw | ConvertFrom-Json
  if (-not $obj.dsh) { $obj | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
  if (-not $obj.dsh.profile) { $obj.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
  if (-not $obj.dsh.profile.bundles) { $obj.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force }

  $bundles = @($obj.dsh.profile.bundles)
  if ($bundles -contains $PkgName) {
    Write-Ok "bundles 里已经有 $PkgName"
  } else {
    $obj.dsh.profile.bundles = @($bundles + $PkgName)
    $json = $obj | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($profPkg, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "已把 $PkgName 追加到 bundles"
  }

  # 3c. 结果核对
  $check = Get-Content -LiteralPath $profPkg -Raw | ConvertFrom-Json
  $depOk = [bool]($check.dependencies.PSObject.Properties.Name -contains $PkgName)
  $bunOk = @($check.dsh.profile.bundles) -contains $PkgName
  Write-Host "    dependencies : $(if ($depOk) { '有' } else { '缺' })"
  Write-Host "    bundles      : $(if ($bunOk) { '有' } else { '缺' })"
  Write-Host "    bundles 现为 : $($check.dsh.profile.bundles -join ', ')"
}

Write-Step "装完了，接下来"
Write-Host @"
  1. 完全退出该 profile 的 DSH 进程（不是最小化，是退出）：
       桌面端：托盘右键退出，或任务管理器结束 "DeepSeek Harness.exe"
       网页端：taskkill /IM "DeepSeek Harness.exe" /F  —— 注意会把桌面端也带走，
               所以先关桌面端，或先查到占着 3080 端口的那个 PID 再精确杀。
  2. 重新启动它。
  3. 开一个新会话（不要用历史很长的老会话），确认：
       - 工具表里有 restart_dsh
       - 左侧「设置」里有「DSH 自动重启」
       - 浏览器访问 http://127.0.0.1:3080/auto-restart/api/state 能拿到 JSON
  4. 日志在 ~\.dsh\dsh-auto-restart\logs\plugin.log，启动时应该看到两行「已加载」。
"@ -ForegroundColor Gray
