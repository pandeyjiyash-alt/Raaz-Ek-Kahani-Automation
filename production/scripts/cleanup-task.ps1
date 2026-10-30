$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$productionRoot = Join-Path $projectRoot 'production'
Set-Location -LiteralPath $productionRoot
$cacheRoot = Join-Path $productionRoot '.cache'
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
& $nodePath --use-system-ca --import tsx src/pipeline/inventory.ts >> (Join-Path $cacheRoot 'cleanup-task.log') 2>&1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $nodePath --use-system-ca --import tsx src/pipeline/cleanupCli.ts --apply >> (Join-Path $cacheRoot 'cleanup-task.log') 2>&1
exit $LASTEXITCODE
