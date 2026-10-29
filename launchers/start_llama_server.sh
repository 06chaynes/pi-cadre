#!/usr/bin/env bash
# High-Performance llama-server launcher for Multi-Model Agents (Spark-X2.6-4B & LFM3-1.7B)
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
MODEL_ID=${MODEL_ID:-"models/Spark-X2.6-4B-Q4_K_M.gguf"}
PARALLEL_SLOTS=${PARALLEL_SLOTS:-8}
N_GPU_LAYERS=${N_GPU_LAYERS:-99}
CTX_SIZE=${CTX_SIZE:-65536}

EXTRA_ARGS=()

# Parse CLI flags
DUAL_MODE=false
while [[ $# -gt 0 ]]; do
  case $1 in
    -d|--dual)
      DUAL_MODE=true
      shift 1
      ;;
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
      if [ "$MODEL_ID" = "dual" ] || [ "$MODEL_ID" = "auto" ] || [ "$MODEL_ID" = "both" ]; then
        DUAL_MODE=true
      fi
      shift 2
      ;;
    -ngl|--gpu-layers)
      N_GPU_LAYERS="$2"
      shift 2
      ;;
    -h|--help)
      echo "High-Performance llama-server Launcher"
      echo ""
      echo "Usage: $0 [options] [-- extra_llama_args]"
      echo ""
      echo "Options:"
      echo "  -d,  --dual              Start both models simultaneously (Spark on 8080, LFM3 on 8081)"
      echo "  -m,  --model <id/path>   Model alias ('auto', 'dual', 'spark', or 'lfm3'), HF repo ID, or .gguf path"
      echo "  -c,  --ctx-size <num>    Total context pool across slots (e.g. 32768, 65536, 131072, 262144, 1048576)"
      echo "  -np, --parallel <num>    Number of concurrent slots (default: 8 for Spark, 16 for LFM3)"
      echo "  -p,  --port <num>        Server port (default: 8080)"
      echo "  -ngl <num>               GPU offload layers (default: 99 = full Metal/CUDA)"
      echo "  -h,  --help              Show this help message"
      echo ""
      echo "Examples:"
      echo "  $0 --dual                          # Start both Spark-4B (8080) and LFM3-1.7B (8081)"
      echo "  $0 -m spark -c 65536 -np 8         # Spark-X2.6 with 8 slots @ 8k tokens each"
      echo "  $0 -m spark -c 1048576 -np 1       # Spark-X2.6 with full 1M maximum context"
      echo "  $0 -m lfm3 -c 32768 -np 16         # LFM3-1.7B with 16 slots @ 2k tokens each"
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

# Resolve aliases
if [ "$MODEL_ID" = "spark" ] || [ "$MODEL_ID" = "spark-4b" ]; then
    if [ -f "$PROJECT_DIR/models/Spark-X2.6-4B-Q4_K_M.gguf" ]; then
        MODEL_ID="$PROJECT_DIR/models/Spark-X2.6-4B-Q4_K_M.gguf"
    else
        MODEL_ID="XHToken/Spark-X2.6-4B-GGUF:Q4_K_M"
    fi
elif [ "$MODEL_ID" = "lfm3" ] || [ "$MODEL_ID" = "lfm3-1.7b" ]; then
    MODEL_ID="LiquidAI/LFM3-1.7B-GGUF:Q4_K_M"
fi

# Detect Model Family and Max Context
if [[ "$MODEL_ID" == *"Spark"* ]] || [[ "$MODEL_ID" == *"spark"* ]]; then
    MODEL_FAMILY="Spark-X2.6-4B (4.0B Params)"
    MAX_TRAINED_CTX="1,048,576 tokens (1M)"
else
    MODEL_FAMILY="LiquidAI LFM3-1.7B (1.7B Params)"
    MAX_TRAINED_CTX="262,144 tokens (256k)"
fi

PER_SLOT_CTX=$(( CTX_SIZE / PARALLEL_SLOTS ))

echo "=========================================================="
echo " Starting llama-server"
echo " Model Family:    ${MODEL_FAMILY}"
echo " Host:            ${HOST}:${PORT}"
echo " Target Model:    ${MODEL_ID}"
echo " Parallel Slots:  ${PARALLEL_SLOTS} slots"
echo " GPU Offload:     ${N_GPU_LAYERS} layers (Metal/CUDA)"
echo " Context Pool:    ${CTX_SIZE} tokens"
echo " Slot Capacity:   ~${PER_SLOT_CTX} tokens/slot"
echo " Model Max Train: ${MAX_TRAINED_CTX}"
echo "=========================================================="

# Check if llama-server is installed
if ! command -v llama-server &> /dev/null; then
    echo "ERROR: llama-server executable not found in PATH."
    echo "Install via Homebrew: brew install llama.cpp"
    echo "Or run: python3 setup_wizard.py"
    exit 1
fi

if [ "$DUAL_MODE" = true ]; then
    echo "=========================================================="
    echo " Starting Dual-Model Swarm Daemon on Apple Silicon Metal"
    echo " Model 1: Spark-X2.6-4B (port 8080 | 8 slots @ 8k tok | 1M max)"
    echo " Model 2: LFM3-1.7B     (port 8081 | 16 slots @ 2k tok | 256k max)"
    echo "=========================================================="

    # Check port 8080
    if curl -s http://127.0.0.1:8080/health | grep -q "ok"; then
        echo " -> Port 8080: Spark-X2.6-4B is already running 🟢"
    else
        SPARK_TARGET="models/Spark-X2.6-4B-Q4_K_M.gguf"
        if [ -f "$PROJECT_DIR/$SPARK_TARGET" ]; then
            SPARK_ARG=(-m "$PROJECT_DIR/$SPARK_TARGET")
        else
            SPARK_ARG=(-hf "XHToken/Spark-X2.6-4B-GGUF:Q4_K_M")
        fi
        echo " -> Launching Spark-X2.6-4B on port 8080..."
        llama-server "${SPARK_ARG[@]}" --port 8080 --ctx-size 65536 --parallel 8 -ngl 99 >/dev/null 2>&1 &
    fi

    # Check port 8081
    if curl -s http://127.0.0.1:8081/health | grep -q "ok"; then
        echo " -> Port 8081: LFM3-1.7B is already running 🟢"
    else
        echo " -> Launching LFM3-1.7B on port 8081..."
        llama-server -hf LiquidAI/LFM3-1.7B-GGUF:Q4_K_M --port 8081 --ctx-size 32768 --parallel 16 -ngl 99 >/dev/null 2>&1 &
    fi

    sleep 2
    echo "Dual-Model Swarm is active and ready."
    exit 0
fi

# Select -m for local file vs -hf for Hugging Face hub
if [ -f "$MODEL_ID" ] || [[ "$MODEL_ID" == *.gguf ]]; then
    MODEL_ARG=(-m "$MODEL_ID")
else
    MODEL_ARG=(-hf "$MODEL_ID")
fi

exec llama-server \
    "${MODEL_ARG[@]}" \
    --host "${HOST}" \
    --port "${PORT}" \
    --ctx-size "${CTX_SIZE}" \
    --parallel "${PARALLEL_SLOTS}" \
    -ngl "${N_GPU_LAYERS}" \
    --jinja \
    "${EXTRA_ARGS[@]}"
