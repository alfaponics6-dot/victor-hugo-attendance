# Automation Studio

A small **React + Vite** web app for building and testing automation rules
right in the browser — define `WHEN <event matches condition> THEN <action>`
rules, fire test events, and watch which rules run.

> This is a standalone project that lives at the repo root. It is independent
> of the attendance app under `client/` and `server/` (see `README.md` for
> that one) and does not share any code with it.

## What it does

- **Reglas** — create rules with a trigger event, an optional condition
  (`field operator value`, e.g. `total > 500`), and an action
  (email / Slack / tag / webhook / task). Toggle them on and off.
- **Ejecutar** — fire a test event with a JSON payload and see how many rules
  matched.
- **Actividad** — chronological log of every event and the actions it
  triggered (capped at the last 200 entries).
- **Métricas** — totals plus a per-rule execution bar chart.

State (rules + activity log) persists in `localStorage`, so there's no backend
to run.

## Run it

```bash
npm install
npm run dev      # http://localhost:5180
```

Other scripts:

```bash
npm run build    # production build → /dist
npm run preview  # serve the production build locally
```

## Layout

```
index.html            Vite entry
vite.config.js        dev server on port 5180
src/
  main.jsx            React root
  App.jsx             state + view routing
  styles.css          all styling (dark theme)
  lib/
    engine.js         event types, operators, actions, matching logic
    storage.js        namespaced localStorage helpers
    seed.js           sample rules for first run
  components/
    Sidebar.jsx  RuleList.jsx  RuleEditor.jsx
    Runner.jsx   ActivityLog.jsx  Stats.jsx
```

## Extending it

The engine is data-driven: add entries to `EVENT_TYPES`, `OPERATORS`, or
`ACTIONS` in `src/lib/engine.js` and they show up across the editor and runner
automatically. The actions are currently simulated (logged, not dispatched);
wiring a real dispatcher would mean handling each `action` id inside
`runEvent` or a downstream consumer of the activity log.
