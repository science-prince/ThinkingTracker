$ErrorActionPreference = 'Stop'
$taskNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $taskNodeCommand) { Write-Host '未找到 Node.js。' -ForegroundColor Red; exit 1 }
$taskSettings = Get-Content -LiteralPath (Join-Path $PSScriptRoot '设置.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$taskPython = $taskSettings.python_path
if (-not (Test-Path -LiteralPath $taskPython)) { Write-Host '未找到 Anaconda selfcontrol 环境。' -ForegroundColor Red; exit 1 }
Push-Location $PSScriptRoot
try {
    Write-Host '仅使用本机模拟上游和项目内临时配置，不发送真实模型请求。'
    & $taskNodeCommand.Source --test tests/evidence.test.mjs tests/proxy.test.mjs tests/launcher.test.mjs
    $taskNodeCode = $LASTEXITCODE
    & $taskPython -X utf8 -m unittest discover -s tests -p 'test_config.py' -v
    $taskPythonCode = $LASTEXITCODE
    if ($taskNodeCode -ne 0 -or $taskPythonCode -ne 0) { exit 1 }
    Write-Host '全部安全自检通过。' -ForegroundColor Green
} finally { Pop-Location }
