<#
.SYNOPSIS
    关闭 DSH → 执行一条命令 → 重新启动 DSH。

.DESCRIPTION
    用途：需要改动正在被 DSH 占用的文件（例如升级插件、跑 pnpm install）时，
    先把自己从"操作者"的位置上摘出去，做完了再把自己放回来。

    推荐用 -Detach：脚本会把实际工作交给一个 WMI 创建的独立进程，
    然后立刻返回。这样即使 DSH 已经把当前会话关掉，那个独立进程仍然会
    继续跑完命令并重新启动 DSH。

    不传 -Detach 时，脚本在当前进程里依次完成所有步骤；此时如果它本身
    就是 DSH 的子进程，关掉 DSH 会把它一起带走，所以一般只在外部终端用。

.PARAMETER Command
    要在 DSH 关闭后执行的命令（PowerShell 语法）。退出码和输出都会写进日志。

.PARAMETER WorkDir
    执行命令时的工作目录，默认 D:\DeepSeek Harness。

.PARAMETER GraceSec
    关闭 DSH 前先等待的秒数，默认 8 秒（留给当前对话把回复发完）。

.PARAMETER SettleSec
    DSH 退出后再等待的秒数，默认 8 秒（等文件句柄和端口释放干净）。

.PARAMETER NoStart
    只关闭并执行命令，不重新启动 DSH。

.PARAMETER Detach
    交给独立进程执行，本进程立即返回。

.PARAMETER JobFile
    内部使用：Detach 模式下独立进程从这里读参数，不要手填。

.EXAMPLE
    .\Restart-DSH.ps1 -Command "pnpm add dshmarket@1.69.0 --config.minimum-release-age=0" -Detach

.EXAMPLE
    .\Restart-DSH.ps1 -NoStart -Command "dir" -Detach
#>
[CmdletBinding()]
param(
    [string]$Command,
    [string]$WorkDir = 'D:\DeepSeek Harness',
    [int]$GraceSec = 0,
    [int]$SettleSec = 8,
    [switch]$NoStart,
    [switch]$Detach,
    [switch]$DryRun,
    [string]$AutoSay = '已重启',
    [int]$DebugPort = 9222,
    [int]$CommandTimeoutSec = 600,
    [ValidateSet('desktop', 'web', 'auto')]
    [string]$Mode = 'auto',
    [int]$WebPort = 3080,
    # 调用方（宿主插件）自己的进程号。由插件传入，用来精确判定载体、精确关进程。
    # 不传就退回旧的「按窗口 / 按端口」猜法。
    [int]$OwnerPid = 0,
    [string]$JobFile
)

$ErrorActionPreference = 'Stop'

$ProcName   = 'DeepSeek Harness'
$StartScript = Join-Path $PSScriptRoot 'Start-DSH.ps1'

# 载体归一化。判据按可靠性排序：
#   1) -OwnerPid：插件把自己的 pid 传进来。它到底在监听端口还是在管窗口，
#      问它自己最准。桌面端和网页端同时跑时，也只有这条不会判错。
#   2) 没有 OwnerPid 时才退回旧判据：有可见主窗口 = 桌面端，没有 = 网页端。
#      ⚠️ 这个旧判据在双实例并存时会判错（桌面端有窗口 → 判成 desktop →
#      按进程名全杀 → 把网页端内核一起带走），只为兼容不传 OwnerPid 的调用方保留。
if ($Mode -eq 'auto') {
    $resolved = $null
    if ($OwnerPid -gt 0) {
        $owner = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
        if ($owner) {
            if ($owner.ProcessName -eq $ProcName) {
                # 进程名就是桌面端 exe：这条最硬，必须排在所有判据前面。
                # 不能先判监听端口 —— 桌面端宿主进程本身就在监听 WebPort，
                # 先问端口会把桌面端一律认成网页端（2026-10-24 实测踩中）。
                # 也不能靠 MainWindowHandle —— Electron 主进程窗口句柄恒为 0。
                $resolved = 'desktop'
            } else {
                $ownerListening = @(Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue |
                                    Where-Object { $_.OwningProcess -eq $OwnerPid })
                if ($ownerListening.Count -gt 0) {
                    $resolved = 'web'
                } elseif ($owner.MainWindowHandle -ne 0) {
                    $resolved = 'desktop'
                } else {
                    # 既不是桌面端 exe、没有窗口、也不监听端口：网页端内核的常态
                    # （端口常落在子进程/父进程上）
                    $resolved = 'web'
                }
            }
            Write-Host ('[auto] 按 OwnerPid {0} 判定载体：{1}' -f $OwnerPid, $resolved)
        } else {
            Write-Host ('[auto] OwnerPid {0} 已不存在，改用窗口判据' -f $OwnerPid)
        }
    }
    if (-not $resolved) {
        $desktopProcs = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
                          Where-Object { $_.MainWindowHandle -ne 0 })
        $resolved = $(if ($desktopProcs.Count -gt 0) { 'desktop' } else { 'web' })
        Write-Host ('[auto] 按窗口判据判定载体：{0}' -f $resolved)
    }
    $Mode = $resolved
}

# Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM（EF BB BF），
# 而 Node 的 JSON.parse 遇到 BOM 直接抛错。宿主插件读的就是这些文件，
# 所以统一用 .NET 写**无 BOM** 的 UTF-8。
function Write-JsonFile {
    param([string]$Path, $Object)
    $json = ($Object | ConvertTo-Json -Depth 5)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $json, $enc)
}

# ---------- Detach：把活交给一个独立进程 ----------
if (-not $JobFile) {
    if ($DryRun) {
        Write-Host '[DryRun] 只演练，不会关闭进程，也不会执行命令。'
        if ($Mode -eq 'web') {
            $listen = @(Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue)
            $owner = $(if ($listen.Count -gt 0) { [string]$listen[0].OwningProcess } else { '无' })
            Write-Host ('  模式：web，端口 {0}，当前监听 PID：{1}' -f $WebPort, $owner)
        } else {
            $count = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue).Count
            Write-Host ('  模式：desktop，当前 DSH 进程数：{0}' -f $count)
        }
        Write-Host ('  等 {0} 秒后关闭 DSH' -f $GraceSec)
        if ([string]::IsNullOrWhiteSpace($Command)) {
            Write-Host '  之后不执行任何命令（纯重启）'
        } else {
            Write-Host ('  再等 {0} 秒后在工作目录 {1} 执行：{2}' -f $SettleSec, $WorkDir, $Command)
            Write-Host ('  命令超时：{0} 秒（超时就中止，照样启动）' -f $CommandTimeoutSec)
        }
        Write-Host ('  之后重启 DSH：{0}' -f (-not $NoStart))
        if ($Mode -eq 'web') {
            Write-Host ('  重启后由插件直投唤醒（web 模式没有 CDP，-AutoSay「{0}」不参与）' -f $AutoSay)
        } else {
            Write-Host ('  重启后自动发送「{0}」（调试端口 {1}）' -f $AutoSay, $DebugPort)
        }
        return
    }
    if ($Detach) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $taskName = 'DSH-AutoRestart-' + $stamp
        $tmpJson = Join-Path $env:TEMP ('dsh-restart-job-' + $stamp + '.json')
        $job = [pscustomobject]@{
            Command          = $Command
            WorkDir          = $WorkDir
            GraceSec         = $GraceSec
            SettleSec        = $SettleSec
            NoStart          = [bool]$NoStart
            AutoSay          = $AutoSay
            DebugPort        = $DebugPort
            CommandTimeoutSec = $CommandTimeoutSec
            Mode             = $Mode
            WebPort          = $WebPort
            OwnerPid         = $OwnerPid
            Stamp            = $stamp
            TaskName         = $taskName
        }
        Write-JsonFile -Path $tmpJson -Object $job

        # 用计划任务拉起独立进程：WMI 的 Win32_Process.Create 在这里创建出来的进程会立刻退出
        # （实测连第一行日志都写不出来），计划任务则由 Task Scheduler 在用户交互会话里启动，可靠。
        $psExe = (Get-Process -Id $PID).Path
        if (-not $psExe) { $psExe = 'C:\Program Files\PowerShell\7\pwsh.exe' }
        $argument = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -JobFile "{1}"' -f $PSCommandPath, $tmpJson

        try {
            $action    = New-ScheduledTaskAction -Execute $psExe -Argument $argument
            $trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10)
            $principal = New-ScheduledTaskPrincipal -UserId ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive -RunLevel Limited
            $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds ($CommandTimeoutSec + 300))
            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
            Start-ScheduledTask -TaskName $taskName
        } catch {
            try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
            throw ('注册计划任务失败：' + $_.Exception.Message)
        }

        Write-Host ('已注册计划任务「{0}」并在后台启动：' -f $taskName)
        Write-Host ('  {0} 秒后关闭 DSH' -f $GraceSec)
        Write-Host ('  然后执行：{0}' -f $Command)
        Write-Host ('  之后重启 DSH：{0}' -f (-not $NoStart))
        Write-Host '  日志在 dsh-tools\logs\ 下'
        return
    }
}

# ---------- 执行体：从 JobFile 参数装配 ----------
if ($JobFile) {
    if (-not (Test-Path -LiteralPath $JobFile)) { throw ('找不到任务文件：' + $JobFile) }
    $job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $Command   = $job.Command
    $WorkDir   = $job.WorkDir
    $GraceSec  = [int]$job.GraceSec
    $SettleSec = [int]$job.SettleSec
    $NoStart   = [bool]$job.NoStart
    $AutoSay   = $job.AutoSay
    $DebugPort = [int]$job.DebugPort
    if ($null -ne $job.CommandTimeoutSec) { $CommandTimeoutSec = [int]$job.CommandTimeoutSec }
    if ($null -ne $job.Mode) { $Mode = [string]$job.Mode }
    if ($null -ne $job.WebPort) { $WebPort = [int]$job.WebPort }
    if ($null -ne $job.OwnerPid) { $OwnerPid = [int]$job.OwnerPid }
    $stamp     = $job.Stamp
    $taskName  = $job.TaskName
} else {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $taskName = $null
}

$logDir = Join-Path $PSScriptRoot 'logs'
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logPath = Join-Path $logDir ('restart-' + $stamp + '.log')

function Write-Log {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

# ---------- 交接文件：插件写请求，脚本补状态 ----------
#
# 分工：
#   * 插件在拉起脚本**之前**写好「唤醒哪个会话（sessionId）、说什么（text）」——
#     这两个值插件最清楚，没必要经命令行再绕一道；
#   * 脚本只补「这次重启到底成没成」：成功写 ready + 启动时间，失败写 failed。
# 插件只在 phase === 'ready' 时才唤醒，同一个 runId 只唤醒一次。
# 只在现存请求还停在 starting 时补写，避免把已经消费过的旧文件又写成 ready。
$stateDir = Join-Path ([string]$env:USERPROFILE) '.dsh\dsh-auto-restart'
$wakeFile = Join-Path $stateDir 'wake-request.json'

function Read-WakeFile {
    if (-not (Test-Path -LiteralPath $wakeFile)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $wakeFile -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch {
        Write-Log ('交接文件读取失败（忽略）：{0}' -f $_.Exception.Message)
        return $null
    }
}

function Set-WakePhase {
    param([string]$Phase, [string]$Error)
    $current = Read-WakeFile
    if ($null -eq $current) {
        Write-Log '交接文件：没有现存请求，跳过（这次不需要插件唤醒）'
        return
    }
    if ([string]::IsNullOrWhiteSpace([string]$current.sessionId)) {
        Write-Log '交接文件：现存文件里没有 sessionId，跳过'
        return
    }
    if ([string]$current.phase -ne 'starting') {
        Write-Log ('交接文件：现存阶段是 {0}，不是 starting，跳过' -f [string]$current.phase)
        return
    }
    try {
        $payload = [ordered]@{
            runId       = [string]$current.runId
            phase       = $Phase
            sessionId   = [string]$current.sessionId
            text        = [string]$current.text
            requestedAt = $current.requestedAt
            startedAt   = $(if ($Phase -eq 'ready') { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } else { $current.startedAt })
            error       = $Error
        }
        Write-JsonFile -Path $wakeFile -Object $payload
        Write-Log ('交接文件：{0}（runId {1}，会话 {2}）' -f $Phase, $payload.runId, $payload.sessionId)
    } catch {
        Write-Log ('交接文件写入失败（{0}）：{1}' -f $Phase, $_.Exception.Message)
    }
}

Write-Log '=== 重启流程开始 ==='
Write-Log ('执行身份：{0}' -f $env:USERNAME)
if ($Mode -eq 'web') {
    Write-Log ('模式：web（dsh --profile web，端口 {0}）' -f $WebPort)
} else {
    Write-Log '模式：desktop（Electron 桌面端）'
}
if ([string]::IsNullOrWhiteSpace($Command)) {
    Write-Log '命令：（无，纯重启）'
} else {
    Write-Log ('命令：{0}' -f $Command)
    Write-Log ('命令超时：{0} 秒（超时即中止，照样启动 DSH）' -f $CommandTimeoutSec)
}
Write-Log ('工作目录：{0}' -f $WorkDir)
Write-Log ('计划：等 {0} 秒 → 关闭 DSH → 等 {1} 秒 → 执行命令 → 重启={2}' -f $GraceSec, $SettleSec, (-not $NoStart))

# 看一眼插件有没有留下唤醒请求（请求由插件写，这里只报告，不改）
$pendingWake = Read-WakeFile
if ($null -eq $pendingWake) {
    Write-Log '交接文件：插件没有留下唤醒请求（这次只重启，不唤醒）'
} elseif ([string]$pendingWake.phase -eq 'starting') {
    Write-Log ('交接文件：发现请求，目标会话 {0}，唤醒语句「{1}」，启动成功后补状态' -f [string]$pendingWake.sessionId, [string]$pendingWake.text)
} else {
    Write-Log ('交接文件：阶段是 {0}，不是 starting，本次不接管' -f [string]$pendingWake.phase)
}

# 1) 留出时间让当前对话把回复发完
Start-Sleep -Seconds $GraceSec

# 2) 关闭 DSH
#
# 两种载体的"要关谁"完全不同：
#   desktop  electron 主进程 + 一堆子进程，进程名固定，按名字全杀最省事；
#   web      `dsh --profile web` 单独一个宿主，进程名跟桌面端**一样**（同一个 exe，
#            ELECTRON_RUN_AS_NODE 跑 cli.js），按名字杀会把桌面端一起带走。
#            所以 web 模式按"谁占着这个端口"来定位，server.json 里的 pid 作兜底。
if ($Mode -eq 'web') {
    $webPids = New-Object System.Collections.Generic.List[int]
    # 调用方自己就是网页端内核时，直接杀它，最准。
    if ($OwnerPid -gt 0 -and (Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue)) {
        $webPids.Add([int]$OwnerPid)
        Write-Log ('按 OwnerPid {0} 定位网页端进程' -f $OwnerPid)
    }
    try {
        $conns = @(Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue)
        foreach ($c in $conns) {
            if ($c.OwningProcess -gt 0 -and -not $webPids.Contains([int]$c.OwningProcess)) {
                $webPids.Add([int]$c.OwningProcess)
            }
        }
    } catch {
        Write-Log ('查端口占用失败：{0}' -f $_.Exception.Message)
    }
    if ($webPids.Count -eq 0) {
        $serverFile = Join-Path ([string]$env:USERPROFILE) '.dsh\dsh-auto-restart\server.json'
        if (Test-Path -LiteralPath $serverFile) {
            try {
                $rec = Get-Content -LiteralPath $serverFile -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($rec.pid) { $webPids.Add([int]$rec.pid) }
            } catch { }
        }
    }

    if ($webPids.Count -eq 0) {
        Write-Log ('端口 {0} 上没有监听的进程，也没有可用的 server.json' -f $WebPort)
    } else {
        Write-Log ('发现 {0} 个网页端进程，开始关闭' -f $webPids.Count)
        foreach ($targetPid in $webPids) {
            try {
                Write-Log ('  结束 PID {0}（连子进程）' -f $targetPid)
                # /T 连子进程：dsh.cmd 是 cmd.exe 包了一层，只杀宿主会留下空壳
                & taskkill.exe /PID $targetPid /T /F 2>&1 | ForEach-Object { Write-Log ('    ' + [string]$_) }
            } catch {
                Write-Log ('  结束 PID {0} 失败：{1}' -f $targetPid, $_.Exception.Message)
            }
        }
    }

    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $still = @(Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue)
        if ($still.Count -eq 0) { break }
    }
    $still = @(Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue)
    if ($still.Count -gt 0) {
        Write-Log ('警告：端口 {0} 仍被占用（PID {1}），命令可能撞端口' -f $WebPort, $still[0].OwningProcess)
    } else {
        Write-Log '网页端已完全退出'
    }
} else {
    $procs = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue)
    Write-Log ('发现 {0} 个 DSH 进程，开始关闭' -f $procs.Count)
    foreach ($p in $procs) {
        try {
            Write-Log ('  结束 PID {0}（{1} MB）' -f $p.Id, [int]($p.WorkingSet64 / 1MB))
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
        } catch {
            Write-Log ('  结束 PID {0} 失败：{1}' -f $p.Id, $_.Exception.Message)
        }
    }

    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $left = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue)
        if ($left.Count -eq 0) { break }
    }
    $left = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) {
        Write-Log ('警告：仍有 {0} 个进程没退出，命令可能撞文件占用' -f $left.Count)
        foreach ($p in $left) { Write-Log ('  残留 PID {0}' -f $p.Id) }
    } else {
        Write-Log 'DSH 已完全退出'
    }
}

# 3) 等文件句柄释放（只有真要执行命令时才需要，纯重启直接跳过）
if ([string]::IsNullOrWhiteSpace($Command)) {
    Write-Log '没有要执行的命令，跳过等待（纯重启）'
} else {
    Start-Sleep -Seconds $SettleSec
}

# 4) 执行命令（-Command 留空就是纯重启，不执行任何东西）
$cmdExit = $null
$cmdTimedOut = $false
if ([string]::IsNullOrWhiteSpace($Command)) {
    Write-Log '没有命令要执行（-Command 留空），直接进入重启'
} else {
    if (-not (Test-Path -LiteralPath $WorkDir)) {
        Write-Log ('警告：工作目录不存在，改用脚本目录：{0}' -f $PSScriptRoot)
        $WorkDir = $PSScriptRoot
    }
    Write-Log ('执行命令（工作目录 {0}，超时 {1} 秒）' -f $WorkDir, $CommandTimeoutSec)
    $cmdOut = Join-Path $logDir ('cmdout-' + $stamp + '.log')
    $cmdErr = Join-Path $logDir ('cmderr-' + $stamp + '.log')
    try {
        $psExe = [string](Get-Process -Id $PID).Path
        # 命令用 -EncodedCommand 传：Start-Process 的 ArgumentList 是按空格拼字符串的，
        # 直接把带引号/空格的命令塞进去会被重新分词。Base64(UTF-16LE) 没有转义问题。
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
        # 用独立进程跑命令：只有这样才能给等不动的命令设上限并按进程树杀掉。
        $proc = Start-Process -FilePath $psExe `
            -ArgumentList @('-NoProfile', '-EncodedCommand', $encoded) `
            -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $cmdOut -RedirectStandardError $cmdErr

        $finished = $proc.WaitForExit([Math]::Max(1, $CommandTimeoutSec) * 1000)
        if ($finished) {
            $cmdExit = $proc.ExitCode
            Write-Log ('命令退出码：{0}' -f $cmdExit)
        } else {
            $cmdTimedOut = $true
            Write-Log ('命令超时（{0} 秒没结束），中止并继续启动 DSH' -f $CommandTimeoutSec)
            # /T 连子进程一起杀：-Command 里往往还要再起 node/pnpm 之类的进程
            try { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null } catch { }
            try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
        }

        foreach ($f in @($cmdOut, $cmdErr)) {
            if (Test-Path -LiteralPath $f) {
                foreach ($line in @(Get-Content -LiteralPath $f -ErrorAction SilentlyContinue)) {
                    Add-Content -LiteralPath $logPath -Value ('  | ' + [string]$line) -Encoding UTF8
                }
            }
        }
    } catch {
        Write-Log ('命令执行异常：{0}' -f $_.Exception.Message)
    }
}

# 5) 把命令结果落盘，再重新启动
#
# 为什么落盘：插件要在重启后自己把唤醒词投递回原会话（-AutoSay 留空的 plugin 模式），
# 它拿不到这个进程里的结果，只能读文件，才能补上「（命令失败：退出码 N）」这类后缀。
$stateDir = Join-Path ([string]$env:USERPROFILE) '.dsh\dsh-auto-restart'  # 前面已定义，这里重申以免被后续改动影响
try {
    if (-not (Test-Path -LiteralPath $stateDir)) {
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    }
    $runInfo = [ordered]@{
        at       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        exitCode = $cmdExit
        timedOut = $cmdTimedOut
        command  = [string]$Command
        summary  = $(if ($cmdTimedOut) { 'timeout' } elseif ($null -eq $cmdExit) { 'none' } elseif ($cmdExit -eq 0) { 'ok' } else { 'failed' })
    }
    Write-JsonFile -Path (Join-Path $stateDir 'last-run.json') -Object $runInfo
} catch {
    Write-Log ('结果落盘失败：{0}' -f $_.Exception.Message)
}

# 唤醒词后缀：只有真的带了 -AutoSay 才需要拼（plugin 模式下由插件自己拼）
$finalAutoSay = $AutoSay
if (-not [string]::IsNullOrWhiteSpace($AutoSay)) {
    if ($cmdTimedOut) {
        $finalAutoSay = $AutoSay + '（命令超时被中止）'
    } elseif ($null -ne $cmdExit -and $cmdExit -ne 0) {
        $finalAutoSay = $AutoSay + ('（命令失败：退出码 {0}）' -f $cmdExit)
    }
}

# 唤醒交给插件时，启动脚本不再自己往里打字：两边都发会变成两条消息。
# 判据是插件留下的交接文件（phase = starting）—— 它存在就说明这次唤醒由插件完成。
$autoSayForStart = $finalAutoSay
$wakeByHost = ($null -ne $pendingWake) -and ([string]$pendingWake.phase -eq 'starting')
if ($wakeByHost) {
    $autoSayForStart = ''
    Write-Log '唤醒方式：交给插件（启动脚本不再自己发送）'
} elseif (-not [string]::IsNullOrWhiteSpace($finalAutoSay)) {
    Write-Log ('唤醒方式：启动脚本用调试端口注入「{0}」' -f $finalAutoSay)
}

if (-not $NoStart) {
    if (Test-Path -LiteralPath $StartScript) {
        Write-Log '重新启动 DSH'
        try {
            if ($Mode -eq 'web') {
                # web 模式没有 CDP，AutoSay 交回插件（Host 直投）
                $startResult = & $StartScript -Mode 'web' -WebPort $WebPort -TimeoutSec 180
            } else {
                $startResult = & $StartScript -Mode 'desktop' -TimeoutSec 180 -AutoSay $autoSayForStart -DebugPort $DebugPort
            }
            Write-Log ('启动脚本返回：{0}' -f $startResult)
            if ([string]$startResult -eq 'ready') {
                Set-WakePhase -Phase 'ready'
            } else {
                Set-WakePhase -Phase 'failed' -Error ('启动脚本返回：{0}' -f $startResult)
            }
        } catch {
            Write-Log ('启动失败：{0}' -f $_.Exception.Message)
            Set-WakePhase -Phase 'failed' -Error $_.Exception.Message
        }
    } else {
        Write-Log ('找不到启动脚本：{0}' -f $StartScript)
        Set-WakePhase -Phase 'failed' -Error ('找不到启动脚本：{0}' -f $StartScript)
    }
} else {
    Write-Log '按 -NoStart 要求，不重新启动'
    Set-WakePhase -Phase 'failed' -Error '按 -NoStart 要求没有重新启动'
}

if ($taskName) {
    try {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Log ('已清理计划任务：{0}' -f $taskName)
    } catch {
        Write-Log ('清理计划任务失败：{0}' -f $_.Exception.Message)
    }
}

Write-Log '=== 重启流程结束 ==='

if ($cmdTimedOut) {
    $summary = '完成。命令超时被中止，已照常启动 DSH。日志：{0}' -f $logPath
} elseif ($null -eq $cmdExit) {
    $summary = '完成。纯重启（没有执行命令）。日志：{0}' -f $logPath
} else {
    $summary = '完成。命令退出码 {0}，日志：{1}' -f $cmdExit, $logPath
}
Write-Host ''
Write-Host $summary
return $summary
