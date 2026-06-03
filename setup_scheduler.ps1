# JitBit Cockpit: Hourly Task Scheduler Setup
# Run this script to register the hourly refresh job (no administrator privileges required).
# Hours: Every hour, Monday through Friday.

$ScriptPath = Join-Path $PSScriptRoot "refresh_from_api.ps1"
$TaskName   = "JitBit Cockpit Resilient Refresh"

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""

# Trigger: weekly on weekdays at 6 AM, repeat every 1 hour indefinitely
$Trigger = New-ScheduledTaskTrigger -Weekly `
    -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday `
    -At 6:00AM
# PowerShell 5.1: Repetition must be copied from a Once trigger that supports these params
$RepeatSource = New-ScheduledTaskTrigger -Once -At 6:00AM `
    -RepetitionInterval (New-TimeSpan -Hours 1)
$Trigger.Repetition = $RepeatSource.Repetition

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RunOnlyIfNetworkAvailable

# Remove existing task with the same name if present
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task '$TaskName'." -ForegroundColor Yellow
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Refreshes JitBit Cockpit dashboard every hour, Mon-Fri (resilient & battery-aware)." `
    -Force

Write-Host "Scheduled task '$TaskName' registered successfully." -ForegroundColor Green
Write-Host "It will run every hour on weekdays (resilient to sleep, shut downs, and battery power)." -ForegroundColor Cyan
Write-Host "To run it immediately: Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor Gray

