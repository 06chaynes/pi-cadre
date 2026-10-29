#!/usr/bin/env bash
# High-Performance llama-server launcher for LFM3 1.7B GGUF
# Supports macOS (Metal) and Linux (CUDA/CPU)

set -e

# Path resolution
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$(basename "$SCRIPT_DIR")" = "launchers" ]; then
    PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    PROJECT_DIR="$SCRIPT_DIR"
fi

# Load persistent config if present
if [ -f "$PROJECT_DIR/lfm3_config.env" ]; then
    # shellcheck source=/dev/null
    source "$PROJECT_DIR/lfm3_config.env"
fi

PORT=${PORT:-8080}
HOST=${HOST:-"127.0.0.1"}
MODEL_ID=${MODEL_ID:-"LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"}
PARALLEL_SLOTS=${PARALLEL_SLOTS:-16}
N_GPU_LAYERS=${N_GPU_LAYERS:-99}
CTX_SIZE=${CTX_SIZE:-32768}

EXTRA_ARGS=()

# Parse CLI flags
while [[ $# -gt 0 ]]; do
  case $1 in
    -c|--ctx|--ctx-size)
      CTX_SIZE="$2"
      shift 2
      ;;
    -np|--slots|--parallel)
      PARALLEL_SLOTS="$2"
      shift 2
      ;;
    -p|--port)
      PORT="$2"
      shift 2
      ;;
    -m|--model)
      MODEL_ID="$2"
      shift 2
      ;;
    -ngl|--gpu-layers)
      N_GPU_LAYERS="$2"
      shift 2
      ;;
    -h|--help)
      echo "High-Performance llama-server Launcher for LFM3 1.7B"
      echo ""
      echo "Usage: $0 [options] [-- extra_llama_args]"
      echo ""
      echo "Options:"
      echo "  -c,  --ctx-size <num>    Total context pool across slots (e.g. 32768, 65536, 131072, 262144)"
      echo "                           (Default: 32768; LFM3 max trained: 262144)"
      echo "  -np, --parallel <num>    Number of concurrent slots (default: 16)"
      echo "  -p,  --port <num>        Server port (default: 8080)"
      echo "  -m,  --model <id/path>   HuggingFace model ID or local .gguf path"
      echo "  -ngl <num>               GPU offload layers (default: 99 = full Metal/CUDA)"
      echo "  -h,  --help              Show this help message"
      echo ""
      echo "Examples:"
      echo "  $0 -c 65536 -np 4        # 4 slots with 16k tokens each"
      echo "  $0 -c 262144 -np 1       # Single slot with maximum 256k full context window"
      echo "  $0 -c 32768 -np 16       # 16 slots with 2k tokens each (High throughput swarm)"
      exit 0
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        EXTRA_ARGS+=("$1")
        shift
      done
      break
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

PER_SLOT_CTX=$(( CTX_SIZE / PARALLEL_SLOTS ))

echo "=========================================================="
echo " Starting llama-server with LFM3-1.7B-GGUF"
echo " Host:            ${HOST}:${PORT}"
echo " Model:           ${MODEL_ID}"
echo " Parallel Slots:  ${PARALLEL_SLOTS} slots"
echo " GPU Offload:     ${N_GPU_LAYERS} layers"
echo " Context Pool:    ${CTX_SIZE} tokens"
echo " Slot Capacity:   ~${PER_SLOT_CTX} tokens/slot"
echo " Model Max Train: 262,144 tokens (256k)"
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
    --jinja \
    "${EXTRA_ARGS[@]}"
