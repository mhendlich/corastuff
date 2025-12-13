import type { SessionInfo } from "../convexFns";
import {
  ActionIcon,
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Group,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconLogout2 } from "@tabler/icons-react";
import { NavLink as RouterNavLink, Outlet, useLocation } from "react-router-dom";
import { fmtTs } from "../lib/time";
import { NAV_ITEMS } from "./nav";
import { pageMeta } from "./pageMeta";
import classes from "./AppLayout.module.css";

export function AppLayout(props: { session: SessionInfo; onLogout: () => Promise<void> }) {
  const location = useLocation();
  const meta = pageMeta(location.pathname);
  const [mobileOpened, mobile] = useDisclosure(false);

  return (
    <AppShell
      header={{ height: 64 }}
      navbar={{
        width: 280,
        breakpoint: "md",
        collapsed: { mobile: !mobileOpened }
      }}
      padding="lg"
      className={classes.shell}
    >
      <AppShell.Header className={classes.header}>
        <Group h="100%" px="lg" justify="space-between" gap="lg">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={mobileOpened} onClick={mobile.toggle} hiddenFrom="md" size="sm" />
            <Box className={classes.brandMark} />
            <Box>
              <Text size="xs" c="dimmed" className={classes.breadcrumb}>
                Corastuff / {meta.title}
              </Text>
              <Title order={4} className={classes.pageTitle}>
                {meta.title}
              </Title>
              <Text size="xs" c="dimmed" lineClamp={1}>
                {meta.subtitle}
              </Text>
            </Box>
          </Group>

          <Group gap="sm">
            <Badge variant="light" color="gray" visibleFrom="sm">
              {props.session.kind}
              {props.session.label ? ` (${props.session.label})` : ""} • expires {fmtTs(props.session.expiresAt)}
            </Badge>
            <Tooltip label="Logout" withArrow>
              <ActionIcon
                variant="default"
                size="lg"
                onClick={() => void props.onLogout()}
                aria-label="Logout"
              >
                <IconLogout2 size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar className={classes.navbar}>
        <AppShell.Section px="md" py="md">
          <Group justify="space-between" align="flex-start">
            <div>
              <Title order={4} className={classes.logo}>
                Corastuff
              </Title>
              <Text size="xs" c="dimmed">
                internal console
              </Text>
            </div>
            <Button
              variant="subtle"
              color="gray"
              size="xs"
              onClick={() => void props.onLogout()}
              leftSection={<IconLogout2 size={14} />}
              visibleFrom="md"
            >
              Logout
            </Button>
          </Group>
        </AppShell.Section>

        <AppShell.Section component={ScrollArea} scrollbarSize={8} className={classes.navScroll}>
          <Stack gap={6} p="md">
            {NAV_ITEMS.map((item) => {
              const active =
                item.to === "/"
                  ? location.pathname === "/"
                  : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);

              return (
                <Button
                  key={item.to}
                  component={RouterNavLink}
                  to={item.disabled ? location.pathname : item.to}
                  variant={active ? "light" : "subtle"}
                  color={active ? "violet" : "gray"}
                  justify="flex-start"
                  leftSection={
                    <ThemeIcon variant={active ? "light" : "transparent"} color={active ? "violet" : "gray"}>
                      <item.icon size={18} />
                    </ThemeIcon>
                  }
                  disabled={item.disabled}
                  onClick={() => {
                    if (!item.disabled) mobile.close();
                  }}
                  className={classes.navItem}
                >
                  {item.label}
                </Button>
              );
            })}
          </Stack>
        </AppShell.Section>

        <AppShell.Section px="md" py="md" className={classes.navFooter} visibleFrom="md">
          <Text size="xs" c="dimmed">
            Build the future. Don’t break prod.
          </Text>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main className={classes.main}>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
