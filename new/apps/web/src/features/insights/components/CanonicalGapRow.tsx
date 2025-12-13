import { Anchor, Badge, Group, Text } from "@mantine/core";
import { Link } from "react-router-dom";
import { Panel } from "../../../components/Panel";
import type { InsightsCanonicalCoverageGap } from "../../../convexFns";

export function CanonicalGapRow(props: { gap: InsightsCanonicalCoverageGap }) {
  return (
    <Panel variant="subtle" p="md">
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Anchor
          component={Link}
          to={`/products/${props.gap.canonicalId}`}
          size="sm"
          fw={600}
          lineClamp={1}
          title={props.gap.name}
          style={{ minWidth: 0 }}
        >
          {props.gap.name}
        </Anchor>
        <Badge variant="light" color={props.gap.linkCount === 0 ? "red" : "yellow"}>
          Links: {props.gap.linkCount}
        </Badge>
      </Group>
    </Panel>
  );
}
