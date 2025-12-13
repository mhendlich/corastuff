import { AuthenticatedApp } from "./app/AuthenticatedApp";
import { LoginScreen } from "./auth/LoginScreen";
import { useSessionToken } from "./auth/useSessionToken";

export function App() {
  const [sessionToken, setSessionToken] = useSessionToken();

  return sessionToken ? (
    <AuthenticatedApp sessionToken={sessionToken} onLoggedOut={() => setSessionToken("")} />
  ) : (
    <LoginScreen onLoggedIn={(token) => setSessionToken(token)} />
  );
}
