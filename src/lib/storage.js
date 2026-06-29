// Thin localStorage wrapper. Everything is namespaced so the app can share a
// browser origin with other tools without colliding.
const PREFIX = 'automation-studio:'

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Quota or private-mode failures are non-fatal — the app keeps working
    // in-memory for the current session.
  }
}

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}
