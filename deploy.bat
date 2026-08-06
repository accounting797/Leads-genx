@echo off
echo ==========================================
echo   Leads-GenX Auto-Deploy for Windows
echo ==========================================
echo.
echo This will SSH into your server and deploy everything automatically.
echo You will be asked for your server password once.
echo.

set SERVER_IP=45.141.215.33
set SERVER_USER=root
set RAW_URL=https://raw.githubusercontent.com/accounting797/Leads-genx/main/deploy.sh

echo [1/1] Connecting to server %SERVER_IP%...
echo.
echo When prompted, enter your server password.
echo.

ssh %SERVER_USER%@%SERVER_IP% "curl -fsSL %RAW_URL% -o /tmp/deploy.sh && chmod +x /tmp/deploy.sh && bash /tmp/deploy.sh"

echo.
echo ==========================================
echo   Deploy command sent!
echo ==========================================
echo.
echo If you see errors above, check:
echo   1. Is the server IP correct? (currently: %SERVER_IP%)
echo   2. Is the username correct? (currently: %SERVER_USER%)
echo   3. Did you enter the right password?
echo.
echo To check if it worked, visit:
echo   https://leadsgenx.top/api/targeted/campaigns
echo.
pause
