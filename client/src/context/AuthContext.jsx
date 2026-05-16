import { useEffect, useState } from 'react';
import api, { logout as logoutApi, clearStoredUser, getUser, setStoredUser } from '../api/client';
import { AuthContext } from './useAuth.js';

// Reads any persisted user. Migrates the legacy "leader" key to "auth_user"
// on first read so existing tabs survive the upgrade. Runs synchronously
// during render so the initial paint already has the right user.
const loadInitialLeader = () => {
  const storedUser = getUser();
  if (storedUser) return storedUser;
  const legacyLeader = localStorage.getItem('leader');
  if (!legacyLeader) return null;
  try {
    const parsed = JSON.parse(legacyLeader);
    localStorage.setItem('auth_user', legacyLeader);
    localStorage.removeItem('leader');
    return parsed;
  } catch {
    localStorage.removeItem('leader');
    return null;
  }
};

export const AuthProvider = ({ children }) => {
  const [leader, setLeader] = useState(loadInitialLeader);
  // Persisted user is loaded synchronously in the useState initializer above,
  // so consumers never need to wait for an "auth loading" intermediate state.
  const loading = false;

  // Background refresh: when the app boots with a cached user, ask /verify
  // for the latest server-side row. This picks up new fields (email, role
  // changes, project moves) without forcing a logout. Silent on failure —
  // the 401 interceptor already handles expired sessions.
  //
  // The boot-time leader.id is captured into `bootId` so a slow /verify
  // can't clobber a fresh login that lands first (user logs out, signs
  // back in as a different account, then the stale /verify resolves and
  // would otherwise overwrite the new identity with the old one's
  // server-side fields). We compare against the latest leader via the
  // functional setState updater and bail out if the identity changed.
  useEffect(() => {
    const bootId = leader?.id;
    if (!bootId) return;
    let cancelled = false;
    api.get('/auth/verify')
      .then((r) => {
        if (cancelled || !r.data?.user) return;
        const u = r.data.user;
        // Drop the response if the user identity changed mid-flight
        // (logout / fresh login as someone else). Also drop if /verify
        // returned a DIFFERENT user than we booted with — that would
        // mean the server cookie was rotated to another account, which
        // is more wrong than just ignoring.
        if (u.id !== bootId) return;
        setLeader((current) => {
          if (!current || current.id !== bootId) return current;
          const merged = {
            ...current,
            // Server fields use snake_case for some payloads, but /verify
            // hands back camelCase already. Overlay whatever differs.
            id: u.id,
            name: u.name,
            email: u.email ?? current.email ?? null,
            projectId: u.projectId,
            projectName: u.projectName,
            projectNumber: u.projectNumber,
            role: u.role,
            // Default to true when missing so older cached profiles don't
            // accidentally hide UI from users who still have the permission.
            canDeleteStudents: u.canDeleteStudents !== false,
            // Coordinator flag — gates the Supervisión tab in the profe
            // dashboard. Default false so a non-coordinator with a stale
            // profile never sees the supervisor UI by accident.
            isCoordinator: u.isCoordinator === true,
          };
          setStoredUser(merged);
          return merged;
        });
      })
      .catch(() => { /* 401 → interceptor logs out; other errors ignored */ });
    return () => { cancelled = true; };
    // Intentionally fire once at mount; we don't want to re-verify on every
    // leader update or we'd loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loginLeader = (leaderData) => {
    setLeader(leaderData);
    // Use the shared helper so the storage key constant (USER_KEY) stays
    // owned by api/client.js. Writing the legacy 'auth_user' string here
    // worked but silently diverged the moment USER_KEY changes.
    setStoredUser(leaderData);
  };

  const logout = async () => {
    setLeader(null);
    // Clear local state first so any sync render reads a logged-out user.
    // logoutApi() handles cookie revocation, cached creds, push, and the
    // service-worker user-scoped caches — see api/client.js.
    localStorage.removeItem('leader');
    clearStoredUser();
    await logoutApi();
  };

  const isAdmin = () => leader?.role === 'admin';
  const isProfesor = () => leader?.role === 'profesor';

  return (
    <AuthContext.Provider value={{ leader, loginLeader, logout, loading, isAdmin, isProfesor }}>
      {children}
    </AuthContext.Provider>
  );
};
