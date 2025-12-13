import React from "react";
import { Box, Button, Code, Container, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { IconArrowLeft, IconLogout2, IconRefresh } from "@tabler/icons-react";
import { errorMessage, errorStack } from "../lib/errors";
import backdrop from "./Backdrop.module.css";
import classes from "./AppErrorBoundary.module.css";

type Props = {
  children: React.ReactNode;
  onLogout?: () => void;
};

type State = { err: unknown | null };

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: unknown): State {
    return { err };
  }

  componentDidCatch() {
    // Let the boundary render; error reporting can be added later.
  }

  private reset = () => this.setState({ err: null });

  render() {
    if (!this.state.err) return this.props.children;

    const msg = errorMessage(this.state.err);
    const stack = errorStack(this.state.err);

    return (
      <Box className={backdrop.root}>
        <Container size="sm" py={72} className={classes.root}>
          <Paper withBorder radius="lg" p="xl" className={backdrop.glass} w="100%">
            <Stack gap="md">
              <Title order={2}>App error</Title>
              <Text c="dimmed">{msg}</Text>
              <Group gap="sm">
                <Button leftSection={<IconRefresh size={16} />} onClick={this.reset}>
                  Retry
                </Button>
                <Button
                  variant="default"
                  leftSection={<IconArrowLeft size={16} />}
                  onClick={() => {
                    window.location.assign("/");
                  }}
                >
                  Home
                </Button>
                {this.props.onLogout ? (
                  <Button variant="light" color="gray" leftSection={<IconLogout2 size={16} />} onClick={this.props.onLogout}>
                    Logout
                  </Button>
                ) : null}
                <Button
                  variant="subtle"
                  color="gray"
                  onClick={() => window.location.reload()}
                >
                  Reload
                </Button>
              </Group>
              {stack ? (
                <Code block className={classes.details}>
                  {stack}
                </Code>
              ) : null}
            </Stack>
          </Paper>
        </Container>
      </Box>
    );
  }
}

