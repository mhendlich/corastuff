import React from "react";
import ReactDOM from "react-dom/client";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./index.css";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Anchor, Box, Code, Container, Group, MantineProvider, Paper, Stack, Text, Title } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { App } from "./App";
import { theme } from "./app/theme";
import classes from "./app/Backdrop.module.css";

const convexUrl =
  window.__CORASTUFF_CONFIG__?.CONVEX_URL ?? (import.meta.env.VITE_CONVEX_URL as string | undefined);
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} forceColorScheme="dark">
      <Notifications position="top-right" />
      {convex ? (
        <ConvexProvider client={convex}>
          <App />
        </ConvexProvider>
      ) : (
        <Box className={classes.root}>
          <Container size="sm" py={72}>
            <Paper radius="lg" p="xl" withBorder className={classes.glass}>
              <Stack gap="sm">
                <Group justify="space-between" align="flex-start" gap="md">
                  <Title order={2}>Corastuff</Title>
                  <Text size="xs" c="dimmed">
                    web
                  </Text>
                </Group>
                <Text c="dimmed">
                  Missing Convex URL. Set <Code>CONVEX_URL</Code> (Docker) or <Code>VITE_CONVEX_URL</Code> (Vite dev)
                  and restart.
                </Text>
                <Text size="sm" c="dimmed">
                  Tip: open <Anchor href="/config.js">/config.js</Anchor> to verify runtime config.
                </Text>
              </Stack>
            </Paper>
          </Container>
        </Box>
      )}
    </MantineProvider>
  </React.StrictMode>
);
