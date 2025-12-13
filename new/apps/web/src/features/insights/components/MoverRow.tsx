import { Badge, Group, Stack, Text } from "@mantine/core";
import { Panel } from "../../../components/Panel";
import text from "../../../ui/text.module.css";
import { fmtAgo } from "../../../lib/time";
import type { InsightsMover } from "../../../convexFns";

function fmtMoney(price: number, currency: string | null) {
  const p = Number.isFinite(price) ? price.toFixed(2) : "—";
  return currency ? `${p} ${currency}` : p;
}

function fmtDelta(m: InsightsMover) {
  if (typeof m.changeAbs !== "number" && typeof m.changePct !== "number") return "—";
  const abs = typeof m.changeAbs === "number" ? `${m.changeAbs >= 0 ? "+" : ""}${m.changeAbs.toFixed(2)}` : null;
  const pct = typeof m.changePct === "number" ? `${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(1)}%` : null;
  if (abs && pct) return `${abs} (${pct})`;
  return abs ?? pct ?? "—";
}

export function MoverRow(props: { kind: "drop" | "spike"; mover: InsightsMover }) {
  const m = props.mover;
  const color = props.kind === "drop" ? "teal" : "yellow";

  return (
    <Panel variant="subtle" p="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Text fw={600} size="sm" lineClamp={1} title={m.name}>
            {m.name}
          </Text>
          <Group gap={8} wrap="wrap">
            <Badge variant="light" color={color} radius="xl">
              {m.sourceDisplayName}
            </Badge>
            <Text size="xs" c="dimmed" className={text.mono}>
              {fmtMoney(m.price, m.currency)}
            </Text>
            {m.prevPrice !== null ? (
              <Text size="xs" c="dimmed" className={text.mono}>
                prev {fmtMoney(m.prevPrice, m.currency)}
              </Text>
            ) : null}
          </Group>
        </Stack>

        <Stack gap={2} align="flex-end">
          <Text fw={700} c={props.kind === "drop" ? "teal.2" : "yellow.2"} className={text.mono}>
            {fmtDelta(m)}
          </Text>
          <Text size="xs" c="dimmed">
            {fmtAgo(m.lastSeenAt)}
          </Text>
        </Stack>
      </Group>
    </Panel>
  );
}

