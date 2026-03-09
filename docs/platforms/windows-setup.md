---
summary: "Set up OpenClaw on a Windows PC and run or test the local version as a developer"
read_when:
  - Setting up OpenClaw on native Windows (not WSL2)
  - Running or testing OpenClaw from a local clone on Windows
title: "Windows setup and developer run"
---

# Windows setup and developer run

This guide covers setting up OpenClaw on a **native Windows PC** (PowerShell) and how to **run and test** the CLI and gateway from a local checkout. For running the Gateway inside Linux, see [Windows (WSL2)](/platforms/windows) instead.

## Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org) or via winget/Chocolatey/Scoop
- **pnpm** — `npm install -g pnpm` (recommended for source builds)
- **Git for Windows** — [git-scm.com/download/win](https://git-scm.com/download/win); ensure `git` is on your PATH

Check versions:

```powershell
node --version   # v22.x or newer
pnpm --version
git --version
```

## Option A: Install via PowerShell (recommended for users)

Run the official installer (installs Node if needed, then OpenClaw via npm or git):

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

Or with explicit options:

```powershell
# Default: npm global install + optional onboarding
iwr -useb https://openclaw.ai/install.ps1 | iex

# Install from git (clone, pnpm install, build, wrapper in %USERPROFILE%\.local\bin)
& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -InstallMethod git

# Skip onboarding
& ([scriptblock]::Create((irm -useb https://openclaw.ai/install.ps1))) -NoOnboard
```

After install, if `openclaw` is not found, add the global npm bin directory to your user PATH. Typically: `%AppData%\npm` (no `\bin` suffix on Windows). See [FAQ: Windows install](/help/faq#windows-install-says-git-not-found-or-openclaw-not-recognized).

## Option B: Set up from source (developers)

1. **Clone and install dependencies**

   ```powershell
   git clone https://github.com/openclaw/openclaw.git
   cd openclaw
   pnpm install
   ```

2. **Build**

   ```powershell
   pnpm build
   ```

   Optional: build the web UI (needed for dashboard/control UI): `pnpm ui:build` (installs UI deps on first run).

3. **Run onboarding (no sudo required)**

   From the repo you can run the CLI via pnpm; sudo is not needed for normal use:

   ```powershell
   pnpm openclaw onboard
   ```

   If you see "Sudo is disabled on this machine", you can either:

   - Ignore it and run **without** sudo: `pnpm openclaw onboard` (recommended when developing from source), or
   - Enable Windows sudo: **Settings → System → For developers** → turn on **Enable sudo** (and optionally **Enable sudo to run as administrator**).

4. **Open the dashboard**

   ```powershell
   pnpm openclaw dashboard
   ```

   Keep that browser tab to control OpenClaw. See [Dashboard](/web/dashboard) and [Control UI](/web/control-ui).

## Optional: Enable Windows sudo

If you want to use `sudo` in PowerShell (e.g. `sudo pnpm openclaw onboard`):

1. Open **Settings** (Win + I).
2. Go to **System** → **For developers**.
3. Turn on **Enable sudo** (and optionally **Enable sudo to run as administrator**).

For day-to-day development from a clone, running `pnpm openclaw ...` without sudo is sufficient.

## Run and test the local version (developers)

Use these steps to run and test OpenClaw from your local checkout on Windows.

### One-time setup

```powershell
cd openclaw
pnpm install
pnpm build
```

Optional: `pnpm ui:build` for dashboard/control UI assets.

### Run the CLI

From the repo root, use the `openclaw` script so the local build is used:

```powershell
pnpm openclaw --help
pnpm openclaw status
pnpm openclaw onboard
pnpm openclaw dashboard
```

Alternatively, `pnpm dev` runs the dev entry; then in the same environment you can run `openclaw` if it is on PATH (e.g. after a global install).

### Run the gateway

Foreground (for debugging or quick tests):

```powershell
pnpm openclaw gateway run
```

Or with port:

```powershell
pnpm openclaw gateway run --port 18789
```

Then open the Control UI at `http://127.0.0.1:18789/` or run `pnpm openclaw dashboard`.

To install the Gateway as a Windows service (scheduled task), see [Gateway](/gateway) and [Gateway configuration](/gateway/configuration). Restarting after closing the terminal: [FAQ — I closed my terminal on Windows](/help/faq#i-closed-my-terminal-on-windows-how-do-i-restart-openclaw).

### Type-check and build

```powershell
pnpm tsgo      # TypeScript check
pnpm build     # Full build (CLI + gateway + plugin-sdk, etc.)
```

### Lint and format

```powershell
pnpm check       # Lint + format check
pnpm format:fix  # Apply formatting (oxfmt)
```

### Run tests

```powershell
pnpm test              # Core unit tests (fast)
pnpm test:coverage     # With V8 coverage (70% thresholds)
pnpm test:force        # Kill lingering gateway on default port, then run tests
```

For gateway integration tests: `OPENCLAW_TEST_INCLUDE_GATEWAY=1 pnpm test` or `pnpm test:gateway`. For full test details and live/Docker options, see [Tests](/reference/test) and [Testing](/help/testing).

### Local PR gate

Before pushing, run:

```powershell
pnpm check
pnpm build
pnpm test
pnpm check:docs
```

If tests are flaky on a busy machine, use:

```powershell
$env:OPENCLAW_TEST_PROFILE="low"; $env:OPENCLAW_TEST_SERIAL_GATEWAY="1"; pnpm test
```

## Summary

| Goal                    | Command or step |
| ------------------------ | ----------------- |
| Install (user)           | `irm https://openclaw.ai/install.ps1 \| iex` |
| From source              | `git clone` → `pnpm install` → `pnpm build` |
| Onboarding (no sudo)     | `pnpm openclaw onboard` |
| Run CLI (from repo)      | `pnpm openclaw <command>` |
| Run gateway (foreground) | `pnpm openclaw gateway run` |
| Open UI                  | `pnpm openclaw dashboard` or `http://127.0.0.1:18789/` |
| Tests                    | `pnpm test`; coverage: `pnpm test:coverage` |
| Full check before PR     | `pnpm check` → `pnpm build` → `pnpm test` → `pnpm check:docs` |

Related: [Getting Started](/start/getting-started), [Installer internals](/install/installer), [Windows (WSL2)](/platforms/windows), [Gateway](/gateway).
