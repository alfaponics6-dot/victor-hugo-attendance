import { useState } from 'react'
import { EVENT_TYPES, OPERATORS, ACTIONS } from '../lib/engine.js'

export default function RuleEditor({ rule, onSave, onCancel }) {
  const [draft, setDraft] = useState(rule)
  const [error, setError] = useState('')

  function set(field, value) {
    setDraft((d) => ({ ...d, [field]: value }))
  }

  const needsCondition = draft.operator !== 'any'

  function submit(e) {
    e.preventDefault()
    if (!draft.name.trim()) {
      setError('Poné un nombre para la regla.')
      return
    }
    if (needsCondition && !draft.field.trim()) {
      setError('Indicá el campo del evento a evaluar (ej. total, priority).')
      return
    }
    onSave({ ...draft, name: draft.name.trim() })
  }

  return (
    <section>
      <header className="page-head">
        <h1>{rule.name ? 'Editar regla' : 'Nueva regla'}</h1>
      </header>

      <form className="editor" onSubmit={submit}>
        <label className="field">
          <span>Nombre</span>
          <input
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Ej. Alerta de orden grande"
            autoFocus
          />
        </label>

        <fieldset className="block">
          <legend>CUANDO</legend>
          <label className="field">
            <span>Evento</span>
            <select value={draft.event} onChange={(e) => set('event', e.target.value)}>
              {EVENT_TYPES.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.label}
                </option>
              ))}
            </select>
          </label>

          <div className="row">
            <label className="field">
              <span>Condición</span>
              <select
                value={draft.operator}
                onChange={(e) => set('operator', e.target.value)}
              >
                {OPERATORS.map((op) => (
                  <option key={op.id} value={op.id}>
                    {op.label}
                  </option>
                ))}
              </select>
            </label>

            {needsCondition && (
              <>
                <label className="field">
                  <span>Campo</span>
                  <input
                    value={draft.field}
                    onChange={(e) => set('field', e.target.value)}
                    placeholder="total"
                  />
                </label>
                <label className="field">
                  <span>Valor</span>
                  <input
                    value={draft.value}
                    onChange={(e) => set('value', e.target.value)}
                    placeholder="500"
                  />
                </label>
              </>
            )}
          </div>
        </fieldset>

        <fieldset className="block">
          <legend>ENTONCES</legend>
          <div className="row">
            <label className="field">
              <span>Acción</span>
              <select value={draft.action} onChange={(e) => set('action', e.target.value)}>
                {ACTIONS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field grow">
              <span>Destino / parámetro</span>
              <input
                value={draft.actionTarget}
                onChange={(e) => set('actionTarget', e.target.value)}
                placeholder="#ventas, equipo@empresa.com, https://hook…"
              />
            </label>
          </div>
        </fieldset>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          Regla activa
        </label>

        {error && <p className="error">{error}</p>}

        <div className="editor-actions">
          <button type="submit" className="btn primary">
            Guardar
          </button>
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </form>
    </section>
  )
}
