export function PlaceholderPage(props: { title: string; subtitle?: string }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <div className="text-sm font-medium">{props.title}</div>
        <div className="mt-1 text-sm text-slate-300">{props.subtitle ?? "Coming soon."}</div>
      </div>
    </div>
  );
}

