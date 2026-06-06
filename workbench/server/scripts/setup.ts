import { checkWorkbench, ensureWorkbenchExtensionSymlink, installedExtensionPath } from "../diagnostics.ts";

await ensureWorkbenchExtensionSymlink();
console.log(`extension linked: ${installedExtensionPath()}`);

const health = await checkWorkbench({ skipPort: true });
for (const check of health.checks) {
  const mark = check.status === "ok" ? "OK" : check.status.toUpperCase();
  console.log(`[${mark}] ${check.name}: ${check.message}`);
  if (check.fix) console.log(`      fix: ${check.fix}`);
}

if (!health.ok) process.exit(1);
