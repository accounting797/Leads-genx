#!/bin/bash
# ============================================================
# Leads-GenX — one-command Ubuntu VPS installer
# Works on Ubuntu 22.04 / 24.04 (rdp.sh and similar providers)
#
# Usage (as root, on the server):
#   bash install-vps.sh YOUR_GITHUB_TOKEN
#
# What it does:
#   1. System update + base packages
#   2. Node.js 20 + Docker
#   3. Downloads & builds Leads-GenX into /opt/Leads-genx
#   4. Builds the Docker maps-scraper image and starts it
#   5. Creates the auto-start service + update script
#   6. Opens the firewall (SSH, HTTP, HTTPS, temp app port)
#
# When it finishes: open http://YOUR_SERVER_IP:4177 in your
# browser and create your admin account immediately.
# Then run:  bash /opt/Leads-genx/scripts/setup-https.sh yourdomain.com
# ============================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

TOKEN="${1:-}"
APP_DIR="/opt/Leads-genx"
DATA_DIR="/var/lib/leads-genx"
SCRAPER_DIR="/opt/google-maps-scraper"
IMAGE="leads-genx/google-maps-scraper:1.16.3-local"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "Run this as root (ssh root@YOUR_SERVER_IP)."
[ -n "$TOKEN" ] || fail "Missing GitHub token. Usage: bash install-vps.sh YOUR_GITHUB_TOKEN"
if [ -f /etc/os-release ]; then . /etc/os-release; [ "${ID:-}" = "ubuntu" ] || say "Warning: not Ubuntu (${ID:-unknown}) — continuing anyway."; fi

SERVER_IP=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

# ----------------------------------------------------------
say "Step 1/6 — System update & base packages"
# Fresh VPS images often run unattended upgrades in the background and hold
# the apt lock — wait for cloud-init and use lock timeouts so we never fail.
if command -v cloud-init >/dev/null 2>&1; then
  cloud-init status --wait >/dev/null 2>&1 || true
fi
APT="apt-get -o DPkg::Lock::Timeout=300 -y"
$APT update
$APT upgrade
$APT install git curl ca-certificates gnupg build-essential ufw

# Small-VPS safety net: without swap, one memory spike (a build running while
# the app and the scraper's headless browser are up) can OOM-kill the app.
# A 2G swapfile absorbs spikes and keeps everything alive.
if ! swapon --show=NAME --noheadings 2>/dev/null | grep -q .; then
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-leads-genx.conf
  ok "2G swap safety net enabled"
else
  ok "Swap already present"
fi

# Keep system logs across reboots so a crash can be diagnosed after the fact.
mkdir -p /var/log/journal
systemctl restart systemd-journald 2>/dev/null || true
ok "System ready"

# ----------------------------------------------------------
say "Step 2/6 — Node.js 20 & Docker"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v2'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  $APT install nodejs
fi
node -v
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | bash
fi
systemctl enable --now docker
docker --version
ok "Node & Docker ready"

# ----------------------------------------------------------
say "Step 3/6 — Download & build Leads-GenX"
mkdir -p /opt "$DATA_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "https://x-access-token:${TOKEN}@github.com/accounting797/Leads-genx.git" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --no-fund --no-audit
npx prisma generate
# Cap the compiler's memory so building while the app + scraper are live
# can't trigger an OOM kill of the running service on small servers.
NODE_OPTIONS="--max-old-space-size=1024" npm run build
DATABASE_URL="file:${DATA_DIR}/prod.db" npx prisma db push --skip-generate
ok "App built"

# ----------------------------------------------------------
say "Step 4/6 — Build & start the maps scraper (Docker)"
if [ ! -d "$SCRAPER_DIR/.git" ]; then
  git clone --depth 1 https://github.com/gosom/google-maps-scraper.git "$SCRAPER_DIR"
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" "$SCRAPER_DIR"
fi
docker compose -f "$APP_DIR/docker-compose.google-scraper.yml" up -d
sleep 5
docker ps --filter "name=leads-genx-gmaps-scraper" --format '    {{.Names}} — {{.Status}}'
ok "Scraper running"

# ----------------------------------------------------------
say "Step 5/6 — Auto-start service & update script"
cat > /etc/systemd/system/leads-genx.service << EOF
[Unit]
Description=Leads-GenX
After=network-online.target docker.service
Wants=network-online.target
# Never give up restarting — without this, systemd stops trying after a few
# quick crashes (e.g. memory pressure during an update) and the site stays down.
StartLimitIntervalSec=0

[Service]
WorkingDirectory=${APP_DIR}
Environment=DATABASE_URL=file:${DATA_DIR}/prod.db
Environment=PORT=4177
Environment=ENABLE_LOCAL_MAPS_SCRAPER=true
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
# If the server runs out of memory, the OOM killer should pick the scraper's
# headless browser first — never the app itself.
OOMScoreAdjust=-500

[Install]
WantedBy=multi-user.target
EOF

cat > "$APP_DIR/update-server.sh" << 'EOF'
#!/bin/bash
set -e
cd /opt/Leads-genx
git pull
npm install --no-fund --no-audit
npx prisma generate
# Cap compiler memory so updating never starves the box on small servers.
NODE_OPTIONS="--max-old-space-size=1024" npm run build
DATABASE_URL="file:/var/lib/leads-genx/prod.db" npx prisma db push --skip-generate
systemctl restart leads-genx
echo "Leads-GenX updated and restarted."
EOF
chmod +x "$APP_DIR/update-server.sh"

systemctl daemon-reload
systemctl enable leads-genx
# restart (not just start) so re-running the installer after an update
# actually puts the freshly built code live.
systemctl restart leads-genx
sleep 4
systemctl is-active --quiet leads-genx || fail "Service failed to start — run: journalctl -u leads-genx -n 50 --no-pager"
curl -fsS --max-time 5 http://127.0.0.1:4177/api/health >/dev/null || fail "App not answering on port 4177 — run: journalctl -u leads-genx -n 50 --no-pager"
ok "Service live on port 4177"

# ----------------------------------------------------------
say "Step 6/6 — Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80 >/dev/null
ufw allow 443 >/dev/null
if [ "${SKIP_PUBLIC_APP_PORT:-0}" != "1" ]; then
  ufw allow 4177 >/dev/null   # temporary — setup-https.sh removes it
fi
ufw --force enable >/dev/null
ok "Firewall on"

# ----------------------------------------------------------
IP="${SERVER_IP:-YOUR_SERVER_IP}"
printf '\n\033[1;32m============================================================\033[0m\n'
printf '\033[1;32m  Leads-GenX is installed and running!\033[0m\n'
printf '\033[1;32m============================================================\033[0m\n\n'
if [ "${SKIP_PUBLIC_APP_PORT:-0}" = "1" ]; then
  echo "  Automated deployment mode: the app port is NOT exposed"
  echo "  publicly — the deployment wizard is taking it from here."
  echo
else
  echo "  NEXT — do these two things:"
  echo
  echo "  1. Open this in your browser RIGHT NOW and create your"
  echo "     admin account (first person to do it owns the server):"
  echo
  echo "         http://${IP}:4177"
  echo
  echo "  2. After your domain points to ${IP} (A record), run:"
  echo
  echo "         bash ${APP_DIR}/scripts/setup-https.sh yourdomain.com"
  echo
fi
echo "  Future updates:  ${APP_DIR}/update-server.sh"
echo
