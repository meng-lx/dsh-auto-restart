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
    执行命令时的工作目录。默认空 = 用启动计划里的 cwd（宿主当时所在目录），
    计划也没有就落到脚本目录。

.PARAMETER PlanPath
    启动计划文件（宿主插件写的）。脚本照它重启：mode / exe / 参数 / cwd / 端口全来自计划。
    没有可用计划时不关任何进程。见插件包 SETUP.md。

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
    [string]$WorkDir = '',
    [int]$GraceSec = 0,
    [int]$SettleSec = 8,
    # 关窗口之后先等宿主自己退出多久（秒），等不到才强杀。默认 0 = 不等。
    # 0 的理由：DSH 收到 WM_CLOSE 会先做 2 秒退出检查，判定后台有任务就弹确认框、
    # 窗口不关；无人值守时那个框没人点，实测 8 秒空转后照样强杀。
    #   2026-10-26 对照：等 8 秒 → 关闭耗 9 秒；不等 → 1 秒。
    # 想在某台机器上试可以显式传 -HostWaitSec 8。
    [int]$HostWaitSec = 0,
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
    # 启动计划（由宿主插件写）。它描述「怎么再启动一次」，见 lib/launch-plan.js。
    # 没有可用计划就**不关任何进程** —— 猜错安装位置的代价是把 DSH 杀掉再起不来。
    [string]$PlanPath,
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

# ---------- 启动计划 ----------
#
# 计划里全是宿主自述的真实值（execPath、argv、cwd、端口），所以脚本不再猜
# 「dsh 装在哪」、也不再自己拼启动参数。校验照 Node 那边的 validatePlan 来，
# 目的是**在杀进程之前**就判断出这次重启能不能成。
function Read-LaunchPlan {
    if ([string]::IsNullOrWhiteSpace($PlanPath)) { return $null }
    if (-not (Test-Path -LiteralPath $PlanPath)) { return $null }
    try {
        return (Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        return $null
    }
}

# 返回空串 = 可用；否则返回短原因（会写进日志和交接文件）。
function Test-LaunchPlan {
    param($Plan)
    if ($null -eq $Plan) { return 'no-plan' }
    $m = [string]$Plan.mode
    if ($m -eq 'custom') {
        if ([string]::IsNullOrWhiteSpace([string]$Plan.command)) { return 'empty-command' }
        return ''
    }
    if ($m -ne 'web' -and $m -ne 'desktop') { return ('unknown-mode:' + $m) }
    if ([string]::IsNullOrWhiteSpace([string]$Plan.exe)) { return 'no-exe' }
    if (-not (Test-Path -LiteralPath ([string]$Plan.exe))) { return ('exe-missing:' + [string]$Plan.exe) }
    if ($m -eq 'web') {
        $entry = [string](@($Plan.args)[0])
        if ([string]::IsNullOrWhiteSpace($entry)) { return 'entry-missing' }
        if (-not (Test-Path -LiteralPath $entry)) { return ('entry-missing:' + $entry) }
    }
    return ''
}

# ---------- 独立进程：三条路，能走哪条走哪条 ----------
#
# 为什么非要有独立进程：这个脚本是被 DSH 自己拉起来的，关 DSH 用的是
# `taskkill /T /F`（连子进程一起），所以脚本要是还在原来的进程树里，它会在
# 关掉 DSH 的同时把自己也关掉，后面的「重新启动」永远执行不到。
#
# 三条路的差别只在「谁能不死」：
#   task     计划任务（cmdlet）—— Task Scheduler 在用户交互会话里拉起，最接近用户自己双击
#   schtasks 计划任务（命令行）—— 同一个 Task Scheduler，权限要求不同，有的机器只通这一条
#   wmi      Win32_Process.Create —— 父进程是 WmiPrvSE，压根不在 DSH 的进程树里，
#            taskkill /T 带不走它；仍然落在调用者的会话里（窗口能正常出现）
#
# 三条都不通就抛错——在杀进程**之前**抛，宁可这次不重启。
# 用 wscript 包一层再启动：计划任务在交互式会话里直接 Execute powershell.exe
# 会先给子进程分配一个控制台，即使 -WindowStyle Hidden 也要先闪一下黑框。
# wscript.exe 自己不带窗口，由它用 Run(..., 0, False) 起子进程，连控制台都不建。
# 生成的 .vbs 只有一行，落在 TEMP 里，任务结束时由子进程删掉。
function New-HiddenLauncher {
    param(
        [Parameter(Mandatory = $true)][string]$PsExe,
        [Parameter(Mandatory = $true)][string]$Argument,
        [Parameter(Mandatory = $true)][string]$Stamp
    )
    $vbs = Join-Path $env:TEMP ('dsh-restart-launch-' + $Stamp + '.vbs')
    $cmd = '"{0}" {1}' -f $PsExe, $Argument
    $line = 'CreateObject("WScript.Shell").Run "' + ($cmd -replace '"', '""') + '", 0, False'
    Set-Content -LiteralPath $vbs -Value $line -Encoding Unicode
    return $vbs
}

function Start-DetachedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$PsExe,
        [Parameter(Mandatory = $true)][string]$Argument,
        [Parameter(Mandatory = $true)][string]$TaskName,
        [int]$TimeoutSeconds = 900
    )
    $errors = @()

    try {
        $action    = New-ScheduledTaskAction -Execute $PsExe -Argument $Argument
        $trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10)
        $principal = New-ScheduledTaskPrincipal -UserId ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive -RunLevel Limited
        $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds $TimeoutSeconds)
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        return 'task'
    } catch {
        $errors += ('计划任务(cmdlet)：' + $_.Exception.Message)
        try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
    }

    try {
        $tr = '"{0}" {1}' -f $PsExe, $Argument
        & schtasks.exe /Create /TN $TaskName /TR $tr /SC ONCE /ST 23:59 /F 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw ('schtasks /Create 退出码 {0}' -f $LASTEXITCODE) }
        & schtasks.exe /Run /TN $TaskName 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw ('schtasks /Run 退出码 {0}' -f $LASTEXITCODE) }
        return 'schtasks'
    } catch {
        $errors += ('计划任务(schtasks)：' + $_.Exception.Message)
        try { & schtasks.exe /Delete /TN $TaskName /F 2>&1 | Out-Null } catch { }
    }

    try {
        $cmdline = '"{0}" {1}' -f $PsExe, $Argument
        $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline }
        if ($null -eq $created -or $created.ReturnValue -ne 0) {
            $code = $(if ($null -eq $created) { 'null' } else { [string]$created.ReturnValue })
            throw ('Win32_Process.Create 返回 {0}' -f $code)
        }
        return 'wmi'
    } catch {
        $errors += ('WMI：' + $_.Exception.Message)
    }

    throw ('无法创建独立进程（三种方式都不通）：' + ($errors -join '；'))
}

# ---------- Detach：把活交给一个独立进程 ----------
if (-not $JobFile) {
    if ($DryRun) {
        Write-Host '[DryRun] 只演练，不会关闭进程，也不会执行命令。'
        $planD = Read-LaunchPlan
        $planProblemD = Test-LaunchPlan -Plan $planD
        if ($planProblemD -ne '') {
            Write-Host ('  启动计划：不可用（{0}）—— 真跑时会在关进程之前中止' -f $planProblemD)
        } else {
            Write-Host ('  启动计划：{0}（mode={1}，exe={2}）' -f $PlanPath, $planD.mode, $planD.exe)
        }
        if ($Mode -eq 'web') {
            $listen = @(Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue)
            $owner = $(if ($listen.Count -gt 0) { [string]$listen[0].OwningProcess } else { '无' })
            Write-Host ('  模式：web，端口 {0}，当前监听 PID：{1}' -f $WebPort, $owner)
        } else {
            $count = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue).Count
            Write-Host ('  模式：desktop，当前 DSH 进程数：{0}' -f $count)
        }
        Write-Host ('  等 {0} 秒后关闭 DSH' -f $GraceSec)
        if ($HostWaitSec -gt 0) {
            Write-Host ('  关窗口后先等宿主自己退出：最多 {0} 秒（等不到才强杀）' -f $HostWaitSec)
        } else {
            Write-Host '  关窗口后立即强杀（-HostWaitSec 0）'
        }
        if ([string]::IsNullOrWhiteSpace($Command)) {
            Write-Host '  之后不执行任何命令（纯重启）'
        } else {
            Write-Host ('  再等 {0} 秒后在工作目录 {1} 执行：{2}' -f $SettleSec, $(if ([string]::IsNullOrWhiteSpace($WorkDir)) { '（启动计划里的 cwd）' } else { $WorkDir }), $Command)
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
            HostWaitSec      = $HostWaitSec
            NoStart          = [bool]$NoStart
            AutoSay          = $AutoSay
            DebugPort        = $DebugPort
            CommandTimeoutSec = $CommandTimeoutSec
            Mode             = $Mode
            WebPort          = $WebPort
            OwnerPid         = $OwnerPid
            PlanPath         = $PlanPath
            Stamp            = $stamp
            TaskName         = $taskName
        }
        Write-JsonFile -Path $tmpJson -Object $job

        $psExe = (Get-Process -Id $PID).Path
        if (-not $psExe) { $psExe = 'C:\Program Files\PowerShell\7\pwsh.exe' }
        $argument = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -JobFile "{1}"' -f $PSCommandPath, $tmpJson

        # 交给 wscript 起，避免计划任务那一下黑框。
        $vbsPath = New-HiddenLauncher -PsExe $psExe -Argument $argument -Stamp $stamp
        $wscriptExe = Join-Path $env:WINDIR 'System32\wscript.exe'
        if (-not (Test-Path -LiteralPath $wscriptExe)) { $wscriptExe = 'wscript.exe' }

        $detachKind = Start-DetachedProcess -PsExe $wscriptExe -Argument ('//nologo "{0}"' -f $vbsPath) -TaskName $taskName -TimeoutSeconds ($CommandTimeoutSec + 300)

        # 把「走的哪条路」和启动器路径写回任务文件：子进程据此决定要不要清理计划任务。
        # 走到这里子进程刚被创建，还来不及读文件，重写是安全的。
        $job | Add-Member -NotePropertyName DetachKind -NotePropertyValue $detachKind -Force
        $job | Add-Member -NotePropertyName VbsPath -NotePropertyValue $vbsPath -Force
        Write-JsonFile -Path $tmpJson -Object $job

        # 独立进程要能写出自己的第一行日志，才算真的活着（WMI 那条路没有控制台，
        # 出问题的唯一表现就是「什么都没发生」）。
        $childLog = Join-Path (Join-Path $PSScriptRoot 'logs') ('restart-' + $stamp + '.log')
        $waited = 0
        while ($waited -lt 20 -and -not (Test-Path -LiteralPath $childLog)) {
            Start-Sleep -Milliseconds 500
            $waited += 1
        }
        if (-not (Test-Path -LiteralPath $childLog)) {
            Write-Host ('[警告] 独立进程（{0}）10 秒内没有写出日志，可能没起来：{1}' -f $detachKind, $childLog)
            Write-Host '        DSH 没有被关闭。'
            return
        }

        Write-Host ('已用「{0}」拉起独立进程：' -f $detachKind)
        Write-Host ('  {0} 秒后关闭 DSH' -f $GraceSec)
        Write-Host ('  然后执行：{0}' -f $Command)
        Write-Host ('  之后重启 DSH：{0}' -f (-not $NoStart))
        Write-Host ('  日志：{0}' -f $childLog)
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
    if ($null -ne $job.HostWaitSec) { $HostWaitSec = [int]$job.HostWaitSec }
    $NoStart   = [bool]$job.NoStart
    $AutoSay   = $job.AutoSay
    $DebugPort = [int]$job.DebugPort
    if ($null -ne $job.CommandTimeoutSec) { $CommandTimeoutSec = [int]$job.CommandTimeoutSec }
    if ($null -ne $job.Mode) { $Mode = [string]$job.Mode }
    if ($null -ne $job.WebPort) { $WebPort = [int]$job.WebPort }
    if ($null -ne $job.OwnerPid) { $OwnerPid = [int]$job.OwnerPid }
    if ($null -ne $job.PlanPath) { $PlanPath = [string]$job.PlanPath }
    $stamp     = $job.Stamp
    $taskName  = $job.TaskName
    $detachKind = [string]$job.DetachKind
} else {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $taskName = $null
    $detachKind = ''
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
Write-Log ('载体（判据见下）：{0}' -f $Mode)
if ([string]::IsNullOrWhiteSpace($Command)) {
    Write-Log '命令：（无，纯重启）'
} else {
    Write-Log ('命令：{0}' -f $Command)
    Write-Log ('命令超时：{0} 秒（超时即中止，照样启动 DSH）' -f $CommandTimeoutSec)
}
Write-Log ('工作目录：{0}' -f $(if ([string]::IsNullOrWhiteSpace($WorkDir)) { '（启动计划里的 cwd）' } else { $WorkDir }))
Write-Log ('计划：等 {0} 秒 → 关闭 DSH → 等 {1} 秒 → 执行命令 → 重启={2}' -f $GraceSec, $SettleSec, (-not $NoStart))

# ---------- 计划门：动手之前先确认“能再拉起来” ----------
#
# 这一步刻意放在关闭进程**之前**。反过来的失败（先杀、再发现起不来）是这个插件
# 最伤人的形态：服务没了，用户只能自己去开，而他已经不知道当初是怎么开的了。
$plan = Read-LaunchPlan
$planProblem = Test-LaunchPlan -Plan $plan
if (-not $NoStart) {
    if ($planProblem -ne '') {
        Write-Log ('启动计划不可用（{0}），不关闭任何进程' -f $planProblem)
        Set-WakePhase -Phase 'failed' -Error ('启动计划不可用：' + $planProblem)
        throw ('启动计划不可用（{0}）：拒绝在没有可用启动计划的情况下关闭 DSH。见插件包 SETUP.md。' -f $planProblem)
    }
    # 以计划为准：载体、进程名、端口都从计划来，不再用「窗口 / 端口」猜。
    # 猜错载体在两种情况下会连带杀掉别人：桌面端和网页端同时跑的时候。
    switch ([string]$plan.mode) {
        'web' {
            $Mode = 'web'
            if ([int]$plan.port -gt 0) { $WebPort = [int]$plan.port }
        }
        'desktop' {
            $Mode = 'desktop'
            $ProcName = [System.IO.Path]::GetFileNameWithoutExtension([string]$plan.exe)
        }
        default {
            # custom：不知道命令会拉起什么。有端口就按网页端等/杀，没有就按桌面端。
            if ([int]$plan.port -gt 0) { $Mode = 'web'; $WebPort = [int]$plan.port } else { $Mode = 'desktop' }
        }
    }
    Write-Log ('启动计划：{0}（mode={1} 进程名={2} 端口={3}）' -f $PlanPath, $Mode, $ProcName, $WebPort)
    # 命令的工作目录也跟着计划走：计划里的 cwd 就是宿主当时所在的项目目录。
    if ([string]::IsNullOrWhiteSpace($WorkDir) -and -not [string]::IsNullOrWhiteSpace([string]$plan.cwd)) {
        $WorkDir = [string]$plan.cwd
    }
}
if ([string]::IsNullOrWhiteSpace($WorkDir)) { $WorkDir = $PSScriptRoot }

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
        if ($WebPort -gt 0) {
            $conns = @(Get-NetTCPConnection -LocalPort $WebPort -State Listen -ErrorAction SilentlyContinue)
            foreach ($c in $conns) {
                if ($c.OwningProcess -gt 0 -and -not $webPids.Contains([int]$c.OwningProcess)) {
                    $webPids.Add([int]$c.OwningProcess)
                }
            }
        } else {
            Write-Log '计划里没有端口，跳过端口定位（只按 OwnerPid / server.json 定位）'
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

    if ($WebPort -gt 0) {
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
        Write-Log '计划里没有端口，跳过端口释放等待'
    }
} else {
    $procs = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue)
    Write-Log ('发现 {0} 个 DSH 进程，先请求它自己收尾' -f $procs.Count)

    # 只向主进程发关闭请求：不带 /F 的 taskkill 走的是 WM_CLOSE，Electron 会跑
    # before-quit，会话日志才有机会落盘。直接 Stop-Process -Force 是硬切，
    # 正在写的那几行就没了 —— 这也是「任务已停止」那条痕迹的来源之一。
    $mainPid = 0
    foreach ($p in $procs) {
        try {
            $cmdline = (Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $p.Id) -ErrorAction Stop).CommandLine
        } catch { $cmdline = '' }
        if ([string]::IsNullOrWhiteSpace($cmdline) -or $cmdline -notmatch '--type=') { $mainPid = $p.Id; break }
    }

    if ($HostWaitSec -gt 0 -and $mainPid -gt 0) {
        Write-Log ('  请求关闭主进程 PID {0}（优雅，最多等 {1} 秒）' -f $mainPid, $HostWaitSec)
        try { & taskkill.exe /PID $mainPid 2>&1 | ForEach-Object { Write-Log ('    ' + [string]$_) } } catch { }
        $graceDeadline = (Get-Date).AddSeconds($HostWaitSec)
        while ((Get-Date) -lt $graceDeadline) {
            Start-Sleep -Milliseconds 300
            if (@(Get-Process -Name $ProcName -ErrorAction SilentlyContinue).Count -eq 0) { break }
        }
    } elseif ($HostWaitSec -gt 0) {
        Write-Log '  找不到主进程，跳过优雅关闭'
    }

    $left = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) {
        Write-Log 'DSH 已自行退出（会话日志有机会落盘）'
    } else {
        if ($HostWaitSec -gt 0) {
            Write-Log ('优雅关闭没等到，剩 {0} 个进程，改为强制结束（会话日志可能不完整）' -f $left.Count)
        }
        foreach ($p in $left) {
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
        # 输出用 UTF-8（否则中文按控制台代码页变成问号）；progress 流静默（否则 stderr 会冒出 #< CLIXML 块）。
        $wrapped = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; " + $Command
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($wrapped))
        # 用独立进程跑命令：只有这样才能给等不动的命令设上限并按进程树杀掉。
        $proc = Start-Process -FilePath $psExe `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', $encoded) `
            -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $cmdOut -RedirectStandardError $cmdErr

        # PS 5.1 的 -PassThru 对象在带重定向时没有绑定进程句柄，直接读 ExitCode 会拿到空值。
        # 先摸一次 Handle 强制绑定，之后的 WaitForExit/ExitCode 才可靠。
        try { $null = $proc.Handle } catch { }

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
            # 用哈希表 splat：数组 splat 会按位置绑定，'180' 会被塞给 -Mode（它的
            # ValidateSet 只有 desktop/web），实测报「-TimeoutSec 不属于集合」。
            $startArgs = @{ TimeoutSec = 180 }
            if ($plan) {
                # 有计划就把计划交给启动脚本：exe / 参数 / cwd / 端口全在里面，不用再传 -Mode。
                $startArgs['PlanPath'] = $PlanPath
            } elseif ($Mode -eq 'web') {
                # web 模式没有 CDP，AutoSay 交回插件（Host 直投）
                $startArgs['Mode'] = 'web'
                $startArgs['WebPort'] = $WebPort
            } else {
                $startArgs['Mode'] = 'desktop'
            }
            if (-not [string]::IsNullOrWhiteSpace($autoSayForStart)) {
                $startArgs['AutoSay'] = $autoSayForStart
                $startArgs['DebugPort'] = $DebugPort
            }
            $startResult = & $StartScript @startArgs
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

if ($taskName -and $detachKind -ne 'wmi') {
    try {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Log ('已清理计划任务：{0}' -f $taskName)
        if ($job -and $job.VbsPath) {
            try { Remove-Item -LiteralPath $job.VbsPath -Force -ErrorAction SilentlyContinue } catch { }
        }
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
