import { Container, Paper, Stack, Text, Title } from "@mantine/core";

export function PlaceholderPage(props: { title: string; subtitle?: string }) {
  return (
    <Container size="md" py="xl">
      <Paper withBorder radius="lg" p="xl">
        <Stack gap="xs">
          <Title order={3}>{props.title}</Title>
          <Text c="dimmed">{props.subtitle ?? "Coming soon."}</Text>
        </Stack>
      </Paper>
    </Container>
  );
}
