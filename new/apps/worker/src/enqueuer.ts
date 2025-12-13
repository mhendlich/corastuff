import http from "node:http";
import { cancelRunScraperJob, enqueueRunScraperJob, upsertRunScraperScheduler } from "@corastuff/queue";

const redisUrl = process.env.REDIS_URL ?? "redis://redis:6379";
const port = Number.parseInt(process.env.PORT ?? "4000", 10) || 4000;

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(data));
  res.end(data);
}

async function readJson(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error("Request body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/enqueue") {
      const payload = await readJson(req);
      const runId = (payload as { runId?: unknown }).runId;
      const sourceSlug = (payload as { sourceSlug?: unknown }).sourceSlug;
      const dryRun = (payload as { dryRun?: unknown }).dryRun;
      const configOverride = (payload as { configOverride?: unknown }).configOverride;
      if (
        (runId !== undefined && (typeof runId !== "string" || !runId.trim())) ||
        typeof sourceSlug !== "string" ||
        !sourceSlug.trim()
      ) {
        return sendJson(res, 400, {
          ok: false,
          error: "Expected JSON { sourceSlug: string, runId?: string, dryRun?: boolean, configOverride?: unknown }"
        });
      }

      const { queueJobId } = await enqueueRunScraperJob(redisUrl, {
        sourceSlug: sourceSlug.trim(),
        ...(typeof runId === "string" && runId.trim() ? { runId: runId.trim() } : {}),
        ...(dryRun === true ? { dryRun: true } : {}),
        ...(configOverride !== undefined ? { configOverride } : {})
      });

      return sendJson(res, 200, { ok: true, queueJobId });
    }

    if (req.method === "POST" && url.pathname === "/cancel") {
      const payload = await readJson(req);
      const queueJobId = (payload as { queueJobId?: unknown }).queueJobId;
      if (typeof queueJobId !== "string" || !queueJobId.trim()) {
        return sendJson(res, 400, {
          ok: false,
          error: "Expected JSON { queueJobId: string }"
        });
      }

      const result = await cancelRunScraperJob(redisUrl, queueJobId);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === "POST" && url.pathname === "/schedules/upsert") {
      const payload = await readJson(req);
      const sourceSlug = (payload as { sourceSlug?: unknown }).sourceSlug;
      const enabled = (payload as { enabled?: unknown }).enabled;
      const intervalMinutes = (payload as { intervalMinutes?: unknown }).intervalMinutes;
      if (typeof sourceSlug !== "string" || !sourceSlug.trim() || typeof enabled !== "boolean") {
        return sendJson(res, 400, {
          ok: false,
          error: "Expected JSON { sourceSlug: string, enabled: boolean, intervalMinutes?: number }"
        });
      }

      const result = await upsertRunScraperScheduler(redisUrl, {
        sourceSlug: sourceSlug.trim(),
        enabled,
        intervalMinutes: typeof intervalMinutes === "number" ? intervalMinutes : undefined,
        requestedBy: "scheduled"
      });

      return sendJson(res, 200, { ok: true, ...result });
    }

    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendJson(res, 500, { ok: false, error: message });
  }
});

server.listen(port, () => {
  console.log(`[enqueuer] listening on :${port} (redis: ${redisUrl})`);
});
