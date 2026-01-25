#!/bin/bash
# Setup Chrome extension native messaging host for Claude Code
# This script creates the necessary configuration files that would normally
# be created by 'claude --chrome' command

set -e

NATIVE_HOST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
NATIVE_HOST_FILE="$NATIVE_HOST_DIR/com.anthropic.claude_code_browser_extension.json"
CHROME_BIN_DIR="$HOME/.claude/chrome"
CHROME_NATIVE_HOST="$CHROME_BIN_DIR/chrome-native-host"

# Create directories
mkdir -p "$NATIVE_HOST_DIR"
mkdir -p "$CHROME_BIN_DIR"

# Find claude binary (check multiple possible locations)
CLAUDE_BIN=""
for path in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "/usr/local/bin/claude"; do
    if [ -x "$path" ]; then
        CLAUDE_BIN="$path"
        break
    fi
done

if [ -z "$CLAUDE_BIN" ]; then
    echo "Warning: Claude binary not found. Native messaging host will be configured but may not work until Claude is properly installed."
    NATIVE_HOST_PATH="$CHROME_NATIVE_HOST"
else
    NATIVE_HOST_PATH="$CHROME_NATIVE_HOST"
    # Create a wrapper script for native messaging
    # Claude Code handles native messaging internally when invoked as chrome-native-host
    cat > "$CHROME_NATIVE_HOST" << 'WRAPPER'
#!/bin/bash
# Native messaging host for Claude Code Chrome extension
exec "$HOME/.local/bin/claude" chrome-native-messaging "$@"
WRAPPER
    chmod +x "$CHROME_NATIVE_HOST"
    echo "Created native host wrapper at $CHROME_NATIVE_HOST"
fi

# Create native messaging host manifest
cat > "$NATIVE_HOST_FILE" << EOF
{
  "name": "com.anthropic.claude_code_browser_extension",
  "description": "Claude Code Browser Extension Native Host",
  "path": "$NATIVE_HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"
  ]
}
EOF

echo "Chrome extension native messaging host configured:"
echo "  Manifest: $NATIVE_HOST_FILE"
echo "  Native host: $NATIVE_HOST_PATH"
