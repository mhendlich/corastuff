import { Anchor, Avatar, Group, Stack, Text } from "@mantine/core";
import { SelectableRow } from "../../../components/SelectableRow";
import text from "../../../ui/text.module.css";
import { fmtTs } from "../../../lib/time";
import type { ProductLatestDoc } from "../../../convexFns";
import classes from "./ProductRow.module.css";

function money(price: number | undefined, currency: string | null | undefined) {
  if (typeof price !== "number") return "—";
  const c = currency ?? "";
  return `${price} ${c}`.trim();
}

export function ProductRow(props: { product: ProductLatestDoc; selected: boolean; onClick: () => void }) {
  const p = props.product;
  return (
    <SelectableRow active={props.selected} onClick={props.onClick}>
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Group wrap="nowrap" gap="md" style={{ minWidth: 0 }}>
          <Avatar src={p.image?.mediaUrl ?? undefined} radius="md" size={44}>
            {p.name.slice(0, 1).toUpperCase()}
          </Avatar>
          <div style={{ minWidth: 0 }}>
            {p.url ? (
              <Anchor
                href={p.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className={classes.productTitle}
              >
                {p.name}
              </Anchor>
            ) : (
              <Text fw={650} size="sm" lineClamp={1} className={classes.productTitle}>
                {p.name}
              </Text>
            )}
            <Text size="xs" c="dimmed" lineClamp={1} className={text.mono}>
              {p.itemId} · seen {fmtTs(p.lastSeenAt)}
            </Text>
          </div>
        </Group>
        <Stack gap={2} align="flex-end">
          <Text fw={700} className={text.mono}>
            {money(p.lastPrice, p.currency ?? null)}
          </Text>
          {typeof p.prevPrice === "number" ? (
            <Text size="xs" c="dimmed" className={text.mono}>
              prev {money(p.prevPrice, p.currency ?? null)}
            </Text>
          ) : null}
        </Stack>
      </Group>
    </SelectableRow>
  );
}

