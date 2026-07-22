# disk-space-analyzer — one-line installer
# Usage:  irm https://raw.githubusercontent.com/MatanCH2020/disk-space-analyzer/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$repo = 'MatanCH2020/disk-space-analyzer'
$headers = @{ 'User-Agent' = 'disk-space-analyzer-installer' }

Write-Host ''
Write-Host '  disk-space-analyzer  ' -ForegroundColor Cyan
Write-Host 'Fetching latest release...' -ForegroundColor Gray

try {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
} catch {
  Write-Host "Could not reach GitHub releases. $_" -ForegroundColor Red
  return
}

$asset = $release.assets | Where-Object { $_.name -like '*Setup*.exe' } | Select-Object -First 1
if (-not $asset) {
  Write-Host 'No Setup installer found in the latest release yet.' -ForegroundColor Red
  return
}

$dest = Join-Path $env:TEMP $asset.name
$sizeMB = [math]::Round($asset.size / 1MB, 1)
Write-Host "Downloading $($asset.name) ($sizeMB MB)..." -ForegroundColor Gray
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -Headers $headers

Write-Host 'Launching installer...' -ForegroundColor Green
Start-Process -FilePath $dest
Write-Host 'Done. Follow the installer window to finish.' -ForegroundColor Green
Write-Host '(If Windows SmartScreen warns: More info -> Run anyway)' -ForegroundColor DarkGray
