import { Anchor, Badge, Group, Stack, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { Panel } from "../../../components/Panel";
import { fmtAgo } from "../../../lib/time";
import text from "../../../ui/text.module.css";
import type { InsightsStreakTrend } from "../../../convexFns";
import { fmtMoney, fmtSignedPct } from "../lib/format";
import { linkWorkbenchHref } from "../../../lib/routes";

export function StreakRow(props: { kind: "drop" | "rise"; item: InsightsStreakTrend }) {
  const color = props.kind === "drop" ? "teal" : "yellow";
  const trend = fmtSignedPct(props.item.trendPct, 1) ?? "—";
  const series = props.item.prices.map((p) => p.toFixed(2)).join(" → ");

  return (
    <Panel variant="subtle" p="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={6} style={{ minWidth: 0 }}>
          {props.item.url ? (
            <Anchor
              href={props.item.url}
              target="_blank"
              rel="noreferrer"
              fw={600}
              size="sm"
              lineClamp={1}
              title={props.item.name}
            >
              {props.item.name}
            </Anchor>
          ) : (
            <Text fw={600} size="sm" lineClamp={1} title={props.item.name}>
              {props.item.name}
            </Text>
          )}
          <Anchor
            component={Link}
            to={linkWorkbenchHref({ sourceSlug: props.item.sourceSlug, itemId: props.item.itemId })}
            size="xs"
            c="dimmed"
          >
            Open in Link Products
          </Anchor>
          <Group gap={8} wrap="wrap">
            <Badge variant="light" color={color} radius="xl">
              {props.item.sourceDisplayName}
            </Badge>
            <Text size="xs" c="dimmed" className={text.mono}>
              {fmtMoney(props.item.price, props.item.currency)}
            </Text>
            <Text size="xs" c="dimmed" className={text.mono} title={series}>
              {series}
            </Text>
          </Group>
        </Stack>

        <Stack gap={2} align="flex-end">
          <Text fw={700} c={props.kind === "drop" ? "teal.2" : "yellow.2"} className={text.mono}>
            {trend}
          </Text>
          <Text size="xs" c="dimmed">
            {fmtAgo(props.item.lastSeenAt)}
          </Text>
        </Stack>
      </Group>
    </Panel>
  );
}
