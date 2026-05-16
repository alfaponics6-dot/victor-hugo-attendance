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
  useEffect(() => {
    if (!leader?.id) return;
    let cancelled = false;
    api.get('/auth/verify')
      .then((r) => {
        if (cancelled || !r.data?.user) return;
        const u = r.data.user;
        const merged = {
          ...leader,
          // Server fields use snake_case for some payloads, but /verify hands
          // back camelCase already. Overlay whatever differs.
          id: u.id,
          name: u.name,
          email: u.email ?? leader.email ?? null,
          projectId: u.projectId,
          projectName: u.projectName,
          projectNumber: u.projectNumber,
          role: u.role,
          // Default to true when missing so older cached profiles don't
          // accidentally hide UI from users who still have the permission.
          canDeleteStudents: u.canDeleteStudents !== false,
        };
        setLeader(merged);
        setStoredUser(merged);
      })
      .catch(() => { /* 401 → interceptor logs out; other errors ignored */ });
    return () => { cancelled = true; };
    // Intentionally fire once at mount; we don't want to re-verify on every
    // leader update or we'd loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loginLeader = (leaderData) => {
    setLeader(leaderData);
    localStorage.setItem('auth_user', JSON.stringify(leaderData));
  };

  const logout = async () => {
    setLeader(null);
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
