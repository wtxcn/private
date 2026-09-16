#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
STATE_DIR="$HOME/.card-offers-hub"
APP_DIR="$STATE_DIR/app"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_AGENTS/com.cardoffers.local-server.plist"
NODE_BIN=${NODE_BIN:-$(command -v node)}
VPN_HOST=${VPN_HOST:-$(ifconfig | awk '/inet 100\./ { print $2; exit }')}

if [ -z "$VPN_HOST" ]; then
  echo "No VPN address was detected. Connect the VPN and run this installer again." >&2
  exit 1
fi

mkdir -p "$APP_DIR/public" "$LAUNCH_AGENTS"
cp "$SOURCE_DIR/server.cjs" "$APP_DIR/server.cjs"
cp "$SOURCE_DIR/public/index.html" "$APP_DIR/public/index.html"
cp "$SOURCE_DIR/public/app.js" "$APP_DIR/public/app.js"
cp "$SOURCE_DIR/public/styles.css" "$APP_DIR/public/styles.css"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cardoffers.local-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$APP_DIR/server.cjs</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--vpn-host</string><string>$VPN_HOST</string>
    <string>--port</string><string>8787</string>
    <string>--data-dir</string><string>$STATE_DIR</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$STATE_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/server-error.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.cardoffers.local-server" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.cardoffers.local-server"

echo "Card Offers Server installed and started."
echo "State directory: $STATE_DIR"
echo "VPN address: http://$VPN_HOST:8787"
