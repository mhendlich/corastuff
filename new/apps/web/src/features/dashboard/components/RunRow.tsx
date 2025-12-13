import { Group, Stack, Text } from "@mantine/core";
import { StatusPill } from "../../../components/StatusPill";
import { SelectableRow } from "../../../components/SelectableRow";
import text from "../../../ui/text.module.css";
import { fmtTs } from "../../../lib/time";
import type { RunDoc } from "../../../convexFns";

export function RunRow(props: { run: RunDoc; selected: boolean; onSelect: () => void }) {
  const r = props.run;
  return (
    <SelectableRow active={props.selected} onClick={props.onSelect}>
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Text fw={650} size="sm" lineClamp={1}>
            {r.sourceSlug}
          </Text>
          <Text size="xs" c="dimmed">
            started {fmtTs(r.startedAt)} · finished {fmtTs(r.completedAt)}
            {typeof r.productsFound === "number" ? ` · ${r.productsFound} products` : ""}
          </Text>
          {r.error ? (
            <Text size="xs" c="red.2" lineClamp={2}>
              error: {r.error}
            </Text>
          ) : null}
        </Stack>
        <div className={text.mono}>
          <StatusPill status={r.status} />
        </div>
      </Group>
    </SelectableRow>
  );
}

