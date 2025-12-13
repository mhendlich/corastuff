import { useEffect, useRef, useState } from "react";
import { AuthenticatedApp } from "./app/AuthenticatedApp";
import { LoginScreen } from "./auth/LoginScreen";
import { useSessionToken } from "./auth/useSessionToken";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import classes from "./App.module.css";
import { BrandMark } from "./components/BrandMark";

export function App() {
  const [sessionToken, setSessionToken] = useSessionToken();
  const reducedMotion = useReducedMotion();

  const motionEnabled = !reducedMotion;

  const transitionIdRef = useRef(0);
  const commitTimerRef = useRef<number | null>(null);
  const [transition, setTransition] = useState<null | { id: number; kind: "toAuthed" | "toLogin" }>(null);

  useEffect(() => {
    return () => {
      if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
    };
  }, []);

  const beginTransition = (kind: "toAuthed" | "toLogin", commit: () => void) => {
    if (!motionEnabled) {
      commit();
      return;
    }
    if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
    const id = ++transitionIdRef.current;
    setTransition({ id, kind });
    commitTimerRef.current = window.setTimeout(() => {
      if (transitionIdRef.current !== id) return;
      commit();
    }, 260);
  };

  const handleLoggedIn = (token: string) => {
    if (transition) return;
    beginTransition("toAuthed", () => setSessionToken(token));
  };

  const handleLoggedOut = () => {
    if (transition) return;
    beginTransition("toLogin", () => setSessionToken(""));
  };

  return (
    <>
      <div className={classes.stage}>
        {sessionToken ? (
          <AuthenticatedApp sessionToken={sessionToken} onLoggedOut={handleLoggedOut} />
        ) : (
          <LoginScreen onLoggedIn={handleLoggedIn} />
        )}
      </div>

      <AnimatePresence>
        {transition && motionEnabled ? (
          <motion.div
            key={transition.id}
            className={classes.overlay}
            data-active="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 1, 0] }}
            transition={{ duration: 0.92, times: [0, 0.22, 0.6, 1], ease: [0.16, 1, 0.3, 1] }}
            onAnimationComplete={() => {
              if (transitionIdRef.current === transition.id) setTransition(null);
            }}
          >
            <motion.div
              className={classes.overlayMark}
              initial={{ opacity: 0, scale: 0.86, rotate: -8 }}
              animate={{ opacity: [0, 1, 1, 0], scale: [0.86, 1, 1, 0.96], rotate: [-8, 0, 0, 4] }}
              transition={{ duration: 0.92, times: [0, 0.25, 0.6, 1], ease: [0.16, 1, 0.3, 1] }}
            >
              <BrandMark size={58} />
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
