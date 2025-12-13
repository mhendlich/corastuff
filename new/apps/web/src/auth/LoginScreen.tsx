import { useAction } from "convex/react";
import { useState, type CSSProperties } from "react";
import {
  Alert,
  Box,
  Button,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title
} from "@mantine/core";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { IconAlertTriangle, IconArrowRight, IconLock } from "@tabler/icons-react";
import { authLogin } from "../convexFns";
import { BrandMark } from "../components/BrandMark";
import backdrop from "../app/Backdrop.module.css";
import styles from "./LoginScreen.module.css";

export function LoginScreen(props: { onLoggedIn: (sessionToken: string) => void }) {
  const login = useAction(authLogin);
  const reducedMotion = useReducedMotion();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const motionEnabled = !reducedMotion;

  return (
    <Box className={`${backdrop.root} ${styles.root}`}>
      <div className={styles.ambient} aria-hidden="true">
        <div className={styles.aurora} />
        <div className={styles.grid} />
        <div className={styles.orbs}>
          <motion.div
            className={styles.orb}
            style={
              {
                top: "-22%",
                left: "-18%",
                "--orb-size": "640px",
                "--orb-from": "rgba(120, 80, 255, 0.52)",
                "--orb-to": "rgba(65, 220, 255, 0.32)",
                "--orb-opacity": "0.7"
              } as CSSProperties
            }
            animate={
              motionEnabled
                ? {
                    x: [0, 40, 0],
                    y: [0, -26, 0],
                    rotate: [-3, 3, -3]
                  }
                : undefined
            }
            transition={motionEnabled ? { duration: 14, repeat: Infinity, ease: "easeInOut" } : undefined}
          />
          <motion.div
            className={styles.orb}
            style={
              {
                bottom: "-26%",
                right: "-14%",
                "--orb-size": "720px",
                "--orb-from": "rgba(255, 90, 210, 0.34)",
                "--orb-to": "rgba(120, 80, 255, 0.22)",
                "--orb-opacity": "0.62"
              } as CSSProperties
            }
            animate={
              motionEnabled
                ? {
                    x: [0, -34, 0],
                    y: [0, 20, 0],
                    rotate: [2, -2, 2]
                  }
                : undefined
            }
            transition={motionEnabled ? { duration: 16, repeat: Infinity, ease: "easeInOut" } : undefined}
          />
        </div>
      </div>

      <div className={styles.shell}>
        <motion.div
          className={styles.frame}
          data-reduced-motion={reducedMotion ? "true" : "false"}
          initial={motionEnabled ? { opacity: 0, y: 22, scale: 0.985 } : undefined}
          animate={motionEnabled ? { opacity: 1, y: 0, scale: 1 } : undefined}
          transition={motionEnabled ? { duration: 0.7, ease: [0.16, 1, 0.3, 1] } : undefined}
        >
          <Paper withBorder radius={27} p="xl" className={`${backdrop.glass} ${styles.card}`}>
            <Stack gap="md">
              <Group gap="md" align="center">
                <motion.div
                  initial={motionEnabled ? { opacity: 0, rotate: -10, scale: 0.9 } : undefined}
                  animate={motionEnabled ? { opacity: 1, rotate: 0, scale: 1 } : undefined}
                  transition={motionEnabled ? { delay: 0.08, duration: 0.6, ease: [0.16, 1, 0.3, 1] } : undefined}
                >
                  <BrandMark size={46} />
                </motion.div>
                <div>
                  <Title order={2} className={styles.brandName}>
                    Corastuff
                  </Title>
                  <Text c="dimmed" size="sm" mt={4}>
                    Sign in
                  </Text>
                </div>
              </Group>

              <AnimatePresence initial={false} mode="popLayout">
                {error ? (
                  <motion.div
                    key="error"
                    initial={motionEnabled ? { opacity: 0, y: -8 } : undefined}
                    animate={motionEnabled ? { opacity: 1, y: 0 } : undefined}
                    exit={motionEnabled ? { opacity: 0, y: -6 } : undefined}
                    transition={motionEnabled ? { duration: 0.2 } : undefined}
                  >
                    <Alert
                      color="red"
                      variant="light"
                      radius="md"
                      icon={<IconAlertTriangle size={18} />}
                      title="Couldn’t sign you in"
                    >
                      {error}
                    </Alert>
                  </motion.div>
                ) : null}
              </AnimatePresence>

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
                    setSubmitting(false);
                  }
                }}
              >
                <Stack gap="sm">
                  <PasswordInput
                    autoFocus
                    label="Password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.currentTarget.value)}
                    leftSection={<IconLock size={16} />}
                    autoComplete="current-password"
                    disabled={submitting}
                  />

                  <Button
                    type="submit"
                    fullWidth
                    loading={submitting}
                    disabled={password.trim().length === 0}
                    className={styles.cta}
                    variant="gradient"
                    gradient={{ from: "violet.6", to: "cyan.5", deg: 135 }}
                    rightSection={<IconArrowRight size={16} />}
                  >
                    Sign in
                  </Button>
                </Stack>
              </form>
            </Stack>
          </Paper>
        </motion.div>
      </div>
    </Box>
  );
}
