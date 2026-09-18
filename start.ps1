# Claudia - Start Script (PowerShell)
#
# Usage:
#   .\start.ps1            # backend runs no-watch (default; stable, no spurious restarts)
#   .\start.ps1 -Watch     # backend runs tsx watch (auto-reload on backend/src edits)
#   .\start.ps1 -Restart   # kill any existing Claudia server first, then start (true restart)
#
# Without -Restart, the script refuses to start when a server is already running
# (instance lock held and serving, or a port in use) so it never spawns a
# duplicate. Use -Restart to stop the running instance and take over the ports.

param(
    [switch]$Watch,
    [Alias("Force")]
    [switch]$Restart
)

$ErrorActionPreference = "Stop"

# ============================================
# PORT CONFIGURATION - Single source of truth
# ============================================
$BACKEND_PORT = 4001
$FRONTEND_PORT = 5173
$OPENCODE_PORT = 4097
# ============================================

# ============================================
# SINGLE INSTANCE CHECK
# ============================================
# Authoritative mutual exclusion lives in the backend: instance-lock.ts claims
# <dataDir>/instance.json at startup and refuses to boot a second backend
# against the same data directory. This block is only the friendly front door
# for that check -- it tells the user WHERE the running Claudia is instead of
# letting npm spend ten seconds booting a process that immediately exits 1.
#
# This replaces an earlier %TEMP%\claudia-server.lock file (mirrors start.sh's
# fix), which guarded the wrong thing: a live pid alone is ambiguous (a
# tsx-watch process on its way out still has one, and Windows recycles pids
# after a reboot -- the exact bug that motivated this rewrite), so the holder
# must also still be SERVING before we refuse to start.
$InstanceDir = if ($env:CLAUDIA_DATA_DIR) { $env:CLAUDIA_DATA_DIR } else { Join-Path $PSScriptRoot "backend" }
$InstanceFile = Join-Path $InstanceDir "instance.json"

function Get-InstanceHolder {
    if (-not (Test-Path $InstanceFile)) { return $null }
    try {
        $info = Get-Content $InstanceFile -Raw | ConvertFrom-Json
        if (-not $info.pid -or -not $info.port) { return $null }
        return $info
    } catch {
        return $null
    }
}

function Test-HolderServing($info) {
    if (-not $info) { return $false }
    if (-not (Get-Process -Id $info.pid -ErrorAction SilentlyContinue)) { return $false }
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$($info.port)/api/server-info" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

$holder = Get-InstanceHolder
$holderServing = Test-HolderServing $holder

if ($holder -and -not $holderServing) {
    Write-Host "Ignoring stale instance lock from PID $($holder.pid) (not serving)."
} elseif ($holderServing -and -not $Restart) {
    Write-Host "Claudia is already running (PID: $($holder.pid)) at http://localhost:$($holder.port)"
    Write-Host "   It holds the data directory: $InstanceDir"
    Write-Host "   Attach to it instead of starting a second instance, or stop it first,"
    Write-Host "   or re-run with -Restart to replace it."
    exit 1
}

# -Restart: stop any running Claudia server (by the instance lock's PID and by
# whatever owns the ports) so this invocation can cleanly take over. Without
# this, a running server would make the start below a no-op ("already
# running" / "port in use").
if ($Restart) {
    Write-Host "Restart requested - stopping any running Claudia server..."

    # Helper: kill a process tree by PID, tolerating an already-dead PID.
    # Uses Stop-Process (honors -ErrorAction) instead of external taskkill, whose
    # stderr on a missing PID would be escalated to a fatal error by
    # $ErrorActionPreference = "Stop" and abort the whole script.
    function Stop-ProcTree([int]$procId) {
        if (-not $procId) { return }
        # Kill children first (best-effort), then the parent.
        try {
            Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" -ErrorAction SilentlyContinue |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        } catch { }
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }

    # 1) Stop the process recorded in the instance lock
    if ($holder) { Stop-ProcTree ([int]$holder.pid) }

    # 2) Stop whatever currently owns the ports (covers servers started without the lock)
    foreach ($port in @($BACKEND_PORT, $FRONTEND_PORT, $OPENCODE_PORT)) {
        $owners = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -ne 0 } |
            Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($owningPid in $owners) { Stop-ProcTree ([int]$owningPid) }
    }

    Start-Sleep -Seconds 2
    Write-Host "Existing server stopped."
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
    Write-Host "Please free the ports above and try again, or re-run with -Restart to stop the existing server automatically."
    Write-Host "You can kill a process on a port with: Stop-Process -Id (Get-NetTCPConnection -LocalPort <port>).OwningProcess -Force"
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
    Write-Host "Stopped."
}
