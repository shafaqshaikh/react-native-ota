#!/usr/bin/env bash
#
# Start the local mongod used by the OTA server.
#
# - Data dir:       /opt/homebrew/var/mongodb-otadev
# - Auth:           user=readWrite / pwd set at first boot (see README)
# - TLS:            self-signed cert at <dbpath>/tls/mongod.pem
# - Port:           27017 (localhost only)
# - Log:            /tmp/mongod-otadev.log
#
# We do NOT use --fork: there is a known crash on Apple Silicon MongoDB 5.0
# where the post-fork child aborts inside SecItemImport when loading the TLS
# certificate. Running in the background via `nohup` + `disown` avoids it.
#
# Matches the MONGO_URL in server/.env:
#   mongodb://readWrite:<pwd>@localhost:27017/?directConnection=true\
#     &authSource=admin&tls=true&tlsAllowInvalidHostnames=true\
#     &tlsAllowInvalidCertificates=true

set -e

MONGOD=/opt/homebrew/opt/mongodb-community@5.0/bin/mongod
DBPATH=/opt/homebrew/var/mongodb-otadev
TLS_CERT="$DBPATH/tls/mongod.pem"
LOG=/tmp/mongod-otadev.log
STDOUT=/tmp/mongod-otadev.stdout.log
PID_FILE="$DBPATH/mongod.pid"

# Already up?
if lsof -iTCP:27017 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "mongod already running on :27017 (PID $(lsof -iTCP:27017 -sTCP:LISTEN -t))"
  exit 0
fi

# Sanity checks
if [[ ! -x "$MONGOD" ]]; then
  echo "mongod binary not found at $MONGOD" >&2
  echo "install with: brew install mongodb-community@5.0" >&2
  exit 1
fi
if [[ ! -f "$TLS_CERT" ]]; then
  echo "TLS cert not found at $TLS_CERT" >&2
  echo "regenerate with:" >&2
  echo "  mkdir -p $DBPATH/tls && cd $DBPATH/tls" >&2
  echo "  openssl req -newkey rsa:2048 -nodes -x509 -days 3650 \\" >&2
  echo "    -subj /CN=localhost -keyout key.pem -out cert.pem" >&2
  echo "  cat cert.pem key.pem > mongod.pem && chmod 600 mongod.pem" >&2
  exit 1
fi

mkdir -p "$DBPATH"

nohup "$MONGOD" \
  --dbpath "$DBPATH" \
  --bind_ip 127.0.0.1 \
  --port 27017 \
  --logpath "$LOG" \
  --auth \
  --tlsMode requireTLS \
  --tlsCertificateKeyFile "$TLS_CERT" \
  --tlsAllowConnectionsWithoutCertificates \
  > "$STDOUT" 2>&1 &

MONGO_PID=$!
disown
echo "$MONGO_PID" > "$PID_FILE"

# Wait briefly for the port to come up
for _ in 1 2 3 4 5; do
  if lsof -iTCP:27017 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "mongod started (PID $MONGO_PID)"
    echo "  log : $LOG"
    echo "  stop: kill $MONGO_PID   # or ./scripts/stop-mongo.sh"
    exit 0
  fi
  sleep 1
done

echo "mongod failed to start within 5s — see $LOG" >&2
exit 1
