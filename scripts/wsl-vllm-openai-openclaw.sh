#!/usr/bin/env bash
# WSL: OpenAI-compatible vLLM server for OpenClaw with multi-GPU tensor parallelism.
# Default uses both GPUs (TP=2). Override with VLLM_TP=1 and CUDA_VISIBLE_DEVICES=0.
#
# Prereq: `~/vllm-openclaw` venv (see `scripts/wsl-vllm-serve.sh`).
# WSL2: TP>1 may need lower `--gpu-memory-utilization` than single-GPU; this script
# defaults to 0.55 when TP>1 (raise `VLLM_GPU_MEM` if both GPUs have plenty of free VRAM).
#
# Usage:
#   bash scripts/wsl-vllm-openai-openclaw.sh
#   VLLM_TP=2 VLLM_GPU_MEM=0.75 bash scripts/wsl-vllm-openai-openclaw.sh
#
# Docs: `docs/providers/vllm.md`
set -euo pipefail
VENV="${HOME}/vllm-openclaw"
export CUDA_DEVICE_ORDER="${CUDA_DEVICE_ORDER:-PCI_BUS_ID}"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0,1}"
TP="${VLLM_TP:-2}"
MODEL="${VLLM_MODEL:-Qwen/Qwen2.5-14B-Instruct-AWQ}"
MEM="${VLLM_GPU_MEM:-}"
if [ -z "${MEM}" ]; then
  if [ "${TP}" = "1" ]; then
    MEM="0.9"
  else
    MEM="0.55"
  fi
fi
PORT="${VLLM_PORT:-8000}"
MAX_LEN="${VLLM_MAX_LEN:-32768}"
# shellcheck source=/dev/null
source "${VENV}/bin/activate"
exec python -m vllm.entrypoints.openai.api_server \
  --model "${MODEL}" \
  --quantization awq_marlin \
  --tensor-parallel-size "${TP}" \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --gpu-memory-utilization "${MEM}" \
  --max-model-len "${MAX_LEN}" \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  "$@"
