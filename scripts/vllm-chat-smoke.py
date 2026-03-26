#!/usr/bin/env python3
"""One-off chat completion against local vLLM (OpenAI-compatible).

Usage:
  python3 scripts/vllm-chat-smoke.py
  python3 scripts/vllm-chat-smoke.py http://127.0.0.1:8000/v1/chat/completions
  python3 scripts/vllm-chat-smoke.py http://127.0.0.1:8000/v1/chat/completions Qwen/Qwen2.5-14B-Instruct-AWQ
  VLLM_SMOKE_MODEL=Qwen/Qwen2.5-14B-Instruct-AWQ python3 scripts/vllm-chat-smoke.py
"""
import json
import os
import sys
import urllib.request

def main() -> None:
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/v1/chat/completions"
    model = (
        sys.argv[2]
        if len(sys.argv) > 2
        else os.environ.get("VLLM_SMOKE_MODEL", "TinyLlama/TinyLlama-1.1B-Chat-v1.0")
    )
    body = {
        "model": model,
        "messages": [{"role": "user", "content": "Say hi in 3 words."}],
        "max_tokens": 32,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        sys.stdout.write(resp.read().decode())

if __name__ == "__main__":
    main()
