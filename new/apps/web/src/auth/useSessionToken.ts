import { useEffect, useState } from "react";

const SESSION_TOKEN_KEY = "corastuff.sessionToken";

export function useSessionToken() {
  const [sessionToken, setSessionToken] = useState(() => {
    try {
      return window.localStorage.getItem(SESSION_TOKEN_KEY) ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    try {
      if (sessionToken) window.localStorage.setItem(SESSION_TOKEN_KEY, sessionToken);
      else window.localStorage.removeItem(SESSION_TOKEN_KEY);
    } catch {
      // ignore
    }
  }, [sessionToken]);

  return [sessionToken, setSessionToken] as const;
}

