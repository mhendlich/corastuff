export function pageMeta(pathname: string): { title: string; subtitle: string } {
  if (pathname === "/") return { title: "Dashboard", subtitle: "Overview of sources and runs." };
  if (pathname.startsWith("/insights"))
    return { title: "Insights", subtitle: "Signals that surface price swings and scrape health." };
  if (pathname.startsWith("/products")) return { title: "Products", subtitle: "Manage canonicals and links." };
  if (pathname.startsWith("/link")) return { title: "Link Products", subtitle: "Multi-source linking workbench." };
  if (pathname.startsWith("/prices")) return { title: "Prices", subtitle: "Price overview and history drilldowns." };
  if (pathname.startsWith("/amazon-pricing"))
    return { title: "Amazon Pricing", subtitle: "Track undercut and raise opportunities vs retailers." };
  if (pathname.startsWith("/scrapers/history")) return { title: "History", subtitle: "Scrape run history and artifacts." };
  if (pathname.startsWith("/scrapers/sources"))
    return { title: "Sources", subtitle: "Create and test source configs before scheduling." };
  if (pathname.startsWith("/schedules") || pathname.startsWith("/scrapers/schedules"))
    return { title: "Automation", subtitle: "Control schedules and scraper concurrency." };
  if (pathname.startsWith("/builder") || pathname.startsWith("/scrapers/builder"))
    return { title: "Scraper Builder", subtitle: "Build a new source config with a dry-run preview." };
  if (pathname.startsWith("/scrapers")) return { title: "Scrapers", subtitle: "Monitor sources and scrape runs." };
  if (pathname.startsWith("/history")) return { title: "History", subtitle: "Scrape run history and artifacts." };
  return { title: "Not Found", subtitle: "Unknown route." };
}
