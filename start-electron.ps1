# Claudia Electron - Start Script (PowerShell)
# Builds and launches the Electron desktop app in development mode

$ErrorActionPreference = "Stop"

Write-Host "Starting Claudia Electron App..."
Write-Host ""

# Start from project root
Set-Location $PSScriptRoot

# Load environment variables
$env:AICORE_RESOURCE_GROUP = if ($env:AICORE_RESOURCE_GROUP) { $env:AICORE_RESOURCE_GROUP } else { "default" }

# Increase Node.js memory limit
$env:NODE_OPTIONS = "--max-old-space-size=8192"

# ============================================
# Step 1: Build shared types
# ============================================
Write-Host "Building shared types..."
& npm.cmd run build -w shared
if ($LASTEXITCODE -ne 0) { throw "Failed to build shared types" }

# ============================================
# Step 2: Build backend
# ============================================
Write-Host "Building backend..."
& npm.cmd run build:backend
if ($LASTEXITCODE -ne 0) { throw "Failed to build backend" }

# ============================================
# Step 3: Build Electron (main + preload)
# ============================================
Write-Host "Building Electron..."
& npm.cmd run build:electron
if ($LASTEXITCODE -ne 0) { throw "Failed to build Electron" }

# ============================================
# Step 4: Start frontend dev server in background
# ============================================
Write-Host "Starting frontend dev server..."
$frontendJob = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    & npm.cmd run dev -w frontend 2>&1
} -ArgumentList $PSScriptRoot

# Clean up on exit
$null = Register-EngineEvent PowerShell.Exiting -Action {
    Get-Job | Where-Object { $_.State -eq "Running" } | Stop-Job -PassThru | Remove-Job -Force
}

# Wait for frontend dev server to be ready
Write-Host "Waiting for frontend dev server (http://localhost:5173)..."
$maxRetries = 30
$ready = $false
for ($i = 1; $i -le $maxRetries; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:5173" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) {
            Write-Host "Frontend dev server is ready"
            $ready = $true
            break
        }
    } catch {}

    # Check if frontend job failed
    if ($frontendJob.State -eq "Failed") {
        $output = Receive-Job $frontendJob
        Write-Host "Frontend dev server failed to start:"
        Write-Host $output
        throw "Frontend dev server failed"
    }

    # Stream any frontend output while waiting
    $output = Receive-Job $frontendJob -ErrorAction SilentlyContinue
    if ($output) {
        $output | ForEach-Object { Write-Host "[frontend] $_" }
    }

    Start-Sleep -Seconds 1
}

if (-not $ready) {
    Write-Host "Frontend dev server did not start within $maxRetries seconds"
    Stop-Job $frontendJob -ErrorAction SilentlyContinue
    Remove-Job $frontendJob -Force -ErrorAction SilentlyContinue
    exit 1
}

# ============================================
# Step 5: Launch Electron
# ============================================
Write-Host ""
Write-Host "Launching Claudia Electron..."
Write-Host ""

try {
    $env:NODE_ENV = "development"
    & npx.cmd electron .
} finally {
    # Cleanup
    Write-Host "Shutting down..."
    Stop-Job $frontendJob -ErrorAction SilentlyContinue
    Remove-Job $frontendJob -Force -ErrorAction SilentlyContinue
    # Reset NODE_ENV
    Remove-Item Env:\NODE_ENV -ErrorAction SilentlyContinue
}
