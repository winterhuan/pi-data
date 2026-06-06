import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../session.ts";
import { listArtifacts, listBible } from "../workspace.ts";

if (process.env.WORKBENCH_REAL_PI_SMOKE !== "1") {
  console.log("Skipping real Pi smoke. Set WORKBENCH_REAL_PI_SMOKE=1 to run it.");
  process.exit(0);
}

const tmp = await mkdtemp(join(tmpdir(), "workbench-real-smoke-"));
process.env.WORKBENCH_WORKSPACE = tmp;
const project = `real-smoke-${Date.now()}`;
const store = new SessionStore();

try {
  const session = await store.create(project, "create");
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("smoke timed out waiting for agent_end")), 180_000);
    const unsub = session.session.subscribe((event) => {
      if (event.type === "agent_end") {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });

  await session.session.prompt(
    `在项目 ${project} 中调用 save_bible 保存一个 character 条目，再调用 save_artifact 保存 smoke.md，内容写“smoke ok”。`,
  );
  await done;

  const artifacts = await listArtifacts(project);
  const bible = await listBible(project);
  if (!artifacts.includes("smoke.md")) throw new Error("save_artifact did not create smoke.md");
  if (!bible.length) throw new Error("save_bible did not create a bible entry");
  console.log(`real Pi smoke passed: ${project}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
