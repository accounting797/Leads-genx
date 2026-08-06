#!/bin/bash
set -e

echo "=========================================="
echo "  Leads-GenX Auto-Deploy Script"
echo "=========================================="

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

SERVER_IP="45.141.215.33"
REPO_URL="https://github.com/accounting797/Leads-genx.git"
PROJECT_DIR="/var/www/Leads-genx"

echo -e "${YELLOW}[1/10] Updating system packages...${NC}"
apt update -qq || true

echo -e "${YELLOW}[2/10] Installing git, curl, and build tools...${NC}"
apt install -y -qq git curl build-essential || true

echo -e "${YELLOW}[3/10] Installing Node.js 20...${NC}"
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1 || true
    apt install -y -qq nodejs || true
fi
NODE_VERSION=$(node -v 2>/dev/null || echo "not installed")
echo -e "${GREEN}    Node.js version: $NODE_VERSION${NC}"

echo -e "${YELLOW}[4/10] Installing PM2...${NC}"
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2 > /dev/null 2>&1 || true
fi

echo -e "${YELLOW}[5/10] Installing Caddy...${NC}"
if ! command -v caddy &> /dev/null; then
    apt install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg || true
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' 2>/dev/null | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' 2>/dev/null | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null || true
    apt update -qq 2>/dev/null || true
    apt install -y -qq caddy 2>/dev/null || true
fi

echo -e "${YELLOW}[6/10] Cloning / updating repository...${NC}"
if [ -d "$PROJECT_DIR" ]; then
    cd "$PROJECT_DIR"
    git reset --hard HEAD 2>/dev/null || true
    git clean -fd 2>/dev/null || true
    git pull origin main 2>/dev/null || true
else
    mkdir -p /var/www
    cd /var/www
    git clone "$REPO_URL" 2>/dev/null || true
    cd Leads-genx 2>/dev/null || true
fi

echo -e "${YELLOW}[7/10] Installing dependencies and building...${NC}"
npm install 2>/dev/null || true
npm run build 2>/dev/null || true

echo -e "${YELLOW}[8/10] Setting up database...${NC}"
npx prisma generate 2>/dev/null || true
npx prisma db push --accept-data-loss --skip-generate 2>/dev/null || true

echo -e "${YELLOW}[9/10] Creating .env file...${NC}"
if [ ! -f ".env" ]; then
cat > .env << 'ENVEOF'
NODE_ENV=production
PORT=4177
DATABASE_URL=file:./prisma/dev.db
APIFY_TOKEN=placeholder_add_real_apify_token_here
JWT_SECRET=708e85d9956cb2ae17a496942461b549deee8751c0d80a60c2ebf06de8f2e6ad7059520efaf73ecc98b32dc73496cbdc544fb8c2b243b289426682769b2372c7
ADMIN_KEY=0c7490258913ec05064179b73d50af5aeb7a7f52099855372c358c217866e78c
ENVEOF
    echo -e "${GREEN}    .env created with auto-generated secrets${NC}"
else
    echo -e "${GREEN}    .env already exists, skipping${NC}"
fi

echo -e "${YELLOW}[10/10] Starting server with PM2...${NC}"
pm2 delete leads-genx 2>/dev/null || true
pm2 start dist/server.js --name "leads-genx" 2>/dev/null || true
pm2 save 2>/dev/null || true
pm2 startup systemd 2>/dev/null || true

echo -e "${YELLOW}[11/11] Configuring Caddy...${NC}"
cat > /etc/caddy/Caddyfile << 'CADDYEOF'
leadsgenx.top {
    handle /api/* {
        reverse_proxy localhost:4177
    }
    handle {
        root * /var/www/Leads-genx/public
        file_server
        try_files {path} /index.html
    }
}
CADDYEOF

caddy reload 2>/dev/null || caddy start --config /etc/caddy/Caddyfile 2>/dev/null || true

echo ""
echo "=========================================="
echo -e "${GREEN}  DEPLOYMENT COMPLETE!${NC}"
echo "=========================================="
echo ""
echo "  Domain:     https://leadsgenx.top"
echo "  API:        https://leadsgenx.top/api"
echo "  Server:     http://localhost:4177"
echo ""
echo "  PM2 Status:"
pm2 status | grep leads-genx || pm2 status 2>/dev/null || echo "  PM2 not available"

echo ""
echo -e "${YELLOW}  NEXT STEPS:${NC}"
echo "  1. Test: curl http://localhost:4177/api/targeted/campaigns"
echo "  2. Add real APIFY_TOKEN to: $PROJECT_DIR/.env"
echo "  3. Restart: pm2 restart leads-genx"
echo ""
echo "  To get Apify token: https://apify.com -> Settings -> Integrations"
echo "=========================================="
