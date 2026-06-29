import { useState } from 'react'
import { EVENT_TYPES, labelFor } from '../lib/engine.js'

const PRESETS = {
  'user.signup': '{\n  "email": "ana@empresa.com",\n  "plan": "pro"\n}',
  'order.created': '{\n  "total": 720,\n  "currency": "USD"\n}',
  'payment.received': '{\n  "amount": 99,\n  "method": "card"\n}',
  'ticket.opened': '{\n  "priority": "urgent",\n  "topic": "login"\n}',
  'form.submitted': '{\n  "form": "contacto",\n  "score": 8\n}',
}

export default function Runner({ rules, onFire }) {
  const [event, setEvent] = useState('order.created')
  const [text, setText] = useState(PRESETS['order.created'])
  const [feedback, setFeedback] = useState(null)

  const candidateCount = rules.filter((r) => r.enabled && r.event === event).length

  function pickEvent(id) {
    setEvent(id)
    setText(PRESETS[id] ?? '{\n  \n}')
    setFeedback(null)
  }

  function fire() {
    let payload
    try {
      payload = JSON.parse(text || '{}')
    } catch {
      setFeedback({ ok: false, msg: 'El JSON del payload no es válido.' })
      return
    }
    const fired = onFire(event, payload)
    setFeedback({
      ok: true,
      msg:
        fired > 0
          ? `✓ ${fired} regla(s) ejecutada(s). Mirá la pestaña Actividad.`
          : 'Ninguna regla coincidió con este evento.',
    })
  }

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Ejecutar evento</h1>
          <p className="muted">
            Dispará un evento de prueba y observá qué reglas se activan.
          </p>
        </div>
      </header>

      <div className="runner">
        <label className="field">
          <span>Tipo de evento</span>
          <select value={event} onChange={(e) => pickEvent(e.target.value)}>
            {EVENT_TYPES.map((ev) => (
              <option key={ev.id} value={ev.id}>
                {ev.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Payload (JSON)</span>
          <textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
        </label>

        <p className="muted">
          {candidateCount} regla(s) activa(s) escuchan{' '}
          <strong>{labelFor(EVENT_TYPES, event)}</strong>.
        </p>

        <button className="btn primary big" onClick={fire}>
          ▶ Disparar evento
        </button>

        {feedback && (
          <p className={feedback.ok ? 'feedback ok' : 'feedback err'}>
            {feedback.msg}
          </p>
        )}
      </div>
    </section>
  )
}
