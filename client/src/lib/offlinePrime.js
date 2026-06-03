// Fire the role-appropriate set of GET endpoints in parallel after a
// successful online login. Each response gets cached by the service
// worker's NetworkFirst /api/* runtime route, so the next offline session
// has a fresh snapshot of everything the user normally reads.
//
// Best-effort: failures are swallowed (slow signal mid-prime is fine —
// next online visit re-primes). Doesn't block the login flow.
//
// Add new prime URLs here as new offline-relevant pages get built.

const todayISO = () => {
  const d = new Date();
  // Use local-time YYYY-MM-DD; the server treats the date as a calendar day,
  // not a timestamp, so we stay consistent with what the page would request.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

function urlsFor({ role, projectId }) {
  const today = todayISO();
  // Endpoints all roles benefit from caching.
  const common = [
    '/api/projects/current-rotation',
    '/api/projects/rotations-schedule',
    '/api/auth/leaders',
  ];

  if (role === 'leader' && projectId) {
    return [
      ...common,
      `/api/projects/${projectId}/current-rotation-students`,
      `/api/projects/${projectId}/students`,
      `/api/projects/${projectId}/available-rotations`,
      `/api/projects/my/collaborators`,
      `/api/attendance/project/${projectId}/date/${today}`,
      // Segunda lista (final pass): warm the existing 'end' passes so the
      // leader's SecondListView seeds its draft offline. URL must match
      // getProfesorAttendance() in api/client.js exactly.
      `/api/profesor-attendance/project/${projectId}/date/${today}`,
    ];
  }
  if (role === 'profesor') {
    return [
      ...common,
      `/api/admin/projects`,
      `/api/admin/absences?date=${today}`,
      `/api/admin/attendance-summary`,
      `/api/statistics/overall?date=${today}`,
      `/api/statistics/by-project?date=${today}`,
    ];
  }
  if (role === 'admin') {
    return [
      ...common,
      `/api/admin/students`,
      `/api/admin/projects`,
      `/api/projects`,
      `/api/statistics/by-project?date=${today}`,
      `/api/statistics/overall?date=${today}`,
    ];
  }
  return common;
}

export async function primeOfflineCache(profile) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (!profile) return;
  const urls = urlsFor({
    role: profile.role || 'leader',
    projectId: profile.projectId,
  });
  // Parallel; SW intercepts each and caches via the api-get route.
  await Promise.allSettled(
    urls.map((url) => fetch(url, { credentials: 'include' }).catch(() => null))
  );
}
