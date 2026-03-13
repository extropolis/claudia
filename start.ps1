# Claudia - Clean Start Script (PowerShell)
# Kills existing processes and restarts on proper ports

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
            Write-Host "Claudia is already running (PID: $LOCK_PID), killing it first..."
            Stop-Process -Id $LOCK_PID -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
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

Write-Host "Cleaning up existing processes..."

# Kill processes on our ports
foreach ($port in @($BACKEND_PORT, $FRONTEND_PORT, $OPENCODE_PORT)) {
    $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($connections) {
        $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($pid in $pids) {
            if ($pid -ne 0) {
                Write-Host "   Killing process on port ${port}: PID $pid"
                Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# Kill project-specific processes
$processPatterns = @(
    "claudia*backend*tsx",
    "claudia*backend*index.ts",
    "claudia*backend*test-cli",
    "vite*claudia"
)

Get-Process -Name "node" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
        if ($cmdLine) {
            foreach ($pattern in $processPatterns) {
                if ($cmdLine -like "*$pattern*") {
                    Write-Host "   Killing process: $($_.Id) - $cmdLine"
                    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
                    break
                }
            }
        }
    } catch {}
}

# Kill stray Claude Code CLI processes
Write-Host "Killing zombie Claude processes..."
Get-Process -Name "claude" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2

# Verify ports are free
foreach ($port in @($BACKEND_PORT, $FRONTEND_PORT, $OPENCODE_PORT)) {
    $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    if ($connections) {
        Write-Host "Port $port is still in use. Please kill manually:"
        $connections | Format-Table -AutoSize
        exit 1
    }
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
# Use dev (tsx watch) for auto-reload on file changes, matching start.sh behavior
$backendJob = Start-Job -ScriptBlock {
    param($dir, $port, $nodeOpts)
    Set-Location $dir
    $env:CLAUDIA_BACKEND_PORT = $port
    $env:NODE_OPTIONS = $nodeOpts
    & npm.cmd run dev -w backend 2>&1
} -ArgumentList $PSScriptRoot, $BACKEND_PORT, $env:NODE_OPTIONS

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
