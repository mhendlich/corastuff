import { Box, Group, Text } from "@mantine/core";
import { fmtMoney } from "../lib/format";
import classes from "./PriceChart.module.css";

type Point = { ts: number; value: number };

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
  const width = 1000;
  const padLeft = 64;
  const padRight = 20;
  const padTop = 16;
  const padBottom = 34;

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
  let minVal = Infinity;
  let maxVal = -Infinity;

  for (const p of allPoints) {
    if (!Number.isFinite(p.ts) || !Number.isFinite(p.value)) continue;
    minTs = Math.min(minTs, p.ts);
    maxTs = Math.max(maxTs, p.ts);
    minVal = Math.min(minVal, p.value);
    maxVal = Math.max(maxVal, p.value);
  }

  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs) || minTs === maxTs) {
    maxTs = minTs + 1;
  }
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal) || minVal === maxVal) {
    maxVal = minVal + 1;
  }

  const spanMs = maxTs - minTs;
  const valPad = Math.max((maxVal - minVal) * 0.08, 0.1);
  minVal -= valPad;
  maxVal += valPad;

  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  const x = (ts: number) => padLeft + ((ts - minTs) / (maxTs - minTs)) * innerW;
  const y = (value: number) => padTop + (1 - (value - minVal) / (maxVal - minVal)) * innerH;

  const yTicks = [0, 0.5, 1].map((t) => minVal + (maxVal - minVal) * t);
  const xTicks = [0, 1 / 3, 2 / 3, 1].map((t) => minTs + spanMs * t);

  const paths = props.series
    .map((s) => {
      const pts = [...s.points].sort((a, b) => a.ts - b.ts);
      const commands: string[] = [];
      for (const p of pts) {
        if (!Number.isFinite(p.ts) || !Number.isFinite(p.value)) continue;
        const cmd = `${commands.length === 0 ? "M" : "L"} ${x(p.ts).toFixed(2)} ${y(p.value).toFixed(2)}`;
        commands.push(cmd);
      }
      return { ...s, d: commands.join(" ") };
    })
    .filter((s) => s.d.length > 0);

  return (
    <Box>
      {props.series.length > 1 ? (
        <Group gap="xs" mb="xs" wrap="wrap">
          {props.series.map((s) => (
            <Group key={s.key} gap={6} wrap="nowrap">
              <Box className={classes.swatch} style={{ background: s.color }} />
              <Text size="xs" c="dimmed">
                {s.label}
              </Text>
            </Group>
          ))}
        </Group>
      ) : null}

      <svg className={classes.svg} viewBox={`0 0 ${width} ${height}`} role="img">
        <rect x="0" y="0" width={width} height={height} rx="16" className={classes.bg} />

        {yTicks.map((v, idx) => {
          const yy = y(v);
          return (
            <g key={idx}>
              <line x1={padLeft} x2={width - padRight} y1={yy} y2={yy} className={classes.grid} />
              <text x={padLeft - 10} y={yy + 4} textAnchor="end" className={classes.axis}>
                {fmtMoney(v, props.currency)}
              </text>
            </g>
          );
        })}

        {xTicks.map((t, idx) => (
          <text key={idx} x={x(t)} y={height - 12} textAnchor={idx === 0 ? "start" : idx === 3 ? "end" : "middle"} className={classes.axis}>
            {fmtTick(t, spanMs)}
          </text>
        ))}

        {paths.map((p) => (
          <path key={p.key} d={p.d} fill="none" stroke={p.color} strokeWidth={2.5} className={classes.path} />
        ))}
      </svg>
    </Box>
  );
}

