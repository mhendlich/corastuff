import { NavLink } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <div className="text-sm font-medium">Not found</div>
        <div className="mt-1 text-sm text-slate-300">This page does not exist.</div>
        <div className="mt-3">
          <NavLink className="text-sm text-sky-300 hover:underline" to="/">
            Go to dashboard
          </NavLink>
        </div>
      </div>
    </div>
  );
}

