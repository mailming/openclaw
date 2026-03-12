# Langfuse setup and test guide

Quick setup and verification for the [Langfuse](/integrations/langfuse) integration with OpenClaw.

## Setup

### 1. Prerequisites

- Langfuse instance: [Langfuse Cloud](https://cloud.langfuse.com) or [self-hosted](https://langfuse.com/self-hosting/local)
- OpenClaw repo with dependencies installed: `pnpm install`
- Built project: `pnpm build`

### 2. Get API keys

1. Open your Langfuse UI (e.g. `http://localhost:3000` for self-hosted, or Cloud).
2. Create or open a **Project** → **Project Settings** → **API Keys**.
3. Create an API key and copy the **Public Key** (`pk-lf-...`) and **Secret Key** (`sk-lf-...`).

### 3. Install optional Langfuse packages

From the OpenClaw repo root:

```bash
pnpm install
```

This installs `@langfuse/tracing` (and `@opentelemetry/api`) so generations are sent to Langfuse. Optional OpenTelemetry span export:

```bash
pnpm add -w @langfuse/otel @opentelemetry/sdk-node
```

### 4. Configure environment

In `.env` (project root or `~/.openclaw/.env`) or your shell:

```bash
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_PUBLIC_KEY=pk-lf-...
# For self-hosted only:
LANGFUSE_BASE_URL=http://localhost:3000
```

Restart OpenClaw (gateway or CLI) so it picks up the variables.

### 5. Ensure a model is configured

You need at least one provider and model (e.g. OpenAI or Anthropic). Configure via `openclaw config` or env vars such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

---

## Test

### 1. Start the gateway (if using agent over channels)

```bash
openclaw gateway run
```

Or for dev with minimal channels (e.g. on Windows):

```powershell
$env:OPENCLAW_SKIP_CHANNELS="1"; $env:CLAWDBOT_SKIP_CHANNELS="1"; node scripts/run-node.mjs --dev gateway
```

### 2. Trigger an LLM call

Use one of these (you must pass `--to`, `--session-id`, or `--agent`):

```bash
# One-off session (no prior agent needed)
openclaw agent --session-id langfuse-test --message "Say hello in one word"

# Named agent (list with: openclaw agents list)
openclaw agent --agent default --message "Say hello in one word"
```

### 3. Verify in Langfuse

1. Open your Langfuse project (e.g. `http://localhost:3000` or Cloud).
2. Go to **Traces** (or **Generations**).
3. You should see a new trace with a generation: input messages, output, model id, and usage/latency.

If nothing appears:

- Confirm `LANGFUSE_SECRET_KEY` is set and the process was restarted after adding it.
- Confirm `@langfuse/tracing` is installed: `pnpm list @langfuse/tracing`.
- Check that the agent command succeeded (model and API key configured).
- For self-hosted, ensure `LANGFUSE_BASE_URL` matches your Langfuse URL.

---

## Troubleshooting

| Issue | Check |
|-------|--------|
| No traces in Langfuse | `LANGFUSE_SECRET_KEY` set? Process restarted? `openclaw agent` completed without error? |
| `[Langfuse SDK] TypeError: Cannot read properties of undefined (reading 'name')` | Caused by undefined in payload; OpenClaw sanitizes inputs. Update to a build that includes the fix; traces still record. |
| "Pass --to, --session-id, or --agent" | Add e.g. `--session-id langfuse-test` to the `openclaw agent` command. |
| Agent fails (no model) | Set a provider API key (e.g. `OPENAI_API_KEY`) and ensure a model is selected in config. |
| Self-hosted not receiving | `LANGFUSE_BASE_URL` set to your instance (e.g. `http://localhost:3000`)? |

For full reference and self-hosted Docker steps, see [Monitoring OpenClaw with Langfuse](/integrations/langfuse).
