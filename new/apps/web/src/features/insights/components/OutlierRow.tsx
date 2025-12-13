import { Anchor, Badge, Group, Stack, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { Panel } from "../../../components/Panel";
import { fmtAgo } from "../../../lib/time";
import text from "../../../ui/text.module.css";
import type { InsightsOutlier } from "../../../convexFns";
import { fmtMoney, fmtSignedPct } from "../lib/format";
import { linkWorkbenchHref, pricesProductHref } from "../../../lib/routes";

export function OutlierRow(props: { outlier: InsightsOutlier }) {
  const o = props.outlier;
  const deviation = fmtSignedPct(o.deviationPct, 1) ?? "—";
  const color = o.deviationPct >= 0 ? "yellow" : "teal";

  return (
    <Panel variant="subtle" p="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Anchor
            component={Link}
            to={pricesProductHref({ sourceSlug: o.sourceSlug, itemId: o.itemId })}
            fw={600}
            size="sm"
            lineClamp={1}
            title="View price history"
          >
            {o.name}
          </Anchor>
          <Anchor
            component={Link}
            to={linkWorkbenchHref({ sourceSlug: o.sourceSlug, itemId: o.itemId })}
            size="xs"
            c="dimmed"
          >
            Open in Link Products
          </Anchor>
          <Group gap={8} wrap="wrap">
            <Badge variant="light" color={color} radius="xl">
              {o.sourceDisplayName}
            </Badge>
            <Anchor component={Link} to={`/products/${o.canonicalId}`} size="xs" c="dimmed" lineClamp={1}>
              {o.canonicalName ?? "Canonical"}
            </Anchor>
            <Text size="xs" c="dimmed" className={text.mono}>
              {fmtMoney(o.price, o.currency)}
            </Text>
            <Text size="xs" c="dimmed" className={text.mono}>
              median {fmtMoney(o.medianPrice, o.currency)}
            </Text>
          </Group>
        </Stack>

        <Stack gap={2} align="flex-end">
          <Text fw={700} c={o.deviationPct >= 0 ? "yellow.2" : "teal.2"} className={text.mono}>
            {deviation}
          </Text>
          <Text size="xs" c="dimmed">
            {fmtAgo(o.lastSeenAt)}
          </Text>
        </Stack>
      </Group>
    </Panel>
  );
}
