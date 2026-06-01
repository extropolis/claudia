# Claudia - Start Script (PowerShell)
#
# Usage:
#   .\start.ps1          # backend runs no-watch (default; stable, no spurious restarts)
#   .\start.ps1 -Watch   # backend runs tsx watch (auto-reload on backend/src edits)

param(
    [switch]$Watch
)

$ErrorActionPreference = "Stop"

# ============================================
# PORT CONFIGURATION - Single source of truth
# ============================================
$BACKEND_PORT = 4001
$FRONTEND_PORT = 5173
$OPENCODE_PORT = 4097
# ============================================

# Lock file to prevent recursive starts
$LOCK_FILE = Join-Path $env:TEMP "claudia-server.lock"

# Check if server is already running (lock file exists and process is alive)
if (Test-Path $LOCK_FILE) {
    $LOCK_PID = Get-Content $LOCK_FILE -ErrorAction SilentlyContinue
    if ($LOCK_PID) {
        $proc = Get-Process -Id $LOCK_PID -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "Claudia is already running (PID: $LOCK_PID)."
            Write-Host "   Stop it first or remove the lock file: Remove-Item $LOCK_FILE"
            exit 1
        }
    }
    Remove-Item $LOCK_FILE -Force -ErrorAction SilentlyContinue
}

# Create lock file with our PID
$PID | Out-File $LOCK_FILE -NoNewline

# Clean up lock file on exit
$null = Register-EngineEvent PowerShell.Exiting -Action {
    $lockFile = Join-Path $env:TEMP "claudia-server.lock"
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}

Write-Host "Checking ports..."
$ports_busy = $false
foreach ($port in @($BACKEND_PORT, $FRONTEND_PORT, $OPENCODE_PORT)) {
    $activeConnections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -ne 0 }
    if ($activeConnections) {
        Write-Host "Port $port is already in use (PID: $($activeConnections[0].OwningProcess))"
        $ports_busy = $true
    }
}

if ($ports_busy) {
    Write-Host ""
    Write-Host "Please free the ports above and try again."
    Write-Host "You can kill a process on a port with: Stop-Process -Id (Get-NetTCPConnection -LocalPort <port>).OwningProcess -Force"
    Remove-Item $LOCK_FILE -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "Ports are free"
Write-Host ""
Write-Host "Starting Claudia..."
Write-Host "   Backend: http://localhost:$BACKEND_PORT"
Write-Host "   Frontend: http://localhost:$FRONTEND_PORT"
Write-Host ""

# Start from project root
Set-Location $PSScriptRoot

# Export CLAUDIA_BACKEND_PORT for the backend to use
$env:CLAUDIA_BACKEND_PORT = $BACKEND_PORT

# Increase Node.js memory limit for backend
$env:NODE_OPTIONS = "--max-old-space-size=8192"

# Start backend and frontend concurrently
# Using npm.cmd to avoid the PowerShell strict mode bug with npm.ps1
# -Watch selects 'dev' (tsx watch, auto-reload) over the default 'dev:no-watch'.
# no-watch is the default because spurious restarts can occur when Claude Code
# tasks edit source files, antivirus scans, or the Windows indexer touch backend/src.
$backendScript = if ($Watch) { "dev" } else { "dev:no-watch" }
Write-Host "Backend mode: $backendScript$(if ($Watch) { ' (auto-reload enabled)' } else { '' })"
$backendJob = Start-Job -ScriptBlock {
    param($dir, $port, $nodeOpts, $script)
    Set-Location $dir
    $env:CLAUDIA_BACKEND_PORT = $port
    $env:NODE_OPTIONS = $nodeOpts
    & npm.cmd run $script -w backend 2>&1
} -ArgumentList $PSScriptRoot, $BACKEND_PORT, $env:NODE_OPTIONS, $backendScript

$frontendJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    & npm.cmd run dev -w frontend 2>&1
} -ArgumentList $PSScriptRoot

Write-Host "Backend job: $($backendJob.Id) | Frontend job: $($frontendJob.Id)"
Write-Host "Press Ctrl+C to stop..."
Write-Host ""

try {
    # Stream output from both jobs
    while ($true) {
        $backendOutput = Receive-Job $backendJob -ErrorAction SilentlyContinue
        $frontendOutput = Receive-Job $frontendJob -ErrorAction SilentlyContinue

        if ($backendOutput) {
            $backendOutput | ForEach-Object { Write-Host "[backend] $_" }
        }
        if ($frontendOutput) {
            $frontendOutput | ForEach-Object { Write-Host "[frontend] $_" }
        }

        # Check if either job has stopped
        if ($backendJob.State -eq "Completed" -or $backendJob.State -eq "Failed") {
            Write-Host "Backend process exited ($($backendJob.State))"
            break
        }
        if ($frontendJob.State -eq "Completed" -or $frontendJob.State -eq "Failed") {
            Write-Host "Frontend process exited ($($frontendJob.State))"
            break
        }

        Start-Sleep -Milliseconds 500
    }
} finally {
    # Cleanup on exit
    Write-Host "Shutting down..."
    Stop-Job $backendJob -ErrorAction SilentlyContinue
    Stop-Job $frontendJob -ErrorAction SilentlyContinue
    Remove-Job $backendJob -Force -ErrorAction SilentlyContinue
    Remove-Job $frontendJob -Force -ErrorAction SilentlyContinue
    Remove-Item $LOCK_FILE -Force -ErrorAction SilentlyContinue
}
