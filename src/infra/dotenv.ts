import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveConfigDir } from "../utils.js";

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // 1) Optional explicit .env path (e.g. OPENCLAW_DOTENV_PATH=/path/to/.env). Load first so CWD/shell can override.
  const explicitPath = process.env.OPENCLAW_DOTENV_PATH?.trim();
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (fs.existsSync(resolved)) {
      dotenv.config({ quiet, path: resolved, override: false });
    }
  }

  // 2) Load from process CWD (e.g. project root .env).
  dotenv.config({ quiet });

  // 3) Global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env), without overriding.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  dotenv.config({ quiet, path: globalEnvPath, override: false });
}
