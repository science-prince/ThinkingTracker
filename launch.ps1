param(
    [ValidateSet('Attach','ReadOnly','Demo','Stop','Restore')][string]$Mode = 'Attach',
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$taskNode = if ($taskNodeCommand) { $taskNodeCommand.Source } else { 'D:\Program Files\nodejs\node.exe' }
$taskEntry = Join-Path $taskRoot 'src\main.mjs'
$taskRuntimePath = Join-Path $taskRoot 'data\runtime.json'

function Get-ProbeRuntime {
    if (-not (Test-Path -LiteralPath $taskRuntimePath)) { return $null }
    try {
        $taskRuntime = Get-Content -LiteralPath $taskRuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($taskRuntime.product -ne 'reasoning-scope-local' -or $taskRuntime.dashboard_port -lt 1024 -or $taskRuntime.dashboard_port -gt 65535) { return $null }
        $taskStatus = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/status" -f $taskRuntime.dashboard_port) -Headers @{ 'X-Probe-Token'=$taskRuntime.token } -TimeoutSec 2
        if ($taskStatus.instance -ne $taskRuntime.instance) { return $null }
        return @{ Runtime=$taskRuntime; Status=$taskStatus }
    } catch { return $null }
}

try {
    if (-not (Test-Path -LiteralPath $taskNode)) { throw '未找到 Node.js。请安装 Node.js 22 或以上版本，然后重新双击入口。' }
    $taskNodeMajor = [int]((& $taskNode --version).Trim().TrimStart('v').Split('.')[0])
    if ($taskNodeMajor -lt 22) { throw '需要 Node.js 22 或以上版本。' }
    if ($Mode -eq 'Stop' -or $Mode -eq 'Restore') {
        $taskControl = if ($Mode -eq 'Stop') { '--stop' } else { '--restore-only' }
        & $taskNode $taskEntry $taskControl
        if ($LASTEXITCODE -ne 0) { throw '恢复操作没有完成，请查看文档中的故障排查。' }
        if (-not $NoBrowser) {
            Add-Type -AssemblyName System.Windows.Forms
            [System.Windows.Forms.MessageBox]::Show('地址恢复操作已完成。请重新启动 Codex，使原地址生效。正在进行的请求会等待完成后再停止。','思考强度探测') | Out-Null
        }
        exit 0
    }
    $taskExisting = Get-ProbeRuntime
    if ($taskExisting -and $Mode -eq 'Attach' -and $taskExisting.Status.mode -ne 'ready') {
        # A demo/read-only process has no active attachment to restore.
        Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/stop" -f $taskExisting.Runtime.dashboard_port) -Method Post -Headers @{ 'X-Probe-Token'=$taskExisting.Runtime.token } -TimeoutSec 10 | Out-Null
        $taskDeadline = [DateTime]::UtcNow.AddSeconds(15)
        do { Start-Sleep -Milliseconds 300; $taskExisting = Get-ProbeRuntime } while ($taskExisting -and [DateTime]::UtcNow -lt $taskDeadline)
        if ($taskExisting) { throw '现有进程仍在等待请求完成，请稍后再启动。' }
    }
    if ($taskExisting -and $Mode -eq 'Demo' -and $taskExisting.Status.mode -ne 'demo') {
        throw '真实观测面板正在运行。请先双击“停止并恢复.cmd”，再打开隔离的模拟演示。'
    }
    if (-not $taskExisting) {
        $taskData = Join-Path $taskRoot 'data'
        New-Item -ItemType Directory -Path $taskData -Force | Out-Null
        $taskArgument = switch ($Mode) { 'Attach' {'--attach'} 'Demo' {'--demo'} default {'--read-only'} }
        $taskProcess = Start-Process -FilePath $taskNode -ArgumentList @(('"' + $taskEntry + '"'),$taskArgument) -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskData 'service.log') -RedirectStandardError (Join-Path $taskData 'service-error.log')
        $taskDeadline = [DateTime]::UtcNow.AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 250
            $taskExisting = Get-ProbeRuntime
            $taskProcess.Refresh()
        } while (-not $taskExisting -and -not $taskProcess.HasExited -and [DateTime]::UtcNow -lt $taskDeadline)
        if (-not $taskExisting) { throw '后台启动失败或端口被占用。请查看 data\service-error.log；Codex 配置不会在端口绑定失败时被改动。' }
    } elseif ($Mode -eq 'Attach' -and $taskExisting.Status.mode -eq 'ready') {
        try {
            Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/attach" -f $taskExisting.Runtime.dashboard_port) -Method Post -Headers @{ 'X-Probe-Token'=$taskExisting.Runtime.token } -TimeoutSec 15 | Out-Null
        } catch {
            # Still open the concrete diagnostic panel instead of hiding the failure.
            Write-Host '未能接入；面板会显示配置状态。请检查 CCSwitch 的 Codex 代理是否开启。'
        }
    }
    if (-not $NoBrowser) {
        $taskBrowserUrl = "http://127.0.0.1:{0}/#token={1}" -f $taskExisting.Runtime.dashboard_port,$taskExisting.Runtime.token
        Start-Process -FilePath $taskBrowserUrl | Out-Null
    }
    Write-Host '面板已启动。启用后请重新打开 Codex。关闭网页不会停止后台服务，请使用停止并恢复入口。'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
