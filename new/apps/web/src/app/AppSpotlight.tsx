import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Kbd, Text } from "@mantine/core";
import { Spotlight, type SpotlightActionData } from "@mantine/spotlight";
import { IconChartLine, IconLink, IconPlus, IconSearch, IconTimelineEvent } from "@tabler/icons-react";
import { NAV_ITEMS } from "./nav";

export function AppSpotlight() {
  const navigate = useNavigate();

  const actions = useMemo(() => {
    const navActions: SpotlightActionData[] = NAV_ITEMS.map((item) => ({
      id: `nav:${item.to}`,
      label: item.label,
      description: item.disabled ? "Coming soon" : undefined,
      leftSection: <item.icon size={18} />,
      onClick: () => {
        if (item.disabled) return;
        navigate(item.to);
      }
    }));

    const quickActions: SpotlightActionData[] = [
      {
        id: "action:new-product",
        label: "New product",
        description: "Create a canonical product",
        leftSection: <IconPlus size={18} />,
        onClick: () => navigate("/products/new")
      },
      {
        id: "action:link-products",
        label: "Link products",
        description: "Open the linking workbench",
        leftSection: <IconLink size={18} />,
        onClick: () => navigate("/link")
      },
      {
        id: "action:prices",
        label: "Prices",
        description: "Browse source prices and deltas",
        leftSection: <IconTimelineEvent size={18} />,
        onClick: () => navigate("/prices")
      },
      {
        id: "action:insights",
        label: "Insights",
        description: "Review anomalies and coverage gaps",
        leftSection: <IconChartLine size={18} />,
        onClick: () => navigate("/insights")
      }
    ];

    return [
      { group: "Actions", actions: quickActions },
      { group: "Navigate", actions: navActions }
    ];
  }, [navigate]);

  return (
    <Spotlight
      actions={actions}
      shortcut={["mod + K", "mod + P"]}
      scrollable
      maxHeight={460}
      searchProps={{
        leftSection: <IconSearch size={16} />,
        placeholder: "Search pages and actions…"
      }}
      nothingFound={
        <Text size="sm" c="dimmed">
          No matches. Try <Kbd>Products</Kbd> or <Kbd>Link</Kbd>.
        </Text>
      }
    />
  );
}
