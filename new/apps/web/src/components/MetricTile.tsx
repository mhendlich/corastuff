import type { ReactNode } from "react";
import { Card, Text } from "@mantine/core";
import text from "../ui/text.module.css";
import classes from "./MetricTile.module.css";

export type MetricTileTone = "neutral" | "brand" | "warn" | "danger";
export type MetricTileSize = "md" | "lg";

export function MetricTile(props: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: MetricTileTone;
  size?: MetricTileSize;
}) {
  const tone = props.tone ?? "neutral";
  const size = props.size ?? "md";

  const tileClass =
    tone === "brand"
      ? classes.tileBrand
      : tone === "warn"
        ? classes.tileWarn
        : tone === "danger"
          ? classes.tileDanger
          : classes.tileNeutral;

  return (
    <Card withBorder radius="lg" p={size === "lg" ? "lg" : "md"} className={tileClass}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700} className={text.tracking}>
        {props.label}
      </Text>
      <Text fz={34} fw={size === "lg" ? 800 : 750} mt={size === "lg" ? 8 : 6} className={text.mono}>
        {props.value}
      </Text>
      {props.hint ? (
        <Text size="xs" c="dimmed" mt={2}>
          {props.hint}
        </Text>
      ) : null}
    </Card>
  );
}

