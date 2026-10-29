export function DashboardBootstrapLoading() {
  return (
    <main
      className="min-h-screen grid place-items-center bg-[var(--soft)] text-[var(--border-color)] font-bold text-lg"
      role="status"
      aria-live="polite"
    >
      <span>正在展开你的词环…</span>
    </main>
  );
}
