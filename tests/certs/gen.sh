#!/usr/bin/env bash
# Test-only PKI: a throwaway CA and a server cert for hostname "postgres".
# Never used outside the local docker-compose test environment.
set -euo pipefail
cd "$(dirname "$0")"
[ -f server.crt ] && exit 0
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=DB Studio Test CA" -keyout ca.key -out ca.crt 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=postgres" -keyout server.key -out server.csr 2>/dev/null
printf "subjectAltName=DNS:postgres,DNS:localhost,IP:127.0.0.1\n" > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 3650 -extfile san.ext -out server.crt 2>/dev/null
rm -f server.csr san.ext ca.srl
chmod 644 *.crt server.key
echo "test certs generated"
