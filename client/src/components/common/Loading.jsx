import Spinner from '../ui/Spinner';

function Loading({ message = 'Cargando...' }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-[color:var(--color-fg-muted)]">
      <Spinner size="lg" className="text-[color:var(--color-accent)]" />
      <p className="text-sm tracking-tight">{message}</p>
    </div>
  );
}

export default Loading;
