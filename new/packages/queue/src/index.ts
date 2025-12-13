import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

export const SCRAPE_QUEUE_NAME = "scrape" as const;
export const RUN_SCRAPER_JOB_NAME = "runScraper" as const;

export type RunScraperJobData = {
  sourceSlug: string;
  runId?: string;
  requestedBy?: string;
};

export function createRedisConnection(redisUrl: string) {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export async function enqueueRunScraperJob(
  redisUrl: string,
  data: RunScraperJobData,
  options?: JobsOptions
) {
  const connection = createRedisConnection(redisUrl);
  const queue = new Queue<RunScraperJobData>(SCRAPE_QUEUE_NAME, { connection });
  try {
    const job = await queue.add(RUN_SCRAPER_JOB_NAME, data, {
      removeOnComplete: true,
      removeOnFail: false,
      ...options
    });
    return { queueJobId: job.id ?? null };
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

export async function cancelRunScraperJob(redisUrl: string, queueJobId: string) {
  const jobId = queueJobId.trim();
  if (!jobId) {
    throw new Error("queueJobId is required");
  }

  const connection = createRedisConnection(redisUrl);
  const queue = new Queue<RunScraperJobData>(SCRAPE_QUEUE_NAME, { connection });
  try {
    const job = await queue.getJob(jobId);
    if (!job) {
      return { removed: false, reason: "not_found" as const };
    }

    try {
      await job.remove();
      return { removed: true, reason: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { removed: false, reason: message };
    }
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

export const RUN_SCRAPER_SCHEDULER_PREFIX = "runScraper:" as const;

export function runScraperSchedulerId(sourceSlug: string) {
  return `${RUN_SCRAPER_SCHEDULER_PREFIX}${sourceSlug}`;
}

export async function getRunScraperScheduler(redisUrl: string, sourceSlugRaw: string) {
  const sourceSlug = sourceSlugRaw.trim();
  if (!sourceSlug) {
    throw new Error("sourceSlug is required");
  }

  const schedulerId = runScraperSchedulerId(sourceSlug);
  const connection = createRedisConnection(redisUrl);
  const queue = new Queue<RunScraperJobData>(SCRAPE_QUEUE_NAME, { connection });
  try {
    const scheduler = await queue.getJobScheduler(schedulerId);
    return { schedulerId, exists: Boolean(scheduler), nextRunAt: scheduler?.next ?? null };
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

export async function upsertRunScraperScheduler(
  redisUrl: string,
  args: {
    sourceSlug: string;
    enabled: boolean;
    intervalMinutes?: number;
    requestedBy?: string;
  }
) {
  const sourceSlug = args.sourceSlug.trim();
  if (!sourceSlug) {
    throw new Error("sourceSlug is required");
  }

  const schedulerId = runScraperSchedulerId(sourceSlug);
  const connection = createRedisConnection(redisUrl);
  const queue = new Queue<RunScraperJobData>(SCRAPE_QUEUE_NAME, { connection });

  try {
    if (!args.enabled) {
      const removed = await queue.removeJobScheduler(schedulerId);
      return { schedulerId, removed, nextRunAt: null as number | null };
    }

    const intervalMinutes = args.intervalMinutes;
    if (!Number.isFinite(intervalMinutes) || (intervalMinutes as number) <= 0) {
      throw new Error("intervalMinutes must be a positive number when enabled");
    }

    const every = Math.round((intervalMinutes as number) * 60_000);
    await queue.upsertJobScheduler(
      schedulerId,
      { every },
      {
        name: RUN_SCRAPER_JOB_NAME,
        data: {
          sourceSlug,
          requestedBy: args.requestedBy
        },
        opts: {
          removeOnComplete: true,
          removeOnFail: false
        }
      }
    );

    const scheduler = await queue.getJobScheduler(schedulerId);
    return { schedulerId, removed: false, nextRunAt: scheduler?.next ?? null };
  } finally {
    await queue.close();
    connection.disconnect();
  }
}
