const NAV = [
  { id: 'rules', icon: '⚙️', label: 'Reglas' },
  { id: 'runner', icon: '▶️', label: 'Ejecutar' },
  { id: 'activity', icon: '📜', label: 'Actividad' },
  { id: 'stats', icon: '📊', label: 'Métricas' },
]

export default function Sidebar({ view, setView, stats }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">⚡</span>
        <div>
          <div className="brand-name">Automation Studio</div>
          <div className="brand-sub">motor de reglas</div>
        </div>
      </div>

      <nav>
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${view === item.id ? 'active' : ''}`}
            onClick={() => setView(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
            {item.id === 'rules' && (
              <span className="nav-badge">{stats.active}</span>
            )}
            {item.id === 'activity' && stats.runs > 0 && (
              <span className="nav-badge">{stats.runs}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <div className="stat-mini">
          <strong>{stats.active}</strong> activas / {stats.total}
        </div>
        <div className="stat-mini">
          <strong>{stats.runs}</strong> ejecuciones
        </div>
      </div>
    </aside>
  )
}
