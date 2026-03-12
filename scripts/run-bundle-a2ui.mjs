#!/usr/bin/env node
/**
 * A2UI bundle: hash inputs, run tsc + rolldown, write .bundle.hash.
 * Pure Node so it runs on Windows without Bash.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(scriptDir, "..");
const hashFile = path.join(rootDir, "src/canvas-host/a2ui/.bundle.hash");
const outputFile = path.join(rootDir, "src/canvas-host/a2ui/a2ui.bundle.js");
const a2uiRendererDir = path.join(rootDir, "vendor/a2ui/renderers/lit");
const a2uiAppDir = path.join(rootDir, "apps/shared/OpenClawKit/Tools/CanvasA2UI");

const inputPaths = [
  path.join(rootDir, "package.json"),
  path.join(rootDir, "pnpm-lock.yaml"),
  a2uiRendererDir,
  a2uiAppDir,
];

async function walk(entryPath, files) {
  const st = await stat(entryPath);
  if (st.isDirectory()) {
    for (const entry of await readdir(entryPath)) {
      await walk(path.join(entryPath, entry), files);
    }
    return;
  }
  files.push(entryPath);
}

function normalize(p) {
  return p.split(path.sep).join("/");
}

async function computeHash() {
  const files = [];
  for (const input of inputPaths) {
    await walk(input, files);
  }
  files.sort((a, b) => normalize(a).localeCompare(normalize(b)));
  const hash = createHash("sha256");
  for (const filePath of files) {
    const rel = normalize(path.relative(rootDir, filePath));
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: rootDir, stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`Command failed (exit ${r.status ?? 1}): ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

/** Run tsc using the repo's TypeScript binary (avoids pnpm exec issues on Windows). */
function runTsc(projectPath) {
  const tscBin = path.join(rootDir, "node_modules/typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tscBin, "-p", projectPath], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    console.error(`Command failed (exit ${r.status ?? 1}): tsc -p ${projectPath}`);
    process.exit(r.status ?? 1);
  }
}

async function main() {
  const rendererExists = await stat(a2uiRendererDir).then(() => true).catch(() => false);
  const appExists = await stat(a2uiAppDir).then(() => true).catch(() => false);
  const outputExists = await stat(outputFile).then(() => true).catch(() => false);

  if (!rendererExists || !appExists) {
    if (outputExists) {
      console.log("A2UI sources missing; keeping prebuilt bundle.");
      return;
    }
    console.error("A2UI sources missing and no prebuilt bundle found at:", outputFile);
    process.exit(1);
  }

  const currentHash = await computeHash();
  let previousHash = null;
  try {
    previousHash = (await readFile(hashFile, "utf8")).trim();
  } catch {
    // no previous hash
  }
  if (previousHash === currentHash && outputExists) {
    console.log("A2UI bundle up to date; skipping.");
    return;
  }

  // Use forward slashes for -p so tsc gets a consistent path on all platforms
  const tsconfigPath = path.join(a2uiRendererDir, "tsconfig.json").replace(/\\/g, "/");
  runTsc(tsconfigPath);

  // Use repo's rolldown binary and forward slashes (avoids pnpm exec issues on Windows)
  const rolldownBin = path.join(rootDir, "node_modules/rolldown/bin/cli.mjs");
  const rolldownConfig = path.join(a2uiAppDir, "rolldown.config.mjs").replace(/\\/g, "/");
  const rolldownR = spawnSync(process.execPath, [rolldownBin, "-c", rolldownConfig], {
    cwd: rootDir,
    stdio: "inherit",
  });
  if (rolldownR.status !== 0) {
    console.error(`rolldown failed (exit ${rolldownR.status ?? 1}). Check deps and try: pnpm canvas:a2ui:bundle`);
    process.exit(rolldownR.status ?? 1);
  }

  await writeFile(hashFile, currentHash, "utf8");
}

main().catch((err) => {
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error("If this persists, verify pnpm deps and try again.");
  console.error(err);
  process.exit(1);
});
