import type { TablerIcon } from "@tabler/icons-react";
import {
  IconChartHistogram,
  IconDatabase,
  IconHistory,
  IconLink,
  IconRobot,
  IconRoute,
  IconSparkles,
  IconTimelineEvent,
  IconWand,
  IconTools
} from "@tabler/icons-react";

export const NAV_ITEMS: Array<{ to: string; label: string; icon: TablerIcon; disabled?: boolean }> = [
  { to: "/", label: "Dashboard", icon: IconChartHistogram },
  { to: "/insights", label: "Insights", icon: IconSparkles },
  { to: "/products", label: "Products", icon: IconDatabase },
  { to: "/link", label: "Link Products", icon: IconLink },
  { to: "/prices", label: "Prices", icon: IconTimelineEvent },
  { to: "/amazon-pricing", label: "Amazon Pricing", icon: IconRoute },
  { to: "/scrapers", label: "Scrapers", icon: IconRobot },
  { to: "/scrapers/schedules", label: "Automation", icon: IconTools, disabled: true },
  { to: "/history", label: "History", icon: IconHistory },
  { to: "/scrapers/builder", label: "Scraper Builder", icon: IconWand, disabled: true }
];
