# Windows PowerShell Bootstrap for Pi & LFM3 Installer
param (
    [switch]$Unattended,
    [string]$Backend,
    [switch]$DryRun,
    [switch]$NoColor
)

$pythonCmd = Get-Command "python" -ErrorAction SilentlyContinue
if (-not $pythonCmd) {
    Write-Host "ERROR: Python was not found in your PATH." -ForegroundColor Red
    Write-Host "Please install Python 3.9+ from https://python.org or via Microsoft Store."
    Exit 1
}

$scriptPath = Join-Path $PSScriptRoot "setup_wizard.py"
& python $scriptPath $args
