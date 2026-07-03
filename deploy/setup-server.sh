#!/usr/bin/env bash
# One-time provisioning for a new ChatRoom instance on a fresh (or partially set
# up) Linux server: installs Node.js if missing, clones the app, sets it up as
# a systemd service, and configures nginx + HTTPS via certbot.
#
# Usage (run as root or with sudo):
#   DOMAIN=chat.bistbarg.com REPO_URL=https://github.com/akoSalman/room.git \
#     ./setup-server.sh
#
# Safe to re-run: every step is idempotent (checks before installing/creating).

set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN, e.g. DOMAIN=chat.bistbarg.com}"
REPO_URL="${REPO_URL:?Set REPO_URL, e.g. REPO_URL=https://github.com/akoSalman/room.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/chatroom-$DOMAIN}"
SERVICE_NAME="${SERVICE_NAME:-chatroom-$(echo "$DOMAIN" | tr '.' '-')}"
PORT="${PORT:-3000}"
APP_USER="${APP_USER:-$SUDO_USER}"
[ -z "$APP_USER" ] && APP_USER=$(whoami)

echo "== Installing Node.js (skipped if already present) =="
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else
  echo "Node $(node -v) already installed."
fi

echo "== Installing nginx + certbot (skipped if already present) =="
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx

echo "== Cloning/updating the app at $APP_DIR =="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "== Installing dependencies =="
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev

echo "== IMPORTANT: place your Firebase service account key now =="
echo "   Copy firebase-service-account.json into: $APP_DIR/firebase-service-account.json"
echo "   (This script will NOT create it for you — it's a secret you generate"
echo "    in the Firebase console for this brand's project.)"
read -p "Press Enter once it's in place (or to skip push notifications for now)... "

echo "== Creating systemd service: $SERVICE_NAME =="
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=ChatRoom ($DOMAIN)
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

echo "== Configuring nginx reverse proxy for $DOMAIN =="
cat > "/etc/nginx/sites-available/${DOMAIN}" <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
nginx -t
systemctl reload nginx

echo "== Requesting HTTPS certificate =="
echo "   (Make sure $DOMAIN's DNS A record already points at this server's IP"
echo "    before continuing, or certbot will fail.)"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@${DOMAIN#chat.}" || \
  echo "certbot failed — you can re-run: certbot --nginx -d $DOMAIN"

echo ""
echo "== Done =="
echo "Service:   systemctl status $SERVICE_NAME"
echo "Logs:      journalctl -u $SERVICE_NAME -f"
echo "App dir:   $APP_DIR"
echo "Restart:   sudo systemctl restart $SERVICE_NAME"
echo "Update:    cd $APP_DIR && git pull && npm install && sudo systemctl restart $SERVICE_NAME"
