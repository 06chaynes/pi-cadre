#!/usr/bin/env bash
# High-Performance llama-server launcher for LFM3 1.7B GGUF
# Supports macOS (Metal) and Linux (CUDA/CPU)

set -e

PORT=${PORT:-8080}
HOST=${HOST:-"127.0.0.1"}
MODEL_ID=${MODEL_ID:-"LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"}
PARALLEL_SLOTS=${PARALLEL_SLOTS:-16}
N_GPU_LAYERS=${N_GPU_LAYERS:-99}
CTX_SIZE=${CTX_SIZE:-32768}

echo "=========================================================="
echo " Starting llama-server with LFM3-1.7B-GGUF"
echo " Host:           ${HOST}:${PORT}"
echo " Model:          ${MODEL_ID}"
echo " Parallel Slots: ${PARALLEL_SLOTS}"
echo " GPU Offload:    ${N_GPU_LAYERS} layers"
echo " Context Window: ${CTX_SIZE} tokens"
echo "=========================================================="

# Check if llama-server is installed
if ! command -v llama-server &> /dev/null; then
    echo "ERROR: llama-server executable not found in PATH."
    echo "Install via Homebrew: brew install llama.cpp"
    echo "Or run: python3 setup_wizard.py"
    exit 1
fi

exec llama-server \
    -hf "${MODEL_ID}" \
    --host "${HOST}" \
    --port "${PORT}" \
    --ctx-size "${CTX_SIZE}" \
    --parallel "${PARALLEL_SLOTS}" \
    -ngl "${N_GPU_LAYERS}" \
    --jinja
