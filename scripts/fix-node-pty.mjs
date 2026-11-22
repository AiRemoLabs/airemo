// pnpm can extract node-pty's prebuilt `spawn-helper` without the executable bit,
// which makes every PTY spawn fail with "posix_spawnp failed". Restore it after install.
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const store = join(process.cwd(), "node_modules", ".pnpm");
if (!existsSync(store)) process.exit(0);

for (const dir of readdirSync(store).filter((d) => d.startsWith("node-pty@"))) {
  const prebuilds = join(store, dir, "node_modules", "node-pty", "prebuilds");
  if (!existsSync(prebuilds)) continue;
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
