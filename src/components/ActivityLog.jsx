import { EVENT_TYPES, labelFor, describeAction } from '../lib/engine.js'

function time(iso) {
  try {
    return new Date(iso).toLocaleTimeString('es', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}

export default function ActivityLog({ log, onClear }) {
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Actividad</h1>
          <p className="muted">Historial de eventos y ejecuciones (máx. 200).</p>
        </div>
        {log.length > 0 && (
          <button className="btn ghost" onClick={onClear}>
            Limpiar
          </button>
        )}
      </header>

      {log.length === 0 ? (
        <div className="empty">
          <p>Sin actividad todavía. Dispará un evento desde la pestaña Ejecutar.</p>
        </div>
      ) : (
        <ul className="log">
          {log.map((entry) => (
            <li key={entry.id} className={`log-row ${entry.kind}`}>
              <span className="log-time">{time(entry.at)}</span>
              {entry.kind === 'run' ? (
                <span className="log-text">
                  <span className="dot ok" />
                  <strong>{entry.ruleName}</strong> ·{' '}
                  {labelFor(EVENT_TYPES, entry.event)} →{' '}
                  <em>{describeAction(entry)}</em>
                </span>
              ) : (
                <span className="log-text">
                  <span className="dot muted" />
                  {labelFor(EVENT_TYPES, entry.event)} — ninguna regla coincidió
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
