#!/usr/bin/env bash
# Run ON the jump host (edge VM) as root: registers a box's support public key for the reverse tunnel.
#   jumphost-add-box.sh "<ssh-ed25519 AAAA… comment>" <remote-port>
# The key may only open a reverse listener on 127.0.0.1:<remote-port> — no shell, no other forwards.
# Connect afterwards from the jump host:  ssh -p <remote-port> <user>@localhost
set -euo pipefail
PUBKEY="${1:?public key}"; PORT="${2:?remote port, unique per box, e.g. 22001}"
USER_NAME="${SUPPORT_USER:-printsupport}"
id "$USER_NAME" >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/$USER_NAME --shell /usr/sbin/nologin "$USER_NAME"
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" /var/lib/$USER_NAME/.ssh
AK=/var/lib/$USER_NAME/.ssh/authorized_keys
touch "$AK"; chmod 600 "$AK"; chown "$USER_NAME:$USER_NAME" "$AK"
KEYBODY=$(echo "$PUBKEY" | awk '{print $1" "$2}')
grep -qF "$KEYBODY" "$AK" && sed -i "\#$KEYBODY#d" "$AK"
echo "restrict,port-forwarding,permitlisten=\"${PORT}\" ${PUBKEY}" >> "$AK"
# sshd: the support user may do port forwarding only (no shell/pty), reverse ports stay on loopback
if [ ! -f /etc/ssh/sshd_config.d/60-printsupport.conf ]; then
  cat > /etc/ssh/sshd_config.d/60-printsupport.conf <<CONF
Match User ${USER_NAME}
    AllowTcpForwarding remote
    GatewayPorts no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PermitOpen none
    ForceCommand /bin/false
CONF
  sshd -t && systemctl reload ssh
fi
echo "registered: port ${PORT} for '$(echo "$PUBKEY" | awk '{print $3}')' → connect with: ssh -p ${PORT} <user>@localhost (from this host)"
