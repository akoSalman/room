#!/bin/bash
# Run this ONCE on your server to set up the app for the first time.
# Usage: bash server-setup.sh YOUR_DIRECTADMIN_USER

set -e

DA_USER="${1:?Usage: bash server-setup.sh YOUR_DIRECTADMIN_USER}"
APP_DIR="/home/$DA_USER/domains/chat.akosalman.com/public_html"

echo "==> Creating app directory"
mkdir -p "$APP_DIR"
mkdir -p "$APP_DIR/uploads"

echo "==> Cloning repository"
# Replace with your actual GitHub repo URL
git clone https://github.com/akosalman/room.git "$APP_DIR"

echo "==> Installing Node dependencies"
cd "$APP_DIR"
npm ci --omit=dev

echo "==> Installing systemd service"
# Replace YOUR_DIRECTADMIN_USER and JWT_SECRET inside the service file first
cp deploy/chatroom.service /etc/systemd/system/chatroom.service
sed -i "s/YOUR_DIRECTADMIN_USER/$DA_USER/g" /etc/systemd/system/chatroom.service

echo "==> Allowing app user to restart service without password"
echo "$DA_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart chatroom" >> /etc/sudoers.d/chatroom
chmod 440 /etc/sudoers.d/chatroom

echo "==> Enabling and starting service"
systemctl daemon-reload
systemctl enable chatroom
systemctl start chatroom

echo ""
echo "==> Done! Service status:"
systemctl status chatroom --no-pager

echo ""
echo "==> Next: configure Apache reverse proxy"
echo "    See deploy/apache-vhost.conf for instructions"
