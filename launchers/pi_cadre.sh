#!/usr/bin/env bash
# Starts Pi on the model selected by MODEL in cadre_config.env: the cadre router for "dual", LFM3 for "lfm3", Spark otherwise.
# Needs this repo installed as a Pi package (setup_wizard.py or pi install); its extension registers the llama-cpp provider.

SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
    LINK="$(readlink "$SELF")"
    case $LINK in
        /*) SELF="$LINK" ;;
        *) SELF="$(dirname "$SELF")/$LINK" ;;
    esac
done
PROJECT_DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
if [ -f "$PROJECT_DIR/cadre_config.env" ]; then
    source "$PROJECT_DIR/cadre_config.env"
fi

if ! command -v pi &> /dev/null; then
    echo "pi not found in PATH. Run: python3 setup_wizard.py" >&2
    exit 1
fi

case ${MODEL:-dual} in
    dual) exec pi --provider llama-cpp --model cadre "$@" ;;
    lfm3) exec pi --provider llama-cpp --model LiquidAI/LFM3-1.7B-GGUF:Q4_K_M "$@" ;;
    *) exec pi --provider llama-cpp --model XHToken/Spark-X2.6-4B-GGUF:Q4_K_M "$@" ;;
esac
