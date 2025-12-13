export function pageMeta(pathname: string): { title: string; subtitle: string } {
  if (pathname === "/") return { title: "Dashboard", subtitle: "Overview of sources and runs." };
  if (pathname.startsWith("/insights"))
    return { title: "Insights", subtitle: "Signals that surface price swings and scrape health." };
  if (pathname.startsWith("/products")) return { title: "Products", subtitle: "Manage canonicals and links." };
  if (pathname.startsWith("/link")) return { title: "Link Products", subtitle: "Multi-source linking workbench." };
  if (pathname.startsWith("/prices")) return { title: "Prices", subtitle: "Price overview and history drilldowns." };
  if (pathname.startsWith("/amazon-pricing")) return { title: "Amazon Pricing", subtitle: "Coming soon." };
  if (pathname.startsWith("/scrapers/schedules")) return { title: "Automation", subtitle: "Coming soon." };
  if (pathname.startsWith("/scrapers/builder")) return { title: "Scraper Builder", subtitle: "Coming soon." };
  if (pathname.startsWith("/scrapers")) return { title: "Scrapers", subtitle: "Coming soon." };
  if (pathname.startsWith("/history")) return { title: "History", subtitle: "Coming soon." };
  return { title: "Not Found", subtitle: "Unknown route." };
}
