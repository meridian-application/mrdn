import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(rootDir, "vk-hosting-config.json");
const deployBin = resolve(
  rootDir,
  "node_modules/@vkontakte/vk-miniapps-deploy/bin/vk-miniapps-deploy",
);

const deployMode = process.argv[2] ?? "dev";
const shouldUpdateDev = deployMode === "dev" || deployMode === "all";
const shouldUpdateProd = deployMode === "production" || deployMode === "all";

if (!shouldUpdateDev && !shouldUpdateProd) {
  console.error(`Unknown deploy mode: ${deployMode}`);
  process.exit(1);
}

const originalConfig = readFileSync(configPath, "utf8");
const parsedConfig = JSON.parse(originalConfig);
const nextConfig = {
  ...parsedConfig,
  noprompt: true,
  update_dev: shouldUpdateDev,
  update_prod: shouldUpdateProd,
};

writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);

try {
  const env = {
    ...process.env,
    READABLE_STREAM: "disable",
  };

  if (deployMode !== "all") {
    env.MINI_APPS_ENVIRONMENT = deployMode;
  }

  const result = spawnSync(process.execPath, [deployBin], {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
} finally {
  writeFileSync(configPath, originalConfig);
}
