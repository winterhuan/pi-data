import { checkWorkbench } from "../diagnostics.ts";

const port = Number(process.env.PORT ?? 7777);
const health = await checkWorkbench({ port });

for (const check of health.checks) {
  const mark = check.status === "ok" ? "OK" : check.status.toUpperCase();
  console.log(`[${mark}] ${check.name}: ${check.message}`);
  if (check.fix) console.log(`      fix: ${check.fix}`);
}

console.log(`workspace: ${health.workspace}`);
console.log(`extension: ${health.extensionPath}`);
console.log(`expected:  ${health.expectedExtensionTarget}`);

if (!health.ok) process.exit(1);
