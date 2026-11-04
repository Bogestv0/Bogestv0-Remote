#!/usr/bin/env bash
# Открывает порты Bogestv0 REMOTE в ufw. Запускать на VPS.
set -euo pipefail
sudo ufw allow 8443/tcp          # signaling (wss)
sudo ufw allow 3478/udp          # TURN/STUN
sudo ufw allow 3478/tcp          # TURN по TCP (запасной вариант)
sudo ufw allow 49160:49200/udp   # relay-порты TURN
echo "Готово. Те же порты откройте в панели хостера, если там есть свой файрвол."
echo "Старые порты RustDesk (21115-21119) можно закрыть:  sudo ufw delete allow 21116/udp  и т.д."
