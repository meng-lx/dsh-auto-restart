<#
.SYNOPSIS
    启动 DSH，并等待它真正可用。

.DESCRIPTION
    支持两种载体，用 -Mode 选择：

      desktop  Electron 桌面端。就绪判据 = 主窗口出现；可开 -DebugPort 供 say.js 用 CDP 注入。
      web      `dsh --profile web` 浏览器端。就绪判据 = HTTP 端口有响应；没有 CDP，
               不做注入，重启后的唤醒交给插件（Host 直投）。

    已经在运行时不会重复启动，只会尝试把窗口带到前台（仅 desktop）。

.PARAMETER Mode
    desktop（默认）或 web。

.PARAMETER PlanPath
    启动计划文件的路径（由宿主插件写）。给了它就以计划为准：mode / exe / 参数 /
    工作目录 / 端口 / 环境变量全部来自计划，-Mode、-ExePath、-DshCmdPath、
    -WebPort 只对不传计划的旧调用方还起作用。

.PARAMETER TimeoutSec
    等待就绪的上限秒数，默认 120。

.PARAMETER NoActivate
    即使 DSH 已在运行，也不尝试把窗口带到前台（仅 desktop）。

.PARAMETER AutoSay
    启动成功后自动在输入框输入这句话并发出去；留空则不发。
    只有 desktop 模式支持（走 CDP）。web 模式会忽略它 —— 那边由插件直投。

.PARAMETER AutoSayDelaySec
    输入前的等待秒数（等前端把界面渲染完），默认 12。

.PARAMETER DebugPort
    以调试端口启动（Chrome DevTools Protocol），供 say.js 做定向注入。
    0 表示不开；不开时自动发送回退到模拟点击。仅 desktop 模式。

.PARAMETER WebPort
    web 模式的监听端口，默认 3080（DSH 网页端组合里的默认值）。
    固定端口是网页端"重启后原地自愈"的前提：cookie 和页面地址都绑在 host:port 上。

.PARAMETER WebHost
    web 模式的绑定地址，默认 127.0.0.1。

.PARAMETER OpenBrowser
    web 模式启动后打开系统默认浏览器。默认不打开 ——
    重启场景下页面已经开着，再弹一个标签页只是噪音。

.PARAMETER ExePath
    DSH 可执行文件。默认 %LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe。

.PARAMETER DshCmdPath
    dsh 命令行入口。默认由 -ExePath 推导：<安装目录>\resources\runtime\cli\bin\dsh.cmd。

.PARAMETER LogPath
    日志文件路径。不传则写到脚本目录下的 logs\start-<时间>.log。

.EXAMPLE
    .\Start-DSH.ps1

.EXAMPLE
    .\Start-DSH.ps1 -Mode web

.EXAMPLE
    .\Start-DSH.ps1 -Mode web -WebPort 3080 -OpenBrowser

.EXAMPLE
    .\Start-DSH.ps1 -TimeoutSec 60 -DebugPort 9222 -AutoSay "已重启"
#>
[CmdletBinding()]
param(
    [ValidateSet('desktop', 'web')]
    [string]$Mode = 'desktop',
    [int]$TimeoutSec = 120,
    [switch]$NoActivate,
    [string]$AutoSay,
    [int]$AutoSayDelaySec = 12,
    [int]$DebugPort = 0,
    [int]$WebPort = 3080,
    [string]$WebHost = '127.0.0.1',
    [switch]$OpenBrowser,
    [string]$ExePath,
    [string]$DshCmdPath,
    # 启动计划：宿主插件用它把「自己是怎么跑起来的」交给脚本，见 lib/launch-plan.js。
    [string]$PlanPath,
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'

# ---------- 启动计划 ----------
# 计划里全是宿主自述的真实值（execPath、argv、cwd、端口），所以有它就不要再猜。
# 下面的默认值（%LOCALAPPDATA%\Programs\DeepSeek Harness\...）只对官方桌面端的
# 默认安装位置成立；npm/pnpm 装出来的 DSH 在那个位置什么都没有。
$plan = $null
if (-not [string]::IsNullOrWhiteSpace($PlanPath)) {
    if (-not (Test-Path -LiteralPath $PlanPath)) {
        throw ('找不到启动计划：' + $PlanPath)
    }
    try {
        $plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw ('启动计划不是合法 JSON：{0}（{1}）' -f $PlanPath, $_.Exception.Message)
    }
}

$ProcName = 'DeepSeek Harness'

if (-not $plan) {
    if (-not $ExePath) {
        $ExePath = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
    }
    if (-not $DshCmdPath) {
        $DshCmdPath = Join-Path (Split-Path -Path $ExePath -Parent) 'resources\runtime\cli\bin\dsh.cmd'
    }
}

if (-not $LogPath) {
    $logDir = Join-Path $PSScriptRoot 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    $LogPath = Join-Path $logDir ('start-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
}

function Write-Log {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

# ---------- 把计划变成启动参数 ----------
#
# 为什么不用 Start-Process -ArgumentList：那个参数是按空格拼字符串的，遇到带空格的
# 路径要么自己加引号（然后被双重转义）、要么被重新分词。这里用 ProcessStartInfo
# 配一段标准的 Windows 参数转义，语义与 node 的 spawn 对齐。
function ConvertTo-QuotedArgument {
    param([string]$Value)
    if ($null -eq $Value -or $Value -eq '') { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $backslashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $backslashes++; continue }
        if ($ch -eq '"') {
            [void]$sb.Append(('\' * ($backslashes * 2 + 1)) + '"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { [void]$sb.Append('\' * $backslashes); $backslashes = 0 }
        [void]$sb.Append($ch)
    }
    if ($backslashes -gt 0) { [void]$sb.Append('\' * ($backslashes * 2)) }
    [void]$sb.Append('"')
    return $sb.ToString()
}

# 照计划拉起进程。$ExtraArgs 追加在计划参数之后（桌面端用它加 --remote-debugging-port）。
function Start-FromPlan {
    param([string[]]$ExtraArgs = @())

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    if ([string]$plan.mode -eq 'custom') {
        # 自定义命令：交给 cmd 解释 —— 用户填的就是一行能在 cmd 里跑的命令。
        $psi.FileName = 'cmd.exe'
        $psi.Arguments = '/d /s /c "' + [string]$plan.command + '"'
        Write-Log ('启动（自定义命令）：{0}' -f $plan.command)
    } else {
        if (-not (Test-Path -LiteralPath ([string]$plan.exe))) {
            throw ('启动计划里的程序不存在：' + [string]$plan.exe)
        }
        $argvList = New-Object System.Collections.Generic.List[string]
        foreach ($a in @($plan.args)) {
            if ($null -ne $a) { $argvList.Add([string]$a) }
        }
        foreach ($a in @($ExtraArgs)) {
            if ($null -ne $a -and "$a" -ne '') { $argvList.Add([string]$a) }
        }
        $psi.FileName = [string]$plan.exe
        $psi.Arguments = (($argvList | ForEach-Object { ConvertTo-QuotedArgument $_ }) -join ' ')
        Write-Log ('启动（重放）：{0} {1}' -f $psi.FileName, $psi.Arguments)
    }

    $cwd = [string]$plan.cwd
    if (-not [string]::IsNullOrWhiteSpace($cwd) -and (Test-Path -LiteralPath $cwd)) {
        $psi.WorkingDirectory = $cwd
        Write-Log ('工作目录：{0}' -f $cwd)
    }

    # env：值为 null 表示「从子进程环境里删掉这个变量」。
    # 桌面端必须删掉 ELECTRON_RUN_AS_NODE，否则拉起来的是个 node，没有界面。
    if ($null -ne $plan.env) {
        foreach ($p in $plan.env.PSObject.Properties) {
            if ($null -eq $p.Value) {
                [void]$psi.EnvironmentVariables.Remove($p.Name)
                Write-Log ('环境：移除 {0}' -f $p.Name)
            } else {
                $psi.EnvironmentVariables[$p.Name] = [string]$p.Value
                Write-Log ('环境：{0}={1}' -f $p.Name, $p.Value)
            }
        }
    }

    return [System.Diagnostics.Process]::Start($psi)
}

if ($plan) {
    Write-Log ('读取启动计划：{0}' -f $PlanPath)
    Write-Log ('  mode={0} profile={1} 端口={2} 版本={3}' -f $plan.mode, $plan.profile, $plan.port, $plan.dshVersion)
    switch ([string]$plan.mode) {
        'web' {
            $Mode = 'web'
            if ([int]$plan.port -gt 0) { $WebPort = [int]$plan.port }
            if (-not [string]::IsNullOrWhiteSpace([string]$plan.host)) { $WebHost = [string]$plan.host }
        }
        'desktop' {
            $Mode = 'desktop'
            if (-not [string]::IsNullOrWhiteSpace([string]$plan.exe)) {
                # 外壳 exe 不一定叫 'DeepSeek Harness'（第三方壳、换名安装），
                # 就绪判据和杀进程都按真实 exe 名来。
                $ProcName = [System.IO.Path]::GetFileNameWithoutExtension([string]$plan.exe)
            }
        }
        'custom' {
            # 自定义命令拉起来的是什么，脚本不知道：有端口就按网页端等端口，没有就按桌面端等窗口。
            if ([int]$plan.port -gt 0) { $Mode = 'web'; $WebPort = [int]$plan.port } else { $Mode = 'desktop' }
        }
        default { throw ('启动计划里的 mode 不认识：' + [string]$plan.mode) }
    }
    Write-Log ('  载体：{0}（进程名={1}，端口={2}）' -f $Mode, $ProcName, $WebPort)
}

# 网页端启动后把 PID 记下来：重启脚本要靠它精确杀掉"那一份"，
# 而不是把同名的桌面端一起带走。
function Write-ServerState {
    param([int]$ProcessId, [int]$Port)
    $dir = Join-Path ([string]$env:USERPROFILE) '.dsh\dsh-auto-restart'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $payload = [ordered]@{
        mode      = 'web'
        pid       = $ProcessId
        host      = $WebHost
        port      = $Port
        startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Join-Path $dir 'server.json'), ($payload | ConvertTo-Json), $enc)
}

# 服务在不在：401/302 也算"在"——TCP 连得上才有 Response。
# 未登录时 GET / 返回 401，这是正常的，不是没起来。
function Test-WebReachable {
    $url = 'http://{0}:{1}/' -f $WebHost, $WebPort
    try {
        $null = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        return $true
    } catch {
        if ($null -ne $_.Exception.Response) { return $true }
        return $false
    }
}

# ---------- web 模式 ----------
if ($Mode -eq 'web') {
    Write-Log '模式：web（dsh --profile web）'
    if ($DebugPort -gt 0) {
        Write-Log '提醒：web 模式没有 CDP，-DebugPort 忽略'
    }
    if ($AutoSay) {
        Write-Log '提醒：web 模式不做键盘注入，-AutoSay 忽略（唤醒由插件直投）'
    }

    if (Test-WebReachable) {
        Write-Log ('端口 {0} 已经有服务在响应' -f $WebPort)
        Write-Log '结果：already-running'
        return 'already-running'
    }

    if ($plan) {
        # 计划里的参数已经是当初启动这台的完整 argv（profile/host/port 都在里面），
        # 原样重放，不重新拼一份 —— 重新拼就等于把「它当时怎么跑的」改成「我们以为它该怎么跑」。
        $proc = Start-FromPlan
    } else {
        if (-not (Test-Path -LiteralPath $DshCmdPath)) {
            Write-Log ('找不到命令行入口：{0}' -f $DshCmdPath)
            throw ('找不到 dsh 命令行入口：' + $DshCmdPath)
        }

        $argList = @('--profile', 'web', '--host', $WebHost, '--port', [string]$WebPort)
        if (-not $OpenBrowser) { $argList += '--no-open' }

        Write-Log ('启动：{0} {1}' -f $DshCmdPath, ($argList -join ' '))
        $proc = Start-Process -FilePath $DshCmdPath `
            -ArgumentList $argList `
            -WorkingDirectory (Split-Path -Path $DshCmdPath -Parent) `
            -WindowStyle Hidden -PassThru
    }
    Write-Log ('已拉起 PID {0}' -f $proc.Id)
    Write-ServerState -ProcessId $proc.Id -Port $WebPort

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 600
        if (Test-WebReachable) {
            Write-Log ('网页端已就绪：http://{0}:{1}/' -f $WebHost, $WebPort)
            Write-Log '结果：ready'
            return 'ready'
        }
        if ($proc.HasExited) {
            Write-Log ('进程已退出（退出码 {0}）' -f $proc.ExitCode)
            break
        }
    }

    Write-Log ('等待超时（{0} 秒）' -f $TimeoutSec)
    Write-Log '结果：timeout'
    return 'timeout'
}

# ---------- desktop 模式（原有行为） ----------
Write-Log '模式：desktop（Electron 桌面端）'

function Show-DshWindow {
    $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowHandle -ne 0 } |
         Select-Object -First 1
    if (-not $p) { return }
    try {
        $wsh = New-Object -ComObject WScript.Shell
        [void]$wsh.AppActivate($p.Id)
    } catch {
        # 激活失败不影响主流程
    }
}

function Get-DshMainProcess {
    Get-Process -Name $ProcName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
}

if (-not ('DshWindowNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DshWindowNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
}
'@
}

function Invoke-AutoSay {
    param([string]$Text, [int]$DelaySec)

    $p = Get-DshMainProcess
    if (-not $p) { Write-Log '自动发送：找不到主窗口，跳过'; return $false }

    Write-Log ('自动发送：先等 {0} 秒让界面加载完' -f $DelaySec)
    Start-Sleep -Seconds $DelaySec

    # 优先走 CDP：Input 事件直接投递给页面，不动系统鼠标、不抢窗口焦点
    $sayJs = Join-Path $PSScriptRoot 'say.js'
    $nodeExe = 'C:\Program Files\nodejs\node.exe'
    if ($DebugPort -gt 0 -and (Test-Path -LiteralPath $sayJs) -and (Test-Path -LiteralPath $nodeExe)) {
        Write-Log ('自动发送：通过调试端口 {0} 直接注入（不动鼠标）' -f $DebugPort)
        $cdpOut = & $nodeExe $sayJs $Text $DebugPort 2>&1
        $cdpCode = $LASTEXITCODE
        foreach ($line in @($cdpOut)) { Write-Log ('  say.js | ' + [string]$line) }
        if ($cdpCode -eq 0) {
            Write-Log '自动发送：CDP 注入成功'
            return $true
        }
        Write-Log ('自动发送：CDP 注入没成功（退出码 {0}），回退到模拟点击' -f $cdpCode)
    }

    $p = Get-DshMainProcess
    if (-not $p) { Write-Log '自动发送：等待期间窗口没了，跳过'; return $false }

    $hwnd = [IntPtr]$p.MainWindowHandle
    $rect = New-Object 'DshWindowNative+RECT'
    if (-not [DshWindowNative]::GetWindowRect($hwnd, [ref]$rect)) {
        Write-Log '自动发送：读不到窗口位置，跳过'
        return $false
    }
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    $x = [int]($rect.Left + $w * 0.38)
    $y = [int]($rect.Top + $h * 0.905)

    try {
        $wsh = New-Object -ComObject WScript.Shell
        [void]$wsh.AppActivate($p.Id)
    } catch {
        Write-Log ('自动发送：激活窗口失败（{0}）' -f $_.Exception.Message)
        $wsh = New-Object -ComObject WScript.Shell
    }
    Start-Sleep -Milliseconds 900

    Write-Log ('自动发送：点击输入框 ({0}, {1})，窗口 {2}x{3}' -f $x, $y, $w, $h)
    [void][DshWindowNative]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 150
    [DshWindowNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [DshWindowNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 450

    $oldClip = $null
    try { $oldClip = Get-Clipboard -Raw -ErrorAction Stop } catch { }
    Set-Clipboard -Value $Text
    Start-Sleep -Milliseconds 250
    $wsh.SendKeys('^v')
    Start-Sleep -Milliseconds 700
    Write-Log ('自动发送：已粘贴「{0}」，按回车' -f $Text)
    $wsh.SendKeys('{ENTER}')
    Start-Sleep -Milliseconds 500
    if ($null -ne $oldClip) {
        try { Set-Clipboard -Value $oldClip } catch { }
    }
    Write-Log '自动发送：完成'
    return $true
}

Write-Log '开始检查 DSH 是否在运行'

$running = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Log ('DSH 已在运行：{0} 个进程' -f $running.Count)
    if (-not $NoActivate) { Show-DshWindow }
    Write-Log '结果：already-running'
    return 'already-running'
}

if ($plan) {
    # 桌面端：重放外壳 exe（参数为空，环境里已经去掉了 ELECTRON_RUN_AS_NODE）。
    if ($DebugPort -gt 0 -and $AutoSay) {
        Write-Log ('调试端口：{0}（供 say.js 定向注入）' -f $DebugPort)
        $null = Start-FromPlan -ExtraArgs @(('--remote-debugging-port={0}' -f $DebugPort))
    } else {
        $null = Start-FromPlan
    }
} else {
    if (-not (Test-Path -LiteralPath $ExePath)) {
        Write-Log ('找不到程序：{0}' -f $ExePath)
        throw ('找不到 DSH 主程序：' + $ExePath)
    }

    Write-Log ('启动：{0}' -f $ExePath)
    if ($DebugPort -gt 0 -and $AutoSay) {
        Write-Log ('调试端口：{0}（供 say.js 定向注入）' -f $DebugPort)
        Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path -Path $ExePath -Parent) -ArgumentList ('--remote-debugging-port={0}' -f $DebugPort)
    } else {
        Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path -Path $ExePath -Parent)
    }
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$main = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    $main = Get-DshMainProcess
    if ($main -and $main.MainWindowTitle) { break }
    $main = $null
}

if ($main) {
    Write-Log ('窗口已就绪：{0}' -f $main.MainWindowTitle)
    if ($DebugPort -gt 0 -and $AutoSay) {
        $cdpDeadline = (Get-Date).AddSeconds(60)
        $cdpOk = $false
        while ((Get-Date) -lt $cdpDeadline) {
            try {
                $ver = Invoke-WebRequest -Uri ('http://127.0.0.1:{0}/json/version' -f $DebugPort) -UseBasicParsing -TimeoutSec 2
                if ($ver.StatusCode -eq 200) { $cdpOk = $true; break }
            } catch {
                # 端口还没起来，继续等
            }
            Start-Sleep -Milliseconds 800
        }
        Write-Log ('调试端口已就绪：{0}' -f $cdpOk)
    }
    if ($AutoSay) {
        [void](Invoke-AutoSay -Text $AutoSay -DelaySec $AutoSayDelaySec)
    }
    Write-Log '结果：ready'
    return 'ready'
}

Write-Log ('等待超时（{0} 秒）：进程已启动，但主窗口还没出现' -f $TimeoutSec)
Write-Log '结果：timeout'
return 'timeout'
