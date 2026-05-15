import { openDB } from 'idb';

// IndexedDB-backed FIFO queue for write requests that failed because the
// device was offline. The schema is intentionally narrow — adding fields
// later is OK (idb handles missing fields), but renaming would force a
// version bump.
const DB_NAME = 'victorhugo-offline';
const DB_VERSION = 2;
const STORE_PENDING = 'pending_requests';
const STORE_CONFLICTS = 'conflicts';
const STORE_AUTH = 'cached_auth';

let dbPromise;

// Single shared DB across queue + offline-auth so we don't fight over the
// version number. New stores get added inside this upgrade callback.
//
// `blocked` and `terminated` callbacks defend against multi-tab edge
// cases: a tab on an older DB_VERSION blocks a newer tab's upgrade
// indefinitely (`blocked`), and a tab whose IDB was force-closed by the
// browser (`terminated`) needs to reopen on next call.
export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_PENDING)) {
          db.createObjectStore(STORE_PENDING, {
            keyPath: 'id',
            autoIncrement: true,
          });
        }
        if (!db.objectStoreNames.contains(STORE_CONFLICTS)) {
          db.createObjectStore(STORE_CONFLICTS, {
            keyPath: 'id',
            autoIncrement: true,
          });
        }
        if (!db.objectStoreNames.contains(STORE_AUTH)) {
          // Keyed by leaderId so the same device can have multiple cached
          // identities (e.g. an admin who occasionally logs in as a leader).
          db.createObjectStore(STORE_AUTH, { keyPath: 'leaderId' });
        }
      },
      blocked() {
        // Another tab is holding the old schema open. Without an escape
        // path our enqueue/replay hangs forever. Reload this tab so it
        // can pick up the new schema cleanly.
        if (typeof window !== 'undefined' && window.location?.reload) {
          window.location.reload();
        }
      },
      terminated() {
        // Browser closed our connection (e.g. iOS aggressive eviction).
        // Drop the cached promise so the next call reopens.
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}

// FormData is not structured-cloneable in a useful way (axios already
// serialized the multipart body, but we want the original fields/files for
// replay). Convert to a plain object: {fields: {...}, files: {key: File}}.
async function serializeBody(data, isFormData) {
  if (!isFormData) return { kind: 'json', body: data ?? null };
  if (!(data instanceof FormData)) {
    // Caller flagged FormData but passed something else — store as-is.
    return { kind: 'json', body: data ?? null };
  }
  const fields = {};
  const files = {};
  for (const [key, value] of data.entries()) {
    if (value instanceof File || value instanceof Blob) {
      files[key] = value;
    } else {
      fields[key] = value;
    }
  }
  return { kind: 'formdata', fields, files };
}

function deserializeBody(serialized) {
  if (!serialized) return { isFormData: false, body: null };
  if (serialized.kind === 'json') {
    return { isFormData: false, body: serialized.body };
  }
  const fd = new FormData();
  for (const [k, v] of Object.entries(serialized.fields || {})) fd.append(k, v);
  for (const [k, file] of Object.entries(serialized.files || {})) fd.append(k, file);
  return { isFormData: true, body: fd };
}

export async function enqueue({ method, url, headers, data, isFormData, userId }) {
  const db = await getDB();
  const serializedBody = await serializeBody(data, isFormData);
  const record = {
    method: (method || 'POST').toUpperCase(),
    url,
    // Strip non-serializable headers axios adds (Content-Type for FormData
    // is regenerated on replay with a new boundary; auth cookie travels
    // automatically with credentials: include).
    headers: stripHeaders(headers),
    body: serializedBody,
    userId: userId ?? null,
    createdAt: Date.now(),
    retries: 0,
  };
  const id = await db.add(STORE_PENDING, record);
  return id;
}

function stripHeaders(headers) {
  if (!headers) return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'content-type' || lower === 'content-length') continue;
    if (lower === 'authorization') out[k] = v;
    else if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export async function peekAll() {
  const db = await getDB();
  const all = await db.getAll(STORE_PENDING);
  return all.map((r) => ({ ...r, ...deserializeBody(r.body) }));
}

export async function count() {
  const db = await getDB();
  return db.count(STORE_PENDING);
}

export async function removeById(id) {
  const db = await getDB();
  return db.delete(STORE_PENDING, id);
}

// Returns the new retry count, or null if the record is gone (deleted
// by a concurrent drain in another tab / by Safari's storage eviction).
// Callers MUST treat null as "skip this item — already handled".
export async function bumpRetries(id) {
  const db = await getDB();
  const record = await db.get(STORE_PENDING, id);
  if (!record) return null;
  record.retries = (record.retries || 0) + 1;
  await db.put(STORE_PENDING, record);
  return record.retries;
}

// Record a conflict (server returned 409 on replay) so a UI can surface it
// later. Phase 3 will wire up a resolver dialog; for now we just preserve
// the data so the leader doesn't lose it silently.
export async function recordConflict({ url, method, body, serverMessage, serverStatus }) {
  const db = await getDB();
  return db.add(STORE_CONFLICTS, {
    url,
    method,
    body,
    serverMessage: serverMessage ?? null,
    serverStatus: serverStatus ?? 409,
    createdAt: Date.now(),
  });
}

// Conflicts are not replayed automatically — they're shown to a human
// resolver, which expects the original wrapper shape ({kind, body} or
// {kind, fields, files}). Don't deserialize here or the resolver loses
// the discriminator it uses to render the right UI.
export async function listConflicts() {
  const db = await getDB();
  return db.getAll(STORE_CONFLICTS);
}

export async function conflictCount() {
  const db = await getDB();
  return db.count(STORE_CONFLICTS);
}

export async function removeConflict(id) {
  const db = await getDB();
  return db.delete(STORE_CONFLICTS, id);
}

export async function estimateUsage() {
  if (!navigator.storage?.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
