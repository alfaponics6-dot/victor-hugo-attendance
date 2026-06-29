import { EVENT_TYPES, OPERATORS, ACTIONS, labelFor } from '../lib/engine.js'

function conditionText(rule) {
  if (rule.operator === 'any') return 'siempre'
  const op = labelFor(OPERATORS, rule.operator).replace(/^[^\s]+\s/, '')
  return `si ${rule.field || '?'} ${op} "${rule.value}"`
}

export default function RuleList({ rules, stats, onNew, onEdit, onDelete, onToggle }) {
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Reglas de automatización</h1>
          <p className="muted">
            {stats.active} activas de {stats.total}. Cuando un evento coincide con
            la condición, se ejecuta la acción.
          </p>
        </div>
        <button className="btn primary" onClick={onNew}>
          + Nueva regla
        </button>
      </header>

      {rules.length === 0 ? (
        <div className="empty">
          <p>No hay reglas todavía.</p>
          <button className="btn primary" onClick={onNew}>
            Crear la primera regla
          </button>
        </div>
      ) : (
        <ul className="rule-list">
          {rules.map((rule) => (
            <li key={rule.id} className={`rule-card ${rule.enabled ? '' : 'off'}`}>
              <label className="switch" title={rule.enabled ? 'Activa' : 'Inactiva'}>
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={() => onToggle(rule.id)}
                />
                <span className="slider" />
              </label>

              <div className="rule-body" onClick={() => onEdit(rule)}>
                <div className="rule-name">{rule.name || '(sin nombre)'}</div>
                <div className="rule-flow">
                  <span className="chip event">
                    {labelFor(EVENT_TYPES, rule.event)}
                  </span>
                  <span className="chip cond">{conditionText(rule)}</span>
                  <span className="arrow">→</span>
                  <span className="chip action">
                    {labelFor(ACTIONS, rule.action)}
                    {rule.actionTarget ? `: ${rule.actionTarget}` : ''}
                  </span>
                </div>
              </div>

              <div className="rule-actions">
                <button className="btn ghost" onClick={() => onEdit(rule)}>
                  Editar
                </button>
                <button
                  className="btn danger ghost"
                  onClick={() => onDelete(rule.id)}
                >
                  Borrar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
