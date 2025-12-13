import { randomUUID } from "node:crypto";
import { enqueueRunScraperJob } from "@corastuff/queue";

async function main() {
  const sourceSlug = process.argv[2];
  if (!sourceSlug) {
    console.error("Usage: node dist/enqueue.js <sourceSlug> [runId]");
    process.exit(2);
  }

  const runId = process.argv[3] ?? randomUUID();
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

  const { queueJobId } = await enqueueRunScraperJob(redisUrl, { runId, sourceSlug });
  console.log(JSON.stringify({ ok: true, sourceSlug, runId, queueJobId }, null, 2));
}

main().catch((err) => {
  console.error("[enqueue] fatal:", err);
  process.exit(1);
});

