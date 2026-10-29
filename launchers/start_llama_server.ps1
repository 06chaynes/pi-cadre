# High-Performance llama-server launcher for Windows PowerShell
param (
    [int]$Port = 8080,
    [string]$HostAddress = "127.0.0.1",
    [string]$ModelId = "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M",
    [int]$ParallelSlots = 16,
    [int]$GpuLayers = 99,
    [int]$CtxSize = 32768
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Starting llama-server with LFM3-1.7B-GGUF (PowerShell)" -ForegroundColor Cyan
Write-Host " Host:           $($HostAddress):$($Port)"
Write-Host " Model:          $ModelId"
Write-Host " Parallel Slots: $ParallelSlots"
Write-Host " GPU Offload:    $GpuLayers layers"
Write-Host " Context Window: $CtxSize tokens"
Write-Host "==========================================================" -ForegroundColor Cyan

$serverCmd = Get-Command "llama-server" -ErrorAction SilentlyContinue
if (-not $serverCmd) {
    Write-Host "ERROR: llama-server executable not found in PATH." -ForegroundColor Red
    Write-Host "Run 'python setup_wizard.py' to configure or install llama.cpp."
    Exit 1
}

& llama-server -hf $ModelId --host $HostAddress --port $Port --ctx-size $CtxSize --parallel $ParallelSlots -ngl $GpuLayers --jinja
