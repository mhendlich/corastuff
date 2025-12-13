import { useAction } from "convex/react";
import { useState } from "react";
import { authLogin } from "../convexFns";

export function LoginScreen(props: { onLoggedIn: (sessionToken: string) => void }) {
  const login = useAction(authLogin);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-10">
        <h1 className="text-2xl font-semibold">Corastuff (new)</h1>
        <p className="mt-2 text-sm text-slate-300">Sign in to continue.</p>

        <form
          className="mt-6 space-y-3 rounded-xl border border-slate-800 bg-slate-900/30 p-4"
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
          <label className="block text-sm text-slate-300">
            Password
            <input
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </label>
          <button
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
            type="submit"
            disabled={submitting || password.trim().length === 0}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
          {error ? <div className="text-sm text-rose-200">Login error: {error}</div> : null}
        </form>
      </div>
    </div>
  );
}

