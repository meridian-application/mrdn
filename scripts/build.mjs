import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, loadConfigFromFile, mergeConfig } from "vite";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tscPath = resolve(rootDir, "node_modules/typescript/bin/tsc");
const distDir = resolve(rootDir, "dist");

const tscRun = spawnSync(process.execPath, [tscPath], {
  cwd: rootDir,
  stdio: "inherit",
  env: process.env,
});

if (tscRun.status !== 0) {
  process.exit(tscRun.status ?? 1);
}

const loadedConfig = await loadConfigFromFile(
  { command: "build", mode: process.env.NODE_ENV ?? "production" },
  resolve(rootDir, "vite.config.ts"),
);

const inlineConfig = mergeConfig(loadedConfig?.config ?? {}, {
  root: rootDir,
  configFile: false,
  build: {
    write: false,
    emptyOutDir: false,
    reportCompressedSize: false,
    minify: false,
    cssMinify: false,
  },
});

const result = await build(inlineConfig);
const outputs = Array.isArray(result)
  ? result.flatMap((chunk) => chunk.output ?? [])
  : (result.output ?? []);

rmSync(distDir, { recursive: true, force: true });

for (const output of outputs) {
  const targetPath = resolve(distDir, output.fileName);
  mkdirSync(dirname(targetPath), { recursive: true });

  if (output.type === "asset") {
    const assetSource =
      typeof output.source === "string" ? output.source : Buffer.from(output.source);
    writeFileSync(targetPath, assetSource);
    continue;
  }

  writeFileSync(targetPath, output.code);

  if (output.map) {
    const sourceMap =
      typeof output.map === "string"
        ? output.map
        : JSON.stringify(output.map, null, 2);
    writeFileSync(`${targetPath}.map`, sourceMap);
  }
}

// Copy public directory to dist
const publicDir = resolve(rootDir, "public");
cpSync(publicDir, distDir, { recursive: true });

console.log(`Built ${outputs.length} files to ${distDir}`);
