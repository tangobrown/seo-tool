export function SkeletonRows({ rows = 5, height = 49 }: { rows?: number; height?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center border-b border-line px-1.5" style={{ height }}>
          <div className="h-3 w-2/5 animate-pulse rounded bg-hover" />
        </div>
      ))}
    </div>
  );
}
