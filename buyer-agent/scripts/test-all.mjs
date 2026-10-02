import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
const buyer = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(buyer, ".."),
  npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this gate with npm run test:all");
const env = {
  ...process.env,
  ANCHOR_PROVIDER_URL: process.env.ROLE_C_RPC_URL,
  ANCHOR_WALLET: process.env.ROLE_C_BUYER_KEYPAIR_PATH,
};
if (process.platform === "win32" && existsSync("C:/msys64/mingw64/bin")) {
  const taskPath = process.env.PATH ?? process.env.Path ?? "";
  delete env.Path;
  env.PATH = `C:/msys64/mingw64/bin;${taskPath}`;
}
function run(command, args, cwd = buyer) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    process.stderr.write(result.error.message + "\n");
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const name of [
  "build",
  "build:runtime",
  "test:unit",
  "test:integration",
  "test:e2e",
  "test:sandbox",
  "test:web",
  "format:check",
])
  run(process.execPath, [npm, "run", name]);
const cargo =
  process.env.SETRA_CARGO_PATH ??
  (process.platform === "win32"
    ? join(process.env.USERPROFILE ?? "", ".cargo/bin/cargo.exe")
    : "cargo");
run(
  cargo,
  ["test", "--manifest-path", join(root, "seller-server/Cargo.toml")],
  root
);
run(
  process.execPath,
  [
    join(root, "node_modules/ts-mocha/bin/ts-mocha"),
    "-p",
    join(root, "tsconfig.json"),
    "-t",
    "1000000",
    join(root, "tests/setra402.ts"),
  ],
  root
);
run("git", ["diff", "--check"], root);
process.stdout.write(
  "All disjoint Phase 3 regression suites and quality gates passed.\n"
);
