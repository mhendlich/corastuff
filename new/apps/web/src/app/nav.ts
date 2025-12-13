export const NAV_ITEMS: Array<{ to: string; label: string; disabled?: boolean }> = [
  { to: "/", label: "Dashboard" },
  { to: "/insights", label: "Insights" },
  { to: "/products", label: "Products", disabled: true },
  { to: "/link", label: "Link Products" },
  { to: "/prices", label: "Prices", disabled: true },
  { to: "/amazon-pricing", label: "Amazon Pricing", disabled: true },
  { to: "/scrapers", label: "Scrapers", disabled: true },
  { to: "/scrapers/schedules", label: "Automation", disabled: true },
  { to: "/history", label: "History", disabled: true },
  { to: "/scrapers/builder", label: "Scraper Builder", disabled: true }
];
