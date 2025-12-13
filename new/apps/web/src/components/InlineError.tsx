import type { ReactNode } from "react";
import { Alert, Button, Code, Group, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { errorMessage } from "../lib/errors";

export function InlineError(props: { title?: string; error: unknown; onRetry?: () => void; hint?: ReactNode }) {
  const message = errorMessage(props.error);
  return (
    <Alert
      color="red"
      variant="light"
      title={props.title ?? "Something went wrong"}
      icon={<IconAlertTriangle size={16} />}
    >
      <Stack gap="xs">
        <Text size="sm">{message}</Text>
        {props.hint ? (
          <Text size="sm" c="dimmed">
            {props.hint}
          </Text>
        ) : null}
        <Code block>{message}</Code>
        {props.onRetry ? (
          <Group justify="flex-end">
            <Button size="xs" variant="default" onClick={props.onRetry}>
              Retry
            </Button>
          </Group>
        ) : null}
      </Stack>
    </Alert>
  );
}

