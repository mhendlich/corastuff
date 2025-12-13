import { Badge, Box, Container, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import backdrop from "./Backdrop.module.css";
import styles from "./SessionLoadingScreen.module.css";

export function SessionLoadingScreen() {
  const reducedMotion = useReducedMotion();

  return (
    <Box className={backdrop.root}>
      <Container size="sm" py={96}>
        <div className={styles.frame} data-reduced-motion={reducedMotion ? "true" : "false"}>
          <Paper withBorder radius={22} p="xl" className={`${backdrop.glass} ${styles.inner}`}>
            <Stack gap="lg">
              <Group justify="space-between" align="flex-start" gap="lg">
                <Group gap="md" align="center">
                  <div className={styles.mark} />
                  <div>
                    <Title order={2} className={styles.logo}>
                      Corastuff
                    </Title>
                    <Text c="dimmed" size="sm" mt={4}>
                      Signing you in…
                    </Text>
                  </div>
                </Group>
                <Badge variant="light" color="cyan" radius="sm">
                  secure
                </Badge>
              </Group>

              <Stack gap={10} className={styles.subtleBorder} style={{ borderRadius: 16, padding: 14 }}>
                <div className={styles.progressTrack}>
                  <div className={styles.progressBar} />
                </div>
                <Group gap="sm" justify="space-between">
                  <Group gap="sm">
                    <Loader type="bars" size="sm" />
                    <Text c="dimmed" size="sm">
                      Validating session
                    </Text>
                  </Group>
                  <Text c="dimmed" size="xs">
                    typically ~1s
                  </Text>
                </Group>
              </Stack>

              <Text c="dimmed" size="xs">
                If this takes longer, refresh or sign in again.
              </Text>
            </Stack>
          </Paper>
        </div>
      </Container>
    </Box>
  );
}
