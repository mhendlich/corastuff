import { makeFunctionReference } from "convex/server";
import type { RunStatus, SourceType, StoredImage } from "@corastuff/shared";

export type SessionInfo = {
  kind: "user" | "service";
  label: string | null;
  expiresAt: number;
};

export type LoginResult = {
  ok: boolean;
  sessionToken: string;
  kind: "user" | "service";
  label: string | null;
  expiresAt: number;
};

export type SourceDoc = {
  _id: string;
  _creationTime: number;
  slug: string;
  displayName: string;
  enabled: boolean;
  type: SourceType;
  config: unknown;
  lastSuccessfulRunId?: string | undefined;
  lastSuccessfulAt?: number | undefined;
};

export type RunDoc = {
  _id: string;
  _creationTime: number;
  sourceSlug: string;
  status: RunStatus;
  requestedBy?: string | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  productsFound?: number | undefined;
  error?: string | undefined;
  cancelRequested?: boolean | undefined;
  job?: unknown;
};

export type RunEventDoc = {
  _id: string;
  _creationTime: number;
  runId: string;
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  type: "log" | "progress" | "metric" | "checkpoint";
  payload: unknown;
};

export type RunArtifactDoc = {
  _id: string;
  _creationTime: number;
  runId: string;
  key: string;
  type: "log" | "json" | "html" | "screenshot" | "other";
  path: string;
  createdAt: number;
  updatedAt: number;
};

export type ProductLatestDoc = {
  _id: string;
  _creationTime: number;
  sourceSlug: string;
  itemId: string;
  name: string;
  url?: string | undefined;
  currency?: (string | null) | undefined;
  lastPrice?: (number | null) | undefined;
  prevPrice?: number | undefined;
  prevPriceAt?: number | undefined;
  priceChange?: number | undefined;
  priceChangePct?: number | undefined;
  streakKind?: ("drop" | "rise" | null) | undefined;
  streakTrendPct?: (number | null) | undefined;
  streakPrices?: (number[] | null) | undefined;
  firstSeenAt?: number | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  minPrevPrice?: number | undefined;
  maxPrevPrice?: number | undefined;
  lastSeenAt: number;
  lastSeenRunId?: string | undefined;
  image?: StoredImage | undefined;
  updatedAt: number;
};

export type ScheduleDoc = {
  _id: string;
  _creationTime: number;
  sourceSlug: string;
  enabled: boolean;
  intervalMinutes: number;
  nextRunAt?: number | undefined;
  updatedAt: number;
};

export type PricePointDoc = {
  _id: string;
  _creationTime: number;
  sourceSlug: string;
  itemId: string;
  ts: number;
  price: number;
  currency: string;
  runId?: string | undefined;
};

export type CanonicalDoc = {
  _id: string;
  _creationTime: number;
  name: string;
  description?: string | undefined;
  createdAt: number;
  updatedAt: number;
};

export type CanonicalLinkInfo = {
  canonical: CanonicalDoc;
  linkCount: number;
  sourcesPreview: Array<{ sourceSlug: string; displayName: string }>;
};

export type CanonicalDetail = {
  canonical: CanonicalDoc;
  linkCount: number;
  bestKey: string | null;
  linkedProducts: Array<{
    sourceSlug: string;
    sourceDisplayName: string;
    itemId: string;
    name: string | null;
    price: number | null;
    currency: string | null;
    url: string | null;
    lastSeenAt: number | null;
    seenInLatestRun: boolean;
  }>;
} | null;

export type ProductLinkDoc = {
  _id: string;
  _creationTime: number;
  canonicalId: string;
  sourceSlug: string;
  itemId: string;
  createdAt: number;
};

export type LinkForProduct = {
  link: ProductLinkDoc;
  canonical: CanonicalDoc | null;
} | null;

export type LinkCountsBySource = {
  sourceSlug: string;
  totalProducts: number;
  linked: number;
  unlinked: number;
  truncated: boolean;
};

export type ResetAllResult = {
  ok: boolean;
  deleted: Record<
    | "runEvents"
    | "runArtifacts"
    | "pricePoints"
    | "productLinks"
    | "canonicalProducts"
    | "productsLatest"
    | "runs"
    | "schedules",
    number
  >;
  queueSchedulersRemoved: number;
  scheduleRowsSeen: number;
};

export type BackfillProductsLatestLastSeenRunIdResult = {
  ok: boolean;
  dryRun: boolean;
  done: boolean;
  batches: number;
  scanned: number;
  patched: number;
  alreadySet: number;
  missingSourceRunId: number;
};

export type RunsRequestAllResult = {
  ok: boolean;
  results: Array<{
    sourceSlug: string;
    ok: boolean;
    runId?: string;
    queueJobId?: string | null;
    skipped?: "disabled" | "active";
    error?: string;
  }>;
};

export type DashboardStats = {
  sources: number;
  canonicalProducts: number;
  linkedProducts: number;
  unlinkedProducts: number;
  totalProducts: number;
};

export type SourceLastScrape = {
  sourceSlug: string;
  displayName: string;
  enabled: boolean;
  lastRunId: string | null;
  lastRunStatus: RunStatus | null;
  lastRunAt: number | null;
  lastRunStartedAt: number | null;
  lastRunCompletedAt: number | null;
};

export type InsightsMover = {
  sourceSlug: string;
  sourceDisplayName: string;
  itemId: string;
  name: string;
  price: number;
  currency: string | null;
  prevPrice: number | null;
  changeAbs: number | null;
  changePct: number | null;
  lastSeenAt: number;
  url: string | null;
};

export type InsightsExtreme = {
  sourceSlug: string;
  sourceDisplayName: string;
  itemId: string;
  name: string;
  price: number;
  currency: string | null;
  prevExtremePrice: number | null;
  extremePrice: number | null;
  changePct: number | null;
  firstSeenAt: number | null;
  lastSeenAt: number;
  url: string | null;
};

export type InsightsOutlier = {
  canonicalId: string;
  canonicalName: string | null;
  currency: string;
  medianPrice: number;
  deviationPct: number;
  sourceSlug: string;
  sourceDisplayName: string;
  itemId: string;
  name: string;
  price: number;
  lastSeenAt: number;
  url: string | null;
};

export type InsightsStreakTrend = {
  sourceSlug: string;
  sourceDisplayName: string;
  itemId: string;
  name: string;
  price: number;
  currency: string | null;
  trendPct: number;
  prices: number[];
  lastSeenAt: number;
  url: string | null;
};

export type InsightsSourceCoverage = {
  sourceSlug: string;
  displayName: string;
  enabled: boolean;
  totalProducts: number;
  unlinkedProducts: number;
  missingPrices: number;
  coveragePct: number;
  lastSeenAt: number | null;
};

export type InsightsCanonicalCoverageGap = {
  canonicalId: string;
  name: string;
  createdAt: number;
  linkCount: number;
  firstLinkedAt: number | null;
  lastLinkedAt: number | null;
};

export type InsightsStaleSource = {
  sourceSlug: string;
  displayName: string;
  enabled: boolean;
  lastSuccessfulAt: number | null;
};

export type InsightsFailure = {
  runId: string;
  sourceSlug: string;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
};

export type InsightsSnapshot = {
  generatedAt: number;
  summary: {
    recentDrops: number;
    recentSpikes: number;
    newExtremes: number;
    outliers: number;
    staleSources: number;
    recentFailures: number;
  };
  movers: {
    drops: InsightsMover[];
    spikes: InsightsMover[];
  };
  streakTrends: {
    sustainedDrops: InsightsStreakTrend[];
    sustainedRises: InsightsStreakTrend[];
  };
  extremes: {
    newLows: InsightsExtreme[];
    newHighs: InsightsExtreme[];
  };
  outliers: InsightsOutlier[];
  coverage: {
    sources: InsightsSourceCoverage[];
    canonicalGaps: InsightsCanonicalCoverageGap[];
    totals: {
      unlinkedProducts: number;
      missingPrices: number;
    };
  };
  staleSources: InsightsStaleSource[];
  recentFailures: InsightsFailure[];
};

export const authValidateSession = makeFunctionReference<
  "query",
  { sessionToken: string },
  SessionInfo | null
>("auth:validateSession");

export const authLogin = makeFunctionReference<
  "action",
  { password: string; kind?: "user" | "service"; label?: string; ttlMs?: number },
  LoginResult
>("authActions:login");

export const authLogout = makeFunctionReference<
  "mutation",
  { sessionToken: string },
  { ok: boolean; deleted: boolean }
>("auth:logout");

export const sourcesList = makeFunctionReference<"query", { sessionToken: string }, SourceDoc[]>("sources:list");
export const sourcesSeedDemo = makeFunctionReference<
  "mutation",
  { sessionToken: string },
  { inserted: number; updated: number }
>("sources:seedDemo");

export const sourcesSetEnabled = makeFunctionReference<
  "action",
  { sessionToken: string; slug: string; enabled: boolean },
  { ok: boolean; slug: string; enabled: boolean }
>("sourcesActions:setEnabled");

export const runsListRecent = makeFunctionReference<
  "query",
  { sessionToken: string; limit?: number; sourceSlug?: string },
  RunDoc[]
>("runs:listRecent");

export const runsListActive = makeFunctionReference<"query", { sessionToken: string }, RunDoc[]>("runs:listActive");

export const runsCreate = makeFunctionReference<
  "mutation",
  { sessionToken: string; sourceSlug: string; requestedBy?: string },
  { runId: string }
>("runs:create");

export const runsRequest = makeFunctionReference<
  "action",
  { sessionToken: string; sourceSlug: string; requestedBy?: string },
  { runId: string; queueJobId: string | null }
>("runsActions:request");

export const runsRequestAll = makeFunctionReference<
  "action",
  { sessionToken: string; requestedBy?: string; sourceSlugs?: string[] },
  RunsRequestAllResult
>("runsActions:requestAll");

export const runsCancel = makeFunctionReference<
  "action",
  { sessionToken: string; runId: string },
  { runId: string; removed: boolean; reason: string | null }
>("runsActions:cancel");

export const runsListEvents = makeFunctionReference<
  "query",
  { sessionToken: string; runId: string; limit?: number },
  RunEventDoc[]
>("runs:listEvents");

export const runArtifactsListForRun = makeFunctionReference<
  "query",
  { sessionToken: string; runId: string },
  RunArtifactDoc[]
>("runArtifacts:listForRun");

export const productsListLatest = makeFunctionReference<
  "query",
  { sessionToken: string; limit?: number; sourceSlug?: string },
  ProductLatestDoc[]
>("products:listLatest");

export const productsGetLatestByKey = makeFunctionReference<
  "query",
  { sessionToken: string; sourceSlug: string; itemId: string },
  ProductLatestDoc | null
>("products:getLatestByKey");

export const schedulesList = makeFunctionReference<"query", { sessionToken: string }, ScheduleDoc[]>("schedules:list");

export const schedulesUpsert = makeFunctionReference<
  "action",
  { sessionToken: string; sourceSlug: string; enabled: boolean; intervalMinutes: number },
  { id: string; created: boolean; nextRunAt: number | null }
>("schedulesActions:upsert");

export const pricesListForProduct = makeFunctionReference<
  "query",
  { sessionToken: string; sourceSlug: string; itemId: string; limit?: number },
  PricePointDoc[]
>("prices:listForProduct");

export const canonicalsList = makeFunctionReference<
  "query",
  { sessionToken: string; limit?: number; q?: string },
  CanonicalDoc[]
>("canonicals:list");

export const canonicalsListWithLinkInfo = makeFunctionReference<
  "query",
  { sessionToken: string; limit?: number; q?: string },
  CanonicalLinkInfo[]
>("canonicals:listWithLinkInfo");

export const canonicalsGet = makeFunctionReference<
  "query",
  { sessionToken: string; canonicalId: string },
  CanonicalDoc | null
>("canonicals:get");

export const canonicalsDetail = makeFunctionReference<
  "query",
  { sessionToken: string; canonicalId: string },
  CanonicalDetail
>("canonicals:detail");

export const canonicalsCreate = makeFunctionReference<
  "mutation",
  { sessionToken: string; name: string; description?: string },
  { id: string }
>("canonicals:create");

export const canonicalsUpdate = makeFunctionReference<
  "mutation",
  { sessionToken: string; canonicalId: string; name: string; description?: string },
  { ok: boolean }
>("canonicals:update");

export const canonicalsRemove = makeFunctionReference<
  "mutation",
  { sessionToken: string; canonicalId: string },
  { ok: boolean; deletedLinks: number }
>("canonicals:remove");

export const adminBackfillProductsLatestLastSeenRunId = makeFunctionReference<
  "action",
  { sessionToken: string; dryRun?: boolean; batchSize?: number; maxBatches?: number },
  BackfillProductsLatestLastSeenRunIdResult
>("adminActions:backfillProductsLatestLastSeenRunId");

export const linksGetForProduct = makeFunctionReference<
  "query",
  { sessionToken: string; sourceSlug: string; itemId: string },
  LinkForProduct
>("links:getForProduct");

export const linksCountsBySource = makeFunctionReference<
  "query",
  { sessionToken: string; sourceSlugs: string[] },
  LinkCountsBySource[]
>("links:countsBySource");

export const linksListUnlinked = makeFunctionReference<
  "query",
  { sessionToken: string; sourceSlug: string; limit?: number; q?: string },
  ProductLatestDoc[]
>("links:listUnlinked");

export const linksLink = makeFunctionReference<
  "mutation",
  { sessionToken: string; canonicalId: string; sourceSlug: string; itemId: string },
  { ok: boolean; id: string; created: boolean; changed: boolean }
>("links:link");

export const linksUnlink = makeFunctionReference<
  "mutation",
  { sessionToken: string; sourceSlug: string; itemId: string },
  { ok: boolean; deleted: boolean }
>("links:unlink");

export const linksCreateCanonicalAndLink = makeFunctionReference<
  "mutation",
  { sessionToken: string; sourceSlug: string; itemId: string; name: string; description?: string },
  { ok: boolean; canonicalId: string; linkId: string; createdCanonical: boolean; createdLink: boolean }
>("links:createCanonicalAndLink");

export const dashboardStats = makeFunctionReference<
  "query",
  { sessionToken: string },
  DashboardStats
>("dashboard:stats");

export const dashboardLastScrapes = makeFunctionReference<
  "query",
  { sessionToken: string },
  SourceLastScrape[]
>("dashboard:lastScrapes");

export const insightsSnapshot = makeFunctionReference<"query", { sessionToken: string }, InsightsSnapshot>(
  "insights:snapshot"
);

export const adminResetAll = makeFunctionReference<
  "action",
  { sessionToken: string; deleteSchedules?: boolean },
  ResetAllResult
>("adminActions:resetAll");
