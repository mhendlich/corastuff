import type { ReactNode } from "react";
import { Center, Group, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import classes from "./EmptyState.module.css";

export function EmptyState(props: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
}) {
  return (
    <Center className={classes.root}>
      <Stack gap="sm" align="center" ta="center" style={{ maxWidth: 560 }}>
        <ThemeIcon variant="light" color="gray" size={54} radius="xl">
          {props.icon}
        </ThemeIcon>
        <Title order={4} className={classes.title}>
          {props.title}
        </Title>
        {props.description ? (
          <Text c="dimmed" size="sm">
            {props.description}
          </Text>
        ) : null}
        {props.action || props.secondaryAction ? (
          <Group gap="sm" justify="center" mt={4}>
            {props.action}
            {props.secondaryAction}
          </Group>
        ) : null}
      </Stack>
    </Center>
  );
}

