import { EVENT_TYPES, labelFor } from '../lib/engine.js'

export default function Stats({ rules, stats }) {
  const ranked = [...rules]
    .map((r) => ({ rule: r, count: stats.byRule[r.id] || 0 }))
    .sort((a, b) => b.count - a.count)
  const max = Math.max(1, ...ranked.map((r) => r.count))

  return (
    <section>
      <header className="page-head">
        <h1>Métricas</h1>
      </header>

      <div className="cards">
        <div className="card">
          <div className="card-num">{stats.total}</div>
          <div className="card-label">Reglas totales</div>
        </div>
        <div className="card">
          <div className="card-num">{stats.active}</div>
          <div className="card-label">Reglas activas</div>
        </div>
        <div className="card">
          <div className="card-num">{stats.runs}</div>
          <div className="card-label">Ejecuciones</div>
        </div>
      </div>

      <h2 className="section-title">Ejecuciones por regla</h2>
      {ranked.length === 0 ? (
        <p className="muted">No hay reglas para mostrar.</p>
      ) : (
        <ul className="bars">
          {ranked.map(({ rule, count }) => (
            <li key={rule.id} className="bar-row">
              <div className="bar-label">
                <span>{rule.name || '(sin nombre)'}</span>
                <small className="muted">{labelFor(EVENT_TYPES, rule.event)}</small>
              </div>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: `${(count / max) * 100}%` }}
                />
              </div>
              <div className="bar-count">{count}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
