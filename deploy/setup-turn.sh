#!/usr/bin/env bash
# Installs and configures a coturn TURN server so WebRTC calls connect even on
# restrictive networks (mobile carriers, strict NATs). Run as root on the
# chat server, then set TURN_* env vars in the chatroom systemd service.
#
# Usage:  TURN_DOMAIN=chat.example.com ./setup-turn.sh
set -euo pipefail

TURN_DOMAIN="${TURN_DOMAIN:?Set TURN_DOMAIN, e.g. TURN_DOMAIN=chat.bistbarg.com}"
TURN_USER="${TURN_USER:-chatturn}"
TURN_PASS="${TURN_PASS:-$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)}"

apt-get update -y
apt-get install -y coturn

cat > /etc/turnserver.conf <<EOF
listening-port=3478
fingerprint
lt-cred-mech
user=${TURN_USER}:${TURN_PASS}
realm=${TURN_DOMAIN}
# Only relay media; harden against misuse
no-cli
no-tcp-relay
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
total-quota=100
stale-nonce=600
EOF

sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
systemctl enable coturn
systemctl restart coturn

echo ""
echo "== coturn is running on port 3478 (open UDP/TCP 3478 in your firewall) =="
echo "Add these to the chatroom service (systemctl edit <service>):"
echo "  [Service]"
echo "  Environment=TURN_URL=turn:${TURN_DOMAIN}:3478"
echo "  Environment=TURN_USERNAME=${TURN_USER}"
echo "  Environment=TURN_PASSWORD=${TURN_PASS}"
echo "Then: systemctl daemon-reload && systemctl restart <service>"
