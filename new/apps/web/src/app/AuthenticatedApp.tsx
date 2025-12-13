import { useMutation, useQuery } from "convex/react";
import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { authLogout, authValidateSession } from "../convexFns";
import { DashboardPage } from "../pages/DashboardPage";
import { InsightsPage } from "../pages/InsightsPage";
import { LinkProductsPage } from "../pages/LinkProductsPage";
import { AppLayout } from "./AppLayout";
import { NotFoundPage } from "./NotFoundPage";
import { PlaceholderPage } from "./PlaceholderPage";

export function AuthenticatedApp(props: { sessionToken: string; onLoggedOut: () => void }) {
  const session = useQuery(authValidateSession, { sessionToken: props.sessionToken });
  const logout = useMutation(authLogout);

  useEffect(() => {
    if (session === null) {
      props.onLoggedOut();
    }
  }, [session, props.onLoggedOut]);

  if (session === undefined) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <h1 className="text-2xl font-semibold">Corastuff (new)</h1>
          <p className="mt-2 text-slate-300">Checking session…</p>
        </div>
      </div>
    );
  }

  if (session === null) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto max-w-3xl px-6 py-10">
          <h1 className="text-2xl font-semibold">Corastuff (new)</h1>
          <p className="mt-2 text-slate-300">Session expired.</p>
        </div>
      </div>
    );
  }

  const handleLogout = async () => {
    try {
      await logout({ sessionToken: props.sessionToken });
    } finally {
      props.onLoggedOut();
    }
  };

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout session={session} onLogout={handleLogout} />}>
          <Route path="/" element={<DashboardPage sessionToken={props.sessionToken} />} />
          <Route path="/insights" element={<InsightsPage sessionToken={props.sessionToken} />} />
          <Route path="/products" element={<PlaceholderPage title="Products" />} />
          <Route path="/link" element={<LinkProductsPage sessionToken={props.sessionToken} />} />
          <Route path="/prices" element={<PlaceholderPage title="Prices" />} />
          <Route path="/amazon-pricing" element={<PlaceholderPage title="Amazon Pricing" />} />
          <Route path="/scrapers" element={<PlaceholderPage title="Scrapers" />} />
          <Route path="/scrapers/schedules" element={<PlaceholderPage title="Automation" />} />
          <Route path="/history" element={<PlaceholderPage title="History" />} />
          <Route path="/scrapers/builder" element={<PlaceholderPage title="Scraper Builder" />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
