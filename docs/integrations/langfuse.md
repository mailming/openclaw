# Monitoring OpenClaw with Langfuse

[Langfuse](https://langfuse.com) is an open-source LLM engineering platform for tracing, evals, and debugging. You can use it to monitor all LLM calls made by OpenClaw (agent runs, model provider, tokens, latency) when using the optional Langfuse integration.

**Quick path:** See [Langfuse setup and test guide](/integrations/langfuse-setup-test) for a concise setup and verification walkthrough.

---

## Installation guide

Follow these steps to install and enable Langfuse monitoring for OpenClaw.

### Step 1: Install or access Langfuse

Choose one:

- **Option A – Self-hosted (Docker)**  
  Run Langfuse on your machine:
  ```bash
  git clone https://github.com/langfuse/langfuse.git
  cd langfuse
  docker compose up -d
  ```
  Wait 1–2 minutes, then open **http://localhost:3000**.

- **Option B – Langfuse Cloud**  
  Sign up at [cloud.langfuse.com](https://cloud.langfuse.com) and use the provided URL (e.g. `https://cloud.langfuse.com`).

### Step 2: Create a project and API keys in Langfuse

1. In the Langfuse UI, create or open a **Project**.
2. Go to **Project Settings** → **API Keys**.
3. Create an API key and copy the **Public Key** (`pk-lf-...`) and **Secret Key** (`sk-lf-...`).

### Step 3: Install OpenClaw dependencies

From the OpenClaw repo root:

```bash
cd /path/to/openclaw
pnpm install
```

This installs the optional Langfuse-related packages used by the integration. For full OpenTelemetry span export you can optionally add:

```bash
pnpm add -w @langfuse/otel @opentelemetry/sdk-node
```

**Windows:** If you use Conda, activate your environment first, then run the same commands:

```powershell
conda activate openclaw
pnpm install
pnpm add -w @langfuse/otel @opentelemetry/sdk-node   # optional
```

### Step 4: Configure environment variables

Set these so OpenClaw can send traces to Langfuse. Use a `.env` in the OpenClaw root or your config directory, or set them in your shell:

```bash
LANGFUSE_SECRET_KEY=sk-lf-...    # from Step 2
LANGFUSE_PUBLIC_KEY=pk-lf-...    # from Step 2
LANGFUSE_BASE_URL=http://localhost:3000   # only for self-hosted; omit for Cloud
```

For **Langfuse Cloud**, omit `LANGFUSE_BASE_URL` (or leave it unset).

### Step 5: Build and run OpenClaw

```bash
pnpm build
pnpm start
# or, for gateway-only dev: pnpm gateway:dev
```

**Windows (gateway dev):**

```powershell
$env:OPENCLAW_SKIP_CHANNELS="1"; $env:CLAWDBOT_SKIP_CHANNELS="1"; node scripts/run-node.mjs --dev gateway
```

### Step 6: Verify

Trigger an agent LLM call, for example:

```bash
openclaw agent --session-id langfuse-test --message "Say hello in one word"
```

Then open your Langfuse project → **Traces**. You should see a new trace with a **generation** (input, output, model, usage).

If nothing appears, check that `LANGFUSE_SECRET_KEY` is set where the OpenClaw process runs and that the gateway/model and API keys are configured.

---

## Prerequisites (reference)

- A Langfuse instance (e.g. [self-hosted with Docker](https://langfuse.com/self-hosting/local) or [Langfuse Cloud](https://cloud.langfuse.com))
- OpenClaw project built (`pnpm build`)

## 1. Get Langfuse credentials

1. Open your Langfuse UI (e.g. `http://localhost:3000` for self-hosted).
2. Sign up or log in, then create or open a **Project**.
3. Go to **Project Settings** → **API Keys**.
4. Create an API key and copy the **Public Key** (`pk-lf-...`) and **Secret Key** (`sk-lf-...`).

## 2. Install Langfuse packages (optional integration)

OpenClaw declares optional dependencies for Langfuse. From the OpenClaw repo root:

```bash
pnpm install
```

That installs `@langfuse/tracing` and `@opentelemetry/api`, which is enough for the integration to send generations to Langfuse. For optional OpenTelemetry span export to Langfuse, you can add:

```bash
pnpm add -w @langfuse/otel @opentelemetry/sdk-node
```

If you use a Conda environment (e.g. `openclaw`), activate it first, then run the install commands from the OpenClaw repo root:

```bash
conda activate openclaw
pnpm install
pnpm add -w @langfuse/otel @opentelemetry/sdk-node   # optional OTel span export
```

On Windows, the `pnpm gateway:dev` script uses Unix-style env vars; start the gateway instead with:

```powershell
$env:OPENCLAW_SKIP_CHANNELS="1"; $env:CLAWDBOT_SKIP_CHANNELS="1"; node scripts/run-node.mjs --dev gateway
```

## 3. Configure environment

Set these in your shell or in a `.env` file (e.g. in OpenClaw’s config directory or project root):

```bash
# Required for tracing to be sent to Langfuse
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_PUBLIC_KEY=pk-lf-...

# For self-hosted Langfuse (default is Langfuse Cloud)
LANGFUSE_BASE_URL=http://localhost:3000
```

Restart OpenClaw (or start it as usual, e.g. `openclaw gateway run` or `pnpm gateway:dev`). If the integration is enabled and these variables are set, each agent LLM call will create a **trace** and **generation** in Langfuse.

## 4. What gets traced

When the integration is enabled, for each LLM request OpenClaw sends to Langfuse:

- **Trace**: one per “run” (session/request context).
- **Generation**: one per provider call, with:
  - **Input**: messages sent to the model (system + conversation).
  - **Output**: final assistant message (text and/or tool calls).
  - **Model**: provider and model id (e.g. `openai/gpt-4o`, `anthropic/claude-3-5-sonnet`).
  - **Usage**: input/output (and optionally cache) token counts when available.
  - **Latency**: start/end timestamps.

You can then in Langfuse:

- Inspect prompts and responses.
- Debug errors and slow calls.
- Compare models and prompts.
- Use evals and scores (via Langfuse UI or API).

## 5. Enabling the integration in OpenClaw

OpenClaw includes an **optional** Langfuse integration in `src/agents/langfuse-tracing.ts`, wired in the Pi embedded runner (`src/agents/pi-embedded-runner/run/attempt.ts`). It is active when:

1. **`@langfuse/tracing`** is installed (via `pnpm install` optional deps or manual install), and  
2. **`LANGFUSE_SECRET_KEY`** is set in the environment (e.g. in `.env`). Optionally set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_BASE_URL` for your Langfuse instance (default is Langfuse Cloud).

No code changes are required: install the packages, set the env vars, and restart OpenClaw. Each agent LLM call will then be reported to Langfuse as a generation.

### Testing the integration

The `openclaw agent` command **requires** one of `--to`, `--session-id`, or `--agent` to choose a session. Without it you get: *"Pass --to \<E.164\>, --session-id, or --agent to choose a session"*.

Use one of these patterns to trigger an LLM call and see a generation in Langfuse:

```bash
# Use a configured agent (list with: openclaw agents list)
openclaw agent --agent default --message "Say hello in one word"

# Use an explicit session id for a one-off run
openclaw agent --session-id langfuse-test --message "Say hello in one word"

# Use a recipient number (E.164) if you have routing set up
openclaw agent --to +15555550123 --message "Say hello in one word"
```

Ensure the gateway is running (e.g. `openclaw gateway run`) and you have a model/API key configured. Then check your Langfuse project for the new trace/generation.

## 6. Alternative: manual instrumentation

If you prefer not to use the built-in integration, you can instrument OpenClaw yourself:

1. In your own code that starts the process, before any agent code runs:
   - Install `@langfuse/tracing`, `@langfuse/otel`, `@opentelemetry/sdk-node`.
   - Start the Node SDK with `LangfuseSpanProcessor` and set `LANGFUSE_*` env vars.
2. Use Langfuse’s [TypeScript SDK](https://langfuse.com/docs/sdk/typescript) to create traces/generations around the code paths that call the LLM (e.g. where `streamFn` or `streamSimple` is invoked), and record input, output, model, and usage.

This gives you full control over what is traced and how.

## 7. Self-hosted Langfuse (Docker)

To run Langfuse locally on the same machine as OpenClaw:

```bash
git clone https://github.com/langfuse/langfuse.git
cd langfuse
docker compose up -d
```

After 1–2 minutes, open `http://localhost:3000`, create a project and API keys, then set `LANGFUSE_BASE_URL=http://localhost:3000` and the keys as in step 3.

## References

- [Langfuse self-hosting (local)](https://langfuse.com/self-hosting/local)
- [Langfuse TypeScript SDK](https://langfuse.com/docs/sdk/typescript)
- [Langfuse observability concepts](https://langfuse.com/docs/observability/data-model)
