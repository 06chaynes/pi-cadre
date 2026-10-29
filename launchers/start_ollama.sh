#!/usr/bin/env bash
# Ollama launcher for LFM3

set -e

echo "Starting Ollama service..."
if ! command -v ollama &> /dev/null; then
    echo "ERROR: ollama executable not found in PATH."
    exit 1
fi

ollama serve &
SERVER_PID=$!
sleep 2

echo "Pulling latest LFM3 model if not present..."
ollama pull lfm3:latest

echo "Ollama is ready and serving lfm3:latest on http://127.0.0.1:11434"
wait $SERVER_PID
