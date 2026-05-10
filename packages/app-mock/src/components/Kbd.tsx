export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-block rounded border border-bark-500 bg-bark-700 px-1.5 py-0.5 text-[10px] font-mono text-bark-200 shadow-[inset_0_-1px_0_rgba(0,0,0,0.4)]">
      {children}
    </kbd>
  );
}

export function KeyCombo({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((k, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {i > 0 && <span className="text-bark-400 text-[10px]">+</span>}
          <Kbd>{k}</Kbd>
        </span>
      ))}
    </span>
  );
}
