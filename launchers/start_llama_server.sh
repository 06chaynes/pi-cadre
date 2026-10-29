#!/usr/bin/env bash
# Starts llama-server using lfm3_config.env (see that file for MODEL values). Flags override the config;
# arguments after -- go to llama-server.
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$PROJECT_DIR/lfm3_config.env" ]; then
    source "$PROJECT_DIR/lfm3_config.env"
fi

usage() {
    echo "Usage: $0 [-m dual|spark|lfm3|HF_ID|PATH.gguf] [-c CTX_SIZE] [-np PARALLEL_SLOTS] [-p PORT] [-ngl GPU_LAYERS] [-- llama-server args]"
}

EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
    case $1 in
        -m|--model) MODEL="$2"; shift 2 ;;
        -c|--ctx-size) CTX_SIZE="$2"; shift 2 ;;
        -np|--parallel) PARALLEL_SLOTS="$2"; shift 2 ;;
        -p|--port) PORT="$2"; shift 2 ;;
        -ngl|--gpu-layers) N_GPU_LAYERS="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        --) shift; EXTRA_ARGS=("$@"); break ;;
        *) usage >&2; exit 1 ;;
    esac
done

if ! command -v llama-server &> /dev/null; then
    echo "llama-server not found in PATH. Install llama.cpp or run: python3 setup_wizard.py" >&2
    exit 1
fi

case ${MODEL:-dual} in
    dual)
        trap 'kill $(jobs -p) 2>/dev/null' EXIT
        "$0" -m spark -c "" -np "" -p "" -- "${EXTRA_ARGS[@]}" &
        "$0" -m lfm3 -c "" -np "" -p "" -- "${EXTRA_ARGS[@]}" &
        wait
        exit
        ;;
    spark)
        SPARK_GGUF="$PROJECT_DIR/models/Spark-X2.6-4B-Q4_K_M.gguf"
        if [ -f "$SPARK_GGUF" ]; then SOURCE=(-m "$SPARK_GGUF"); else SOURCE=(-hf XHToken/Spark-X2.6-4B-GGUF:Q4_K_M); fi
        DEFAULTS=(8080 65536 8)
        ;;
    lfm3) SOURCE=(-hf LiquidAI/LFM3-1.7B-GGUF:Q4_K_M); DEFAULTS=(8081 32768 16) ;;
    *.gguf) SOURCE=(-m "$MODEL"); DEFAULTS=(8080 32768 8) ;;
    *) SOURCE=(-hf "$MODEL"); DEFAULTS=(8080 32768 8) ;;
esac

exec llama-server "${SOURCE[@]}" \
    --host "${HOST:-127.0.0.1}" \
    --port "${PORT:-${DEFAULTS[0]}}" \
    --ctx-size "${CTX_SIZE:-${DEFAULTS[1]}}" \
    --parallel "${PARALLEL_SLOTS:-${DEFAULTS[2]}}" \
    -ngl "${N_GPU_LAYERS:-99}" \
    --jinja \
    "${EXTRA_ARGS[@]}"
