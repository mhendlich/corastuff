import type { RunStatus } from "@corastuff/shared";
import { Badge } from "@mantine/core";

export function StatusPill({ status }: { status: RunStatus }) {
  const color =
    status === "completed"
      ? "teal"
      : status === "failed"
        ? "red"
        : status === "running"
          ? "cyan"
          : status === "canceled"
            ? "gray"
            : "yellow";

  return (
    <Badge variant="light" color={color} radius="xl">
      {status}
    </Badge>
  );
}
