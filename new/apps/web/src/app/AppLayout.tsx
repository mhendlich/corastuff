import type { SessionInfo } from "../convexFns";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { fmtTs } from "../lib/time";
import { NAV_ITEMS } from "./nav";
import { pageMeta } from "./pageMeta";

export function AppLayout(props: { session: SessionInfo; onLogout: () => Promise<void> }) {
  const location = useLocation();
  const meta = pageMeta(location.pathname);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="flex min-h-screen">
        <aside className="hidden w-64 shrink-0 border-r border-slate-800 bg-slate-950/60 md:block">
          <div className="px-4 py-4">
            <div className="text-base font-semibold">Corastuff</div>
            <div className="mt-0.5 text-xs text-slate-500">new stack</div>
          </div>
          <nav className="px-2 pb-4">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.disabled ? location.pathname : item.to}
                aria-disabled={item.disabled}
                onClick={(e) => {
                  if (item.disabled) e.preventDefault();
                }}
                className={({ isActive }) =>
                  [
                    "block rounded-md px-3 py-2 text-sm",
                    item.disabled ? "cursor-not-allowed text-slate-600" : "hover:bg-slate-900/50",
                    !item.disabled && isActive ? "bg-slate-900/60 text-slate-100" : ""
                  ].join(" ")
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/80 backdrop-blur">
            <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
              <div className="min-w-0">
                <div className="truncate text-[11px] text-slate-500">Corastuff / {meta.title}</div>
                <div className="truncate text-sm font-medium">{meta.title}</div>
                <div className="truncate text-xs text-slate-400">{meta.subtitle}</div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="hidden text-xs text-slate-500 sm:block">
                  {props.session.kind}
                  {props.session.label ? ` (${props.session.label})` : ""} • expires {fmtTs(props.session.expiresAt)}
                </div>
                <button
                  className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 hover:bg-slate-800"
                  type="button"
                  onClick={() => void props.onLogout()}
                >
                  Logout
                </button>
              </div>
            </div>
          </header>

          <main className="flex-1">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}

