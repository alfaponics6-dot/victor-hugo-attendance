import { useEffect, useMemo, useState } from 'react'
import { load, save, uid } from './lib/storage.js'
import { seedRules } from './lib/seed.js'
import { runEvent } from './lib/engine.js'
import Sidebar from './components/Sidebar.jsx'
import RuleList from './components/RuleList.jsx'
import RuleEditor from './components/RuleEditor.jsx'
import Runner from './components/Runner.jsx'
import ActivityLog from './components/ActivityLog.jsx'
import Stats from './components/Stats.jsx'

const MAX_LOG = 200

function emptyRule() {
  return {
    id: uid(),
    name: '',
    enabled: true,
    event: 'user.signup',
    operator: 'any',
    field: '',
    value: '',
    action: 'send_email',
    actionTarget: '',
  }
}

export default function App() {
  const [view, setView] = useState('rules')
  const [rules, setRules] = useState(() => load('rules', null) ?? seedRules())
  const [log, setLog] = useState(() => load('log', []))
  const [editing, setEditing] = useState(null) // rule object or null

  useEffect(() => save('rules', rules), [rules])
  useEffect(() => save('log', log), [log])

  const stats = useMemo(() => {
    const total = rules.length
    const active = rules.filter((r) => r.enabled).length
    const runs = log.length
    const byRule = {}
    for (const entry of log) {
      byRule[entry.ruleId] = (byRule[entry.ruleId] || 0) + 1
    }
    return { total, active, runs, byRule }
  }, [rules, log])

  function upsertRule(rule) {
    setRules((prev) => {
      const exists = prev.some((r) => r.id === rule.id)
      return exists ? prev.map((r) => (r.id === rule.id ? rule : r)) : [...prev, rule]
    })
    setEditing(null)
  }

  function deleteRule(id) {
    setRules((prev) => prev.filter((r) => r.id !== id))
    if (editing?.id === id) setEditing(null)
  }

  function toggleRule(id) {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
    )
  }

  function fire(event, payload) {
    const runs = runEvent({ rules, event, payload })
    if (runs.length === 0) {
      setLog((prev) =>
        [
          {
            id: uid(),
            kind: 'no-match',
            event,
            payload,
            at: new Date().toISOString(),
          },
          ...prev,
        ].slice(0, MAX_LOG),
      )
      return 0
    }
    setLog((prev) =>
      [...runs.map((r) => ({ id: uid(), kind: 'run', ...r })), ...prev].slice(
        0,
        MAX_LOG,
      ),
    )
    return runs.length
  }

  function clearLog() {
    setLog([])
  }

  return (
    <div className="app">
      <Sidebar view={view} setView={setView} stats={stats} />
      <main className="content">
        {view === 'rules' && !editing && (
          <RuleList
            rules={rules}
            stats={stats}
            onNew={() => setEditing(emptyRule())}
            onEdit={setEditing}
            onDelete={deleteRule}
            onToggle={toggleRule}
          />
        )}
        {view === 'rules' && editing && (
          <RuleEditor
            rule={editing}
            onSave={upsertRule}
            onCancel={() => setEditing(null)}
          />
        )}
        {view === 'runner' && <Runner rules={rules} onFire={fire} />}
        {view === 'activity' && <ActivityLog log={log} onClear={clearLog} />}
        {view === 'stats' && <Stats rules={rules} stats={stats} />}
      </main>
    </div>
  )
}
