$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'build-google-scraper.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$compose = Join-Path (Split-Path $PSScriptRoot -Parent) 'docker-compose.google-scraper.yml'
[string]$existingContainer = & docker container ls --all --quiet --filter 'name=^/leads-genx-gmaps-scraper$'
if ($existingContainer.Trim()) {
  & docker container rm --force leads-genx-gmaps-scraper
  if ($LASTEXITCODE -ne 0) { throw 'Unable to replace the existing local scraper container.' }
}

& docker compose -f $compose up -d --force-recreate
if ($LASTEXITCODE -ne 0) { throw 'Unable to start the local Google Maps scraper.' }

$deadline = (Get-Date).AddSeconds(90)
$healthy = $false
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/api/v1/jobs' -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) {
      $healthy = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 2
  }
}

if (-not $healthy) {
  & docker compose -f $compose logs --tail 100 google-maps-scraper
  throw 'Local Google Maps scraper did not become healthy within 90 seconds.'
}

Write-Host 'Local Google Maps scraper is healthy at http://127.0.0.1:8080' -ForegroundColor Green
