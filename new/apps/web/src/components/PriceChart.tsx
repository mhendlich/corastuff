import { LineChart } from "@mantine/charts";
import { Box, Text } from "@mantine/core";
import { fmtMoney } from "../lib/format";
import classes from "./PriceChart.module.css";

type Point = { ts: number; value: number };
type ChartRow = { ts: number } & Record<string, number | undefined>;

export type PriceChartSeries = {
  key: string;
  label: string;
  color: string;
  points: Point[];
};

function fmtTick(ts: number, spanMs: number) {
  const d = new Date(ts);
  if (spanMs < 2 * 24 * 60 * 60 * 1000) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (spanMs < 21 * 24 * 60 * 60 * 1000) {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (spanMs < 180 * 24 * 60 * 60 * 1000) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

export function PriceChart(props: { series: PriceChartSeries[]; currency: string | null; height?: number }) {
  const height = props.height ?? 220;
  const allPoints = props.series.flatMap((s) => s.points);
  if (allPoints.length < 2) {
    return (
      <Box className={classes.empty} h={height}>
        <Text size="sm" c="dimmed">
          Not enough price points to plot yet.
        </Text>
      </Box>
    );
  }

  let minTs = Infinity;
  let maxTs = -Infinity;
  const rows = new Map<number, ChartRow>();
  const keyed = props.series.map((s, idx) => ({ ...s, __name: `s${idx}` }));

  for (const s of keyed) {
    for (const p of s.points) {
      if (!Number.isFinite(p.ts) || !Number.isFinite(p.value)) continue;
      minTs = Math.min(minTs, p.ts);
      maxTs = Math.max(maxTs, p.ts);
      const row = rows.get(p.ts) ?? ({ ts: p.ts } as ChartRow);
      row[s.__name] = p.value;
      rows.set(p.ts, row);
    }
  }

  const spanMs = Number.isFinite(minTs) && Number.isFinite(maxTs) ? Math.max(1, maxTs - minTs) : 1;
  const data = [...rows.values()].sort((a, b) => (a.ts as number) - (b.ts as number));

  return (
    <LineChart
      h={height}
      data={data as Array<Record<string, any>>}
      dataKey="ts"
      withLegend={props.series.length > 1}
      series={keyed.map((s) => ({ name: s.__name, label: s.label, color: s.color }))}
      valueFormatter={(value) => fmtMoney(value, props.currency)}
      xAxisProps={{
        type: "number",
        domain: ["dataMin", "dataMax"],
        scale: "time",
        tickFormatter: (value) => fmtTick(Number(value), spanMs)
      }}
      tooltipProps={{
        labelFormatter: (value) => fmtTick(Number(value), spanMs)
      }}
      withDots={false}
      className={classes.chart}
    />
  );
}
