import { uid } from './storage.js'

// Sample rules so a first-time visitor sees a working automation set rather
// than an empty screen.
export function seedRules() {
  return [
    {
      id: uid(),
      name: 'Bienvenida a nuevos usuarios',
      enabled: true,
      event: 'user.signup',
      operator: 'any',
      field: '',
      value: '',
      action: 'send_email',
      actionTarget: 'plantilla:bienvenida',
    },
    {
      id: uid(),
      name: 'Alerta de orden grande',
      enabled: true,
      event: 'order.created',
      operator: 'gt',
      field: 'total',
      value: '500',
      action: 'send_slack',
      actionTarget: '#ventas',
    },
    {
      id: uid(),
      name: 'Escalar tickets urgentes',
      enabled: true,
      event: 'ticket.opened',
      operator: 'eq',
      field: 'priority',
      value: 'urgent',
      action: 'create_task',
      actionTarget: 'equipo-soporte',
    },
  ]
}
