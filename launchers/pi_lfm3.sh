#!/usr/bin/env bash
# Quick launcher for Pi configured with local LFM3
# Presets environment variables and launches pi

# Robust path resolution across symlinks
PRG="${BASH_SOURCE[0]}"
while [ -h "$PRG" ]; do
    ls=$(ls -ld "$PRG")
    link=$(expr "$ls" : '.*-> \(.*\)$')
    if expr "$link" : '/.*' > /dev/null; then
        PRG="$link"
    else
        PRG="$(dirname "$PRG")/$link"
    fi
done
SCRIPT_DIR="$(cd "$(dirname "$PRG")" && pwd)"
if [ "$(basename "$SCRIPT_DIR")" = "launchers" ]; then
    PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    PROJECT_DIR="$SCRIPT_DIR"
fi

# Source persistent configuration if present
if [ -f "$PROJECT_DIR/lfm3_config.env" ]; then
    # shellcheck source=/dev/null
    source "$PROJECT_DIR/lfm3_config.env"
fi

export LLAMA_BASE_URL=${LLAMA_BASE_URL:-"http://127.0.0.1:8080"}
export OPENAI_BASE_URL=${OPENAI_BASE_URL:-"http://127.0.0.1:8080/v1"}
export OPENAI_API_KEY="none"

EXT_FLAG=""
if [ -f "$PROJECT_DIR/pi_extensions/lfm3_agent_extension.ts" ]; then
    EXT_FLAG="-e $PROJECT_DIR/pi_extensions/lfm3_agent_extension.ts"
fi

if command -v pi &> /dev/null; then
    exec pi --provider llama-cpp --model "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M" $EXT_FLAG "$@"
else
    echo "ERROR: pi executable not found in PATH."
    echo "Run: python3 setup_wizard.py"
    exit 1
fi
