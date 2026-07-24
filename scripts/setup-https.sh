#!/bin/bash
# ============================================================
# Leads-GenX — one-command HTTPS setup (run AFTER your domain
# points at this server with an A record)
#
# Usage (as root, on the server):
#   bash /opt/Leads-genx/scripts/setup-https.sh yourdomain.com
#
# What it does:
#   1. Verifies the domain resolves to this server
#   2. Installs Caddy and gets a free HTTPS certificate
#   3. Enables secure cookies
#   4. Closes the temporary app port — traffic flows via HTTPS only
# ============================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

DOMAIN="${1:-}"
say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✔ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "Run this as root."
[ -n "$DOMAIN" ] || fail "Missing domain. Usage: bash setup-https.sh yourdomain.com"

SERVER_IP=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
DOMAIN_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)

say "Checking DNS for ${DOMAIN}"
echo "    This server : ${SERVER_IP:-unknown}"
echo "    Domain      : ${DOMAIN_IP:-not resolving yet}"
if [ -z "$DOMAIN_IP" ] || [ "$DOMAIN_IP" != "$SERVER_IP" ]; then
  fail "The domain is not pointing at this server yet. Add an A record (@ -> ${SERVER_IP:-YOUR_SERVER_IP}) at your registrar, wait for it to propagate, then re-run this script."
fi
ok "DNS is correct"

say "Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  APT="apt-get -o DPkg::Lock::Timeout=300 -y"
  $APT update
  $APT install debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  $APT update
  $APT install caddy
fi

cat > /etc/caddy/Caddyfile << EOF
${DOMAIN} {
    reverse_proxy 127.0.0.1:4177
}
EOF
systemctl enable --now caddy
systemctl reload caddy
ok "Caddy is proxying ${DOMAIN} -> Leads-GenX (certificate issues automatically within a minute)"

say "Enabling secure cookies"
if ! grep -q 'LGX_SECURE_COOKIES' /etc/systemd/system/leads-genx.service; then
  sed -i 's|Environment=ENABLE_LOCAL_MAPS_SCRAPER=true|Environment=ENABLE_LOCAL_MAPS_SCRAPER=true\nEnvironment=LGX_SECURE_COOKIES=true|' /etc/systemd/system/leads-genx.service
  systemctl daemon-reload
fi
systemctl restart leads-genx
ok "Secure cookies on"

say "Closing the temporary app port"
ufw delete allow 4177 >/dev/null 2>&1 || true
ok "Port 4177 closed — HTTPS is now the only door"

printf '\n\033[1;32m============================================================\033[0m\n'
printf '\033[1;32m  Done! Leads-GenX is live at:\033[0m\n\n'
printf '\033[1;32m      https://%s\033[0m\n' "$DOMAIN"
printf '\033[1;32m============================================================\033[0m\n\n'
echo "  Give it ~1 minute for the certificate, then sign in."
echo "  (If the browser shows a certificate warning, wait a minute"
echo "   and refresh — Caddy is still finishing.)"
echo
