import { useAction } from "convex/react";
import { useState } from "react";
import { Anchor, Box, Button, Code, Container, Group, Paper, PasswordInput, Stack, Text, Title } from "@mantine/core";
import { authLogin } from "../convexFns";
import backdrop from "../app/Backdrop.module.css";

export function LoginScreen(props: { onLoggedIn: (sessionToken: string) => void }) {
  const login = useAction(authLogin);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Box className={backdrop.root}>
      <Container size={420} py={84}>
        <Paper withBorder radius="lg" p="xl" className={backdrop.glass}>
          <Stack gap="md">
            <Group justify="space-between" align="flex-start" gap="md">
              <div>
                <Title order={2}>Corastuff</Title>
                <Text c="dimmed" size="sm" mt={4}>
                  Sign in to continue.
                </Text>
              </div>
              <Text size="xs" c="dimmed">
                internal
              </Text>
            </Group>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setSubmitting(true);
                setError(null);
                try {
                  const result = await login({ password });
                  props.onLoggedIn(result.sessionToken);
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              <Stack gap="sm">
                <PasswordInput
                  label="Password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  autoComplete="current-password"
                  disabled={submitting}
                />
                <Button type="submit" loading={submitting} disabled={password.trim().length === 0} fullWidth>
                  Sign in
                </Button>
                {error ? (
                  <Text c="red.2" size="sm">
                    Login error: {error}
                  </Text>
                ) : (
                  <Text c="dimmed" size="xs">
                    Tip: set <Code>CORASTUFF_PASSWORD</Code> in Docker. Runtime config lives at{" "}
                    <Anchor href="/config.js">/config.js</Anchor>.
                  </Text>
                )}
              </Stack>
            </form>
          </Stack>
        </Paper>
      </Container>
    </Box>
  );
}
