#!/usr/bin/env bash
# Run from WSL: OpenAI-compatible vLLM server for OpenClaw (`docs/providers/vllm.md`).
#
# Prereq: `~/vllm-openclaw` venv with:
#   uv pip install --reinstall vllm torch torchvision torchaudio --torch-backend=cu128
# (CUDA 12.x wheels; avoids libcudart.so.12 mismatch from mixed cu130 stacks.)
#
# WSL2 note: TP>1 can fail startup if `--gpu-memory-utilization` reserves more than *free*
# VRAM per GPU (see vLLM ValueError in logs). This script defaults to 0.55 for TP>1; raise
# `VLLM_GPU_MEM` only when both GPUs have plenty of free memory. Optional: use one GPU:
#   export CUDA_VISIBLE_DEVICES=1 VLLM_TP=1
#
# Usage: bash scripts/wsl-vllm-serve.sh [extra vllm args...]
set -euo pipefail
VENV="${HOME}/vllm-openclaw"
export CUDA_DEVICE_ORDER="${CUDA_DEVICE_ORDER:-PCI_BUS_ID}"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0,1}"
MODEL="${VLLM_MODEL:-TinyLlama/TinyLlama-1.1B-Chat-v1.0}"
TP="${VLLM_TP:-2}"
# WSL often has less free VRAM than total (display + host); TP>1 needs headroom per GPU.
MEM="${VLLM_GPU_MEM:-}"
if [ -z "${MEM}" ]; then
  if [ "${TP}" = "1" ]; then
    MEM="0.88"
  else
    MEM="0.55"
  fi
fi
# shellcheck source=/dev/null
source "${VENV}/bin/activate"
exec vllm serve "${MODEL}" \
  --tensor-parallel-size "${TP}" \
  --host 0.0.0.0 \
  --port "${VLLM_PORT:-8000}" \
  --gpu-memory-utilization "${MEM}" \
  --max-model-len "${VLLM_MAX_LEN:-8192}" \
  --enforce-eager \
  --disable-custom-all-reduce \
  "$@"
