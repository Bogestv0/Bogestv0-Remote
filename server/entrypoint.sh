#!/bin/sh
set -e
# Самоподписанный сертификат создаётся один раз и хранится в /data.
# Клиент не доверяет «центрам сертификации», а закрепляет именно этот отпечаток — MITM невозможен.
if [ "$TLS" != "0" ] && [ ! -f /data/cert.pem ]; then
  SAN="DNS:bogestv0-remote"
  [ -n "$TURN_HOST" ] && SAN="IP:$TURN_HOST,$SAN"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout /data/key.pem -out /data/cert.pem -days 3650 \
    -subj "/CN=bogestv0-remote" -addext "subjectAltName=$SAN"
  chmod 600 /data/key.pem
  echo "Сертификат создан."
fi
exec node server.js
