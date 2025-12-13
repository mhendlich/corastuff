import type { ReactNode } from "react";
import { Group, Text, Title } from "@mantine/core";

export function PageHeader(props: {
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  titleOrder?: 1 | 2 | 3 | 4 | 5 | 6;
}) {
  return (
    <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
      <div>
        <Title order={props.titleOrder ?? 3}>{props.title}</Title>
        {props.subtitle ? (
          <Text c="dimmed" size="sm">
            {props.subtitle}
          </Text>
        ) : null}
      </div>
      {props.right}
    </Group>
  );
}

