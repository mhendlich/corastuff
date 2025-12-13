import { Anchor, Container, Paper, Stack, Text, Title } from "@mantine/core";
import { NavLink } from "react-router-dom";

export function NotFoundPage() {
  return (
    <Container size="md" py="xl">
      <Paper withBorder radius="lg" p="xl">
        <Stack gap="xs">
          <Title order={3}>Not found</Title>
          <Text c="dimmed">This page does not exist.</Text>
          <Anchor component={NavLink} to="/" size="sm">
            Go to dashboard
          </Anchor>
        </Stack>
      </Paper>
    </Container>
  );
}
