/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as adminActions from "../adminActions.js";
import type * as auth from "../auth.js";
import type * as authActions from "../authActions.js";
import type * as authz from "../authz.js";
import type * as canonicals from "../canonicals.js";
import type * as dashboard from "../dashboard.js";
import type * as insights from "../insights.js";
import type * as links from "../links.js";
import type * as prices from "../prices.js";
import type * as products from "../products.js";
import type * as runArtifacts from "../runArtifacts.js";
import type * as runs from "../runs.js";
import type * as runsActions from "../runsActions.js";
import type * as schedules from "../schedules.js";
import type * as schedulesActions from "../schedulesActions.js";
import type * as sources from "../sources.js";
import type * as sourcesActions from "../sourcesActions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  adminActions: typeof adminActions;
  auth: typeof auth;
  authActions: typeof authActions;
  authz: typeof authz;
  canonicals: typeof canonicals;
  dashboard: typeof dashboard;
  insights: typeof insights;
  links: typeof links;
  prices: typeof prices;
  products: typeof products;
  runArtifacts: typeof runArtifacts;
  runs: typeof runs;
  runsActions: typeof runsActions;
  schedules: typeof schedules;
  schedulesActions: typeof schedulesActions;
  sources: typeof sources;
  sourcesActions: typeof sourcesActions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
