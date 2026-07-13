@echo off
setlocal
cd /d "%~dp0"

set "DOCKER=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
set "DOCKER_API_VERSION=1.51"

if not exist "%DOCKER%" (
  echo Docker CLI was not found at:
  echo %DOCKER%
  echo.
  echo Open Docker Desktop first, or reinstall Docker Desktop.
  pause
  exit /b 1
)

echo Cleaning any old scraper container...
"%DOCKER%" rm -f leads-genx-gmaps-scraper >nul 2>nul

echo Pulling Google Maps scraper image...
"%DOCKER%" pull gosom/google-maps-scraper
if errorlevel 1 (
  echo.
  echo Docker could not pull gosom/google-maps-scraper.
  echo Make sure Docker Desktop is fully started. If Docker asks you to sign in, complete that first.
  pause
  exit /b 1
)

echo Starting Leads-GenX local Google Maps scraper...
"%DOCKER%" compose -f docker-compose.google-scraper.yml up -d
if errorlevel 1 (
  echo.
  echo Docker could not start the scraper container.
  echo Make sure Docker Desktop is open and fully started, then run this file again.
  pause
  exit /b 1
)

echo.
echo Waiting for scraper API on http://localhost:8080 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ok=$false; for($i=0;$i -lt 30;$i++){ try { $r=Invoke-WebRequest -Uri 'http://localhost:8080/api/v1/jobs' -UseBasicParsing -TimeoutSec 3; if($r.StatusCode -eq 200){ $ok=$true; break } } catch { Start-Sleep -Seconds 2 } }; if($ok){ Write-Host 'SUCCESS: scraper-kit is running on http://localhost:8080' -ForegroundColor Green; exit 0 } else { Write-Host 'FAILED: scraper-kit did not respond on http://localhost:8080' -ForegroundColor Red; exit 1 }"

if errorlevel 1 (
  echo.
  echo Container status:
  "%DOCKER%" compose -f docker-compose.google-scraper.yml ps
  echo.
  echo Recent logs:
  "%DOCKER%" compose -f docker-compose.google-scraper.yml logs --tail=80
  pause
  exit /b 1
)

echo.
echo You can now reload http://localhost:4177 and run a Google Places scrape.
pause
