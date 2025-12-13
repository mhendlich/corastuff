import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { App } from "./App";

const convexUrl =
  window.__CORASTUFF_CONFIG__?.CONVEX_URL ?? (import.meta.env.VITE_CONVEX_URL as string | undefined);
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {convex ? (
      <ConvexProvider client={convex}>
        <App />
      </ConvexProvider>
    ) : (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <h1 className="text-2xl font-semibold">Corastuff (new)</h1>
          <p className="mt-2 text-slate-300">
            Missing Convex URL — set <code className="text-slate-100">CONVEX_URL</code> (Docker) or{" "}
            <code className="text-slate-100">VITE_CONVEX_URL</code> (Vite dev) and restart.
          </p>
        </div>
      </div>
    )}
  </React.StrictMode>
);
