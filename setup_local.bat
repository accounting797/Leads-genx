@echo off
echo ==========================================
echo   Leads-GenX Local Setup (Windows)
echo ==========================================
echo.
echo This will set up the project on your laptop
echo so you can test at http://localhost:4177
echo.

set REPO_URL=https://github.com/accounting797/Leads-genx.git
set PROJECT_DIR=%USERPROFILE%\Leads-genx-local

echo [1/6] Checking Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo    Node.js NOT found. Please install Node.js 20+ from:
    echo    https://nodejs.org/dist/v20.15.1/node-v20.15.1-x64.msi
    echo    Then run this script again.
    pause
    exit /b 1
)
for /f "tokens=*" %%a in ('node -v') do set NODE_VERSION=%%a
echo    Node.js version: %NODE_VERSION%

echo [2/6] Cloning repository to %PROJECT_DIR%...
if exist "%PROJECT_DIR%" (
    echo    Project exists. Pulling latest changes...
    cd /d "%PROJECT_DIR%"
    git pull origin main
) else (
    git clone %REPO_URL% "%PROJECT_DIR%"
    cd /d "%PROJECT_DIR%"
)

echo [3/6] Installing dependencies...
call npm install

echo [4/6] Creating local .env file...
(
echo NODE_ENV=development
echo PORT=4177
echo DATABASE_URL=file:./prisma/dev.db
echo APIFY_TOKEN=placeholder_add_real_one_later
echo JWT_SECRET=local_dev_secret_not_for_production
echo ADMIN_KEY=local_admin_key
echo) > .env

echo [5/6] Setting up database...
call npx prisma generate
call npx prisma db push --accept-data-loss --skip-generate

echo [6/6] Building TypeScript...
call npm run build
if errorlevel 1 (
    echo.
    echo ==========================================
    echo    BUILD FAILED
echo ==========================================
    echo.
    echo There are TypeScript errors. Check the output above.
    echo.
    pause
    exit /b 1
)

echo.
echo ==========================================
echo    SETUP COMPLETE!
echo ==========================================
echo.
echo Project location: %PROJECT_DIR%
echo.
echo To start the server, run:
echo    cd %PROJECT_DIR%
echo    npm start
echo.
echo Or run directly:
echo    node dist/server.js
echo.
echo Then open in your browser:
echo    http://localhost:4177
echo    http://localhost:4177/api/targeted/catalog
echo.
echo To test targeted scraping:
echo    http://localhost:4177/targeted.html
echo.
pause
