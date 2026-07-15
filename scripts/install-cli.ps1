# install-cli.ps1 — Install "devlab" as a global CLI command on Windows
# Run from PowerShell (as Administrator if needed):
#   powershell -ExecutionPolicy Bypass -File scripts\install-cli.ps1

$ErrorActionPreference = "Stop"
$AgentDir = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "  DevLab CLI Installer (Windows)" -ForegroundColor Cyan
Write-Host "  ================================" -ForegroundColor Cyan
Write-Host ""

# --- Check Node 20+ ---
try {
    $nodeVersion = (node --version 2>$null).TrimStart('v').Split('.')[0]
    if ([int]$nodeVersion -lt 20) {
        Write-Host "  x Node.js 20+ required. Install from https://nodejs.org" -ForegroundColor Red
        exit 1
    }
    Write-Host "  + Node.js $(node --version)" -ForegroundColor Green
} catch {
    Write-Host "  x Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# --- Install dependencies ---
Write-Host "  -> Installing dependencies..." -ForegroundColor Yellow
Set-Location $AgentDir
npm install --silent

# --- npm link (makes 'devlab' available globally) ---
Write-Host "  -> Linking CLI globally..." -ForegroundColor Yellow
npm link --silent
if ($LASTEXITCODE -ne 0) {
    Write-Host "  x npm link failed. Try running as Administrator." -ForegroundColor Red
    exit 1
}

# --- Verify ---
$devlabPath = (Get-Command devlab -ErrorAction SilentlyContinue)?.Source
if ($devlabPath) {
    Write-Host "  + 'devlab' command installed: $devlabPath" -ForegroundColor Green
} else {
    Write-Host "  x Could not verify installation. Try reopening terminal." -ForegroundColor Yellow
}

# --- Create .env if missing ---
if (-not (Test-Path "$AgentDir\.env")) {
    Copy-Item "$AgentDir\.env.example" "$AgentDir\.env"
    Write-Host "  -> Created .env (edit it to add your API keys)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Done! You can now run:" -ForegroundColor Green
Write-Host ""
Write-Host "     devlab                        # interactive chat (CLI)"
Write-Host "     devlab serve                  # start web server + model API"
Write-Host "     devlab serve --model-server   # also start Ollama"
Write-Host "     devlab ui .                   # open web IDE"
Write-Host "     devlab fix .                  # auto-fix project issues"
Write-Host ""
Write-Host "  First time? Run: devlab setup"
Write-Host ""
