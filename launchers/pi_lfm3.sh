#!/usr/bin/env bash
# Starts Pi on the local llama-server model selected by MODEL in lfm3_config.env (LFM3 for "lfm3", Spark otherwise).
# Run setup_wizard.py first; it registers the llama-cpp provider and the extension with Pi.

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
    LINK="$(readlink "$SELF")"
    case $LINK in
        /*) SELF="$LINK" ;;
        *) SELF="$(dirname "$SELF")/$LINK" ;;
    esac
done
PROJECT_DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
if [ -f "$PROJECT_DIR/lfm3_config.env" ]; then
    source "$PROJECT_DIR/lfm3_config.env"
fi

if ! command -v pi &> /dev/null; then
    echo "pi not found in PATH. Run: python3 setup_wizard.py" >&2
    exit 1
fi

if [ "$MODEL" = lfm3 ]; then
    export LLAMA_BASE_URL="http://127.0.0.1:8081"
    exec pi --provider llama-cpp --model LiquidAI/LFM3-1.7B-GGUF:Q4_K_M "$@"
fi
export LLAMA_BASE_URL="http://127.0.0.1:8080"
exec pi --provider llama-cpp --model XHToken/Spark-X2.6-4B-GGUF:Q4_K_M "$@"
