$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path (Split-Path $PSScriptRoot -Parent) -Parent))
$scriptPath = Join-Path $PSScriptRoot 'cleanup-task.ps1'
$taskName = 'YoutubeAutomation-OwnedDownloads-48h'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.Description -notlike "*$projectRoot*") { throw 'Task name belongs to another workspace; refusing overwrite.' }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$scriptPath`"" -WorkingDirectory $projectRoot
$triggers = @('00:15','06:15','12:15','18:15') | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -Hidden -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description "48h retention for SHA-256 registered Youtube Automation downloads only. Workspace: $projectRoot. Keeps originals, final exports, evidence, active stories and runtimes." -Force | Select-Object TaskName,State
