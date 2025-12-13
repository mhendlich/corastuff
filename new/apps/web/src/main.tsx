import React from "react";
import ReactDOM from "react-dom/client";
import "@mantine/core/styles.css";
import "@mantine/carousel/styles.css";
import "@mantine/charts/styles.css";
import "@mantine/code-highlight/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/dropzone/styles.css";
import "@mantine/notifications/styles.css";
import "@mantine/nprogress/styles.css";
import "@mantine/spotlight/styles.css";
import "@mantine/tiptap/styles.css";
import "./index.css";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Anchor, Box, Code, Container, Group, MantineProvider, Paper, Stack, Text, Title } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { NavigationProgress } from "@mantine/nprogress";
import { App } from "./App";
import { theme } from "./app/theme";
import classes from "./app/Backdrop.module.css";

const convexUrl =
  window.__CORASTUFF_CONFIG__?.CONVEX_URL ?? (import.meta.env.VITE_CONVEX_URL as string | undefined);
const convex = convexUrl ? new ConvexReactClient(convexUrl) : null;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} forceColorScheme="dark">
      <ModalsProvider>
        <NavigationProgress />
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
                    Missing Convex URL. For Docker Compose, set <Code>CONVEX_URL_PUBLIC</Code> (written into{" "}
                    <Code>/config.js</Code>). For Vite dev, set <Code>VITE_CONVEX_URL</Code>. Then restart.
                  </Text>
                  <Text size="sm" c="dimmed">
                    Tip: open <Anchor href="/config.js">/config.js</Anchor> to verify runtime config.
                  </Text>
                </Stack>
              </Paper>
            </Container>
          </Box>
        )}
      </ModalsProvider>
    </MantineProvider>
  </React.StrictMode>
);
