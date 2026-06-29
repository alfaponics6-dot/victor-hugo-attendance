// The automation engine. A rule is:
//   { id, name, enabled, event, field, operator, value, action, actionTarget }
// When an event is fired, every enabled rule whose `event` matches and whose
// condition (field/operator/value) holds against the event payload "runs",
// producing an action outcome.

export const EVENT_TYPES = [
  { id: 'user.signup', label: 'Usuario se registra' },
  { id: 'order.created', label: 'Orden creada' },
  { id: 'payment.received', label: 'Pago recibido' },
  { id: 'ticket.opened', label: 'Ticket de soporte abierto' },
  { id: 'form.submitted', label: 'Formulario enviado' },
]

export const OPERATORS = [
  { id: 'eq', label: '= igual a' },
  { id: 'ne', label: '≠ distinto de' },
  { id: 'gt', label: '> mayor que' },
  { id: 'lt', label: '< menor que' },
  { id: 'contains', label: 'contiene' },
  { id: 'any', label: 'siempre (sin condición)' },
]

export const ACTIONS = [
  { id: 'send_email', label: 'Enviar email' },
  { id: 'send_slack', label: 'Notificar en Slack' },
  { id: 'add_tag', label: 'Agregar etiqueta' },
  { id: 'webhook', label: 'Llamar webhook' },
  { id: 'create_task', label: 'Crear tarea' },
]

export function labelFor(list, id) {
  return list.find((x) => x.id === id)?.label ?? id
}

function coerce(a, b) {
  // If both sides look numeric, compare as numbers; otherwise as strings.
  const na = Number(a)
  const nb = Number(b)
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return [na, nb]
  }
  return [String(a ?? ''), String(b ?? '')]
}

export function conditionMatches(rule, payload) {
  if (rule.operator === 'any') return true
  const raw = payload?.[rule.field]
  if (raw === undefined) return false
  const [a, b] = coerce(raw, rule.value)
  switch (rule.operator) {
    case 'eq':
      return a === b
    case 'ne':
      return a !== b
    case 'gt':
      return a > b
    case 'lt':
      return a < b
    case 'contains':
      return String(raw).toLowerCase().includes(String(rule.value).toLowerCase())
    default:
      return false
  }
}

// Evaluate one event against all rules. Returns an array of run records for the
// rules that fired.
export function runEvent({ rules, event, payload, now }) {
  const ts = now ?? new Date().toISOString()
  const matched = rules.filter(
    (r) => r.enabled && r.event === event && conditionMatches(r, payload),
  )
  return matched.map((r) => ({
    ruleId: r.id,
    ruleName: r.name,
    event,
    payload,
    action: r.action,
    actionTarget: r.actionTarget,
    at: ts,
  }))
}

export function describeAction(run) {
  const target = run.actionTarget ? ` → ${run.actionTarget}` : ''
  return `${labelFor(ACTIONS, run.action)}${target}`
}
