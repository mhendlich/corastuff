import { Anchor, Badge, Group, Stack, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { Panel } from "../../../components/Panel";
import { fmtAgo } from "../../../lib/time";
import text from "../../../ui/text.module.css";
import type { InsightsExtreme } from "../../../convexFns";
import { fmtMoney, fmtSignedPct } from "../lib/format";
import { linkWorkbenchHref, pricesProductHref } from "../../../lib/routes";

export function ExtremeRow(props: { kind: "low" | "high"; item: InsightsExtreme }) {
  const e = props.item;
  const color = props.kind === "low" ? "teal" : "yellow";
  const label = props.kind === "low" ? "New low" : "New high";
  const change = fmtSignedPct(e.changePct, 1);

  return (
    <Panel variant="subtle" p="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Anchor
            component={Link}
            to={pricesProductHref({ sourceSlug: e.sourceSlug, itemId: e.itemId })}
            fw={600}
            size="sm"
            lineClamp={1}
            title="View price history"
          >
            {e.name}
          </Anchor>
          <Anchor
            component={Link}
            to={linkWorkbenchHref({ sourceSlug: e.sourceSlug, itemId: e.itemId })}
            size="xs"
            c="dimmed"
          >
            Open in Link Products
          </Anchor>
          <Group gap={8} wrap="wrap">
            <Badge variant="light" color={color} radius="xl">
              {e.sourceDisplayName}
            </Badge>
            <Text size="xs" c="dimmed" className={text.mono}>
              {fmtMoney(e.price, e.currency)}
            </Text>
            {typeof e.prevExtremePrice === "number" ? (
              <Text size="xs" c="dimmed" className={text.mono}>
                prev {fmtMoney(e.prevExtremePrice, e.currency)}
              </Text>
            ) : null}
            {typeof e.extremePrice === "number" ? (
              <Text size="xs" c="dimmed" className={text.mono}>
                {label.toLowerCase()} {fmtMoney(e.extremePrice, e.currency)}
              </Text>
            ) : null}
          </Group>
        </Stack>

        <Stack gap={2} align="flex-end">
          <Text fw={700} c={props.kind === "low" ? "teal.2" : "yellow.2"} className={text.mono}>
            {change ?? label}
          </Text>
          <Text size="xs" c="dimmed">
            {fmtAgo(e.lastSeenAt)}
          </Text>
        </Stack>
      </Group>
    </Panel>
  );
}
