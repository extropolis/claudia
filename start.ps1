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
    # -State Listen only: without it, client sockets (e.g. a browser's stale
    # connection to a dead backend) produce false "port in use" failures —
    # same fix as start.sh's LISTEN-only lsof check.
    $activeConnections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
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

# Start backend and frontend as tracked child processes.
# -Watch selects 'dev' (tsx watch, auto-reload) over the default 'dev:no-watch'.
# no-watch is the default because spurious restarts can occur when Claude Code
# tasks edit source files, antivirus scans, or the Windows indexer touch backend/src.
#
# The backend runs in a RELAUNCH LOOP: when it exits with code 75 (RESTART_EXIT_CODE,
# triggered by POST /api/server/restart), we relaunch it. Any other exit code stops
# the loop. This gives a working "restart backend" button without tsx watch.
$backendScript = if ($Watch) { "dev" } else { "dev:no-watch" }
$RESTART_EXIT_CODE = 75
Write-Host "Backend mode: $backendScript$(if ($Watch) { ' (auto-reload enabled)' } else { '' })"

$env:CLAUDIA_BACKEND_PORT = $BACKEND_PORT

# Helper: kill a process and its entire child tree (npm -> node -> tsx -> node).
function Stop-Tree($procId) {
    if (-not $procId) { return }
    try { & taskkill /PID $procId /T /F 2>$null | Out-Null } catch {}
}

# Frontend: single long-lived child process (no relaunch loop needed).
$frontendProc = Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev", "-w", "frontend") `
    -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru

Write-Host "Frontend PID: $($frontendProc.Id)"
Write-Host "Press Ctrl+C to stop..."
Write-Host ""

$backendProc = $null
try {
    while ($true) {
        # Launch backend and wait for it to exit.
        $backendProc = Start-Process -FilePath "npm.cmd" -ArgumentList @("run", $backendScript, "-w", "backend") `
            -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru
        # CRITICAL: cache .Handle BEFORE the process exits, otherwise .ExitCode
        # reads $null after WaitForExit() (.NET only retains the code if the handle
        # was accessed). Without this the relaunch loop never sees exit code 75.
        $null = $backendProc.Handle
        Write-Host "Backend PID: $($backendProc.Id) ($backendScript)"
        $backendProc.WaitForExit()
        $code = $backendProc.ExitCode

        if ($code -eq $RESTART_EXIT_CODE) {
            Write-Host "Backend requested restart (exit $code) -- relaunching..."
            Start-Sleep -Milliseconds 500
            continue
        }

        # Frontend died, or backend exited for another reason -- stop.
        if ($frontendProc.HasExited) {
            Write-Host "Frontend exited -- shutting down."
        } else {
            Write-Host "Backend exited (code $code) -- shutting down."
        }
        break
    }
} finally {
    # Cleanup on exit -- kill full process trees so ports 4001/5173 are freed.
    Write-Host "Shutting down..."
    if ($backendProc)  { Stop-Tree $backendProc.Id }
    if ($frontendProc) { Stop-Tree $frontendProc.Id }
    Remove-Item $LOCK_FILE -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped."
}
