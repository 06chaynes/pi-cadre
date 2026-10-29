#!/usr/bin/env bash
# Quick launcher for Pi configured with local LFM3
# Presets environment variables and launches pi

export LLAMA_BASE_URL=${LLAMA_BASE_URL:-"http://127.0.0.1:8080"}
export OPENAI_BASE_URL=${OPENAI_BASE_URL:-"http://127.0.0.1:8080/v1"}
export OPENAI_API_KEY="none"

if command -v pi &> /dev/null; then
    exec pi --provider llama-cpp --model "LiquidAI/LFM3-1.7B-GGUF:Q4_K_M" "$@"
else
    echo "ERROR: pi executable not found in PATH."
    echo "Run: python3 setup_wizard.py"
    exit 1
fi
