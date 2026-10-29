#!/usr/bin/env bash
# Runs setup_wizard.py with Python 3 on macOS and Linux.

set -e

PYTHON_BIN=""
if command -v python3 &> /dev/null; then
    PYTHON_BIN="python3"
elif command -v python &> /dev/null; then
    PYTHON_BIN="python"
fi

if [ -z "$PYTHON_BIN" ]; then
    echo "ERROR: Python 3 was not found in your PATH."
    echo "Please install Python 3.9+ and try again."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$PYTHON_BIN" "$SCRIPT_DIR/setup_wizard.py" "$@"
