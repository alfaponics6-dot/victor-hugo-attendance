import axios from 'axios';
import { enqueueRequest } from '../lib/syncQueue';
import { cacheCredential, clearLiveCredential, purgeCachedAuth } from '../lib/offlineAuth';
import { primeOfflineCache } from '../lib/offlinePrime';
import { ensurePushSubscription, unsubscribePush } from '../lib/pushSubscribe';
import { count as queueCount } from '../lib/offlineQueue';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

// Endpoints we never queue: they require a synchronous server answer
// (login validates credentials, password change validates current pw).
const NEVER_QUEUE = [
  /\/auth\/login$/,
  /\/auth\/change-password$/,
  /\/auth\/logout$/,
];

function shouldQueue(config) {
  if (!config) return false;
  const method = (config.method || 'get').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return false;
  const url = config.url || '';
  return !NEVER_QUEUE.some((pat) => pat.test(url));
}

// The JWT now lives in an HttpOnly Secure cookie set by the server. The
// client only persists the user profile (so the UI can render its name/role
// before the first /verify round-trip).
const USER_KEY = 'auth_user';

export const getUser = () => {
  const user = localStorage.getItem(USER_KEY);
  return user ? JSON.parse(user) : null;
};

export const setStoredUser = (user) => {
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(USER_KEY);
  }
};

export const clearStoredUser = () => {
  localStorage.removeItem(USER_KEY);
};

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  // Send the auth cookie with every request.
  withCredentials: true,
});

// Piggyback our offline-queue size on every authenticated request via an
// X-Queue-Size header. The server's syncStateTracker middleware reads
// it and updates per-leader sync state — that's what stops the push
// cron from pinging devices whose queue is empty.
api.interceptors.request.use(async (config) => {
  try {
    const n = await queueCount();
    if (Number.isFinite(n)) {
      config.headers = config.headers || {};
      config.headers['X-Queue-Size'] = String(n);
    }
  } catch { /* IDB might not be open yet — drop silently */ }
  return config;
});

// Handle auth errors. 401 = no/expired session → log out and redirect to
// the login page. 403 = session is valid but the resource is forbidden
// (typically cross-project access) → DO NOT log the user out; the calling
// page should surface the error in context.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    // Network failure on a mutating request → enqueue for later replay so
    // the leader doesn't lose their work. Returning an optimistic 202
    // keeps callers happy without touching every page's success path.
    if (!error.response && shouldQueue(error.config)) {
      const cfg = error.config;
      // axios.getUri serializes baseURL + url + params correctly. Hand-
      // concatenating dropped any params (?foo=bar) — currently no
      // mutating call uses them, but a future api.post(url, body,
      // {params}) would silently lose its query string on replay.
      const fullUrl = (typeof api.getUri === 'function')
        ? api.getUri(cfg)
        : (cfg.baseURL || '') + (cfg.url || '');
      const isFormData = typeof FormData !== 'undefined' && cfg.data instanceof FormData;
      let userId = null;
      try {
        userId = JSON.parse(localStorage.getItem('auth_user') || 'null')?.id ?? null;
      } catch { /* malformed cache — ignore */ }
      try {
        const queueId = await enqueueRequest({
          method: cfg.method,
          url: fullUrl,
          headers: cfg.headers,
          data: cfg.data,
          isFormData,
          userId,
        });
        return {
          data: { success: true, _queued: true, _queueId: queueId },
          status: 202,
          statusText: 'Queued (offline)',
          headers: {},
          config: cfg,
        };
      } catch {
        // IndexedDB write failed — surface the original network error so the
        // caller can show its existing failure UI instead of pretending we saved.
      }
    }
    if (error.response?.status === 401) {
      clearStoredUser();
      localStorage.removeItem('leader');
      if (!window.location.pathname.includes('/login') && window.location.pathname !== '/') {
        window.location.href = '/';
      }
    }
    return Promise.reject(error);
  }
);

// Authentication APIs
export const getLeaders = async () => {
  const response = await api.get('/auth/leaders');
  return response.data;
};

export const login = async (leaderId, { password, accessCode } = {}) => {
  const payload = { leaderId };
  if (password) payload.password = password;
  if (accessCode) payload.accessCode = accessCode;

  const response = await api.post('/auth/login', payload);

  if (response.data.leader) {
    setStoredUser(response.data.leader);
    // Cache the credential for offline-login next time. Best-effort —
    // failures here must not block the online login path.
    cacheCredential({
      leaderId,
      credential: password || accessCode,
      profile: response.data.leader,
    }).catch(() => {});
    // Warm the SW runtime cache with role-appropriate GETs so the user's
    // first offline session has data ready (rosters, projects, today's
    // attendance, etc.). Background — don't block navigation.
    primeOfflineCache(response.data.leader).catch(() => {});
    // If notifications are already granted (e.g. from a previous session),
    // make sure the push subscription is current with the server. The
    // request-permission step happens elsewhere — needs a user gesture.
    ensurePushSubscription().catch(() => {});
  }

  return response.data;
};

export const logout = async () => {
  // Clear the in-memory plaintext credential FIRST. If we hit /auth/logout
  // after this and the server takes a moment, another tab's drainQueue
  // could otherwise call silentRelogin with the still-live cred and
  // reissue a cookie for the user we're trying to log out. Killing the
  // cred before the server call closes that window.
  clearLiveCredential();
  try {
    await api.post('/auth/logout');
  } catch {
    // Even if the server call fails, drop local state.
  }
  clearStoredUser();
  // Defense-in-depth: tear down everything else that could leak the
  // previous user's data to whoever logs in next on this device.
  await purgeCachedAuth().catch(() => {});
  await purgeServiceWorkerCaches().catch(() => {});
  // Drop the push subscription so the cron stops poking this device for
  // a leader who may never log back in here.
  await unsubscribePush().catch(() => {});
};

// Ask the active service worker to drop user-scoped runtime caches
// (api-get). The SW's message handler does the actual work; this just
// forwards the request and waits up to a second for it to complete.
async function purgeServiceWorkerCaches() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  const reg = navigator.serviceWorker.controller
    ? { active: navigator.serviceWorker.controller }
    : await navigator.serviceWorker.ready;
  if (!reg.active) return;
  await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(resolve, 1000);
    channel.port1.onmessage = () => { clearTimeout(timer); resolve(); };
    try {
      reg.active.postMessage({ type: 'purge-caches' }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export const changePassword = async (currentPassword, newPassword, confirmPassword) => {
  const response = await api.post('/auth/change-password', {
    currentPassword,
    newPassword,
    confirmPassword
  });
  return response.data;
};

// Project APIs
export const addStudent = async (projectId, studentData) => {
  const response = await api.post(`/projects/${projectId}/students`, studentData);
  return response.data;
};

export const updateStudent = async (studentId, studentData) => {
  const response = await api.put(`/projects/students/${studentId}`, studentData);
  return response.data;
};

export const deleteStudent = async (studentId) => {
  const response = await api.delete(`/projects/students/${studentId}`);
  return response.data;
};

// Rotation APIs
export const getCurrentRotation = async () => {
  const response = await api.get('/projects/current-rotation');
  return response.data;
};

export const getStudentsByRotation = async (projectId, rotationNumber) => {
  const response = await api.get(`/projects/${projectId}/rotations/${rotationNumber}/students`);
  return response.data;
};

export const getCurrentRotationStudents = async (projectId) => {
  const response = await api.get(`/projects/${projectId}/current-rotation-students`);
  return response.data;
};

export const getAvailableRotations = async (projectId) => {
  const response = await api.get(`/projects/${projectId}/available-rotations`);
  return response.data;
};

export const getRotationsSchedule = async () => {
  const response = await api.get('/projects/rotations-schedule');
  return response.data;
};

// Same-project teammates of the requesting leader. Used by the Correos tab
// to populate the Cc list. Returns [] for admin/profesor (no project_id).
export const getMyCollaborators = async () => {
  const response = await api.get('/projects/my/collaborators');
  return response.data;
};

export const getStudentAttendanceHistory = async (studentId) => {
  const response = await api.get(`/projects/students/${studentId}/attendance`);
  return response.data;
};

// Alerts APIs
export const getStudentsWithLowAttendance = async (projectId, threshold = 75) => {
  const response = await api.get(`/projects/${projectId}/alerts/low-attendance`, {
    params: { threshold }
  });
  return response.data;
};

export const getStudentsWithConsecutiveAbsences = async (projectId, days = 3) => {
  const response = await api.get(`/projects/${projectId}/alerts/consecutive-absences`, {
    params: { days }
  });
  return response.data;
};

// Attendance APIs
export const markAttendance = async (attendanceData) => {
  if (attendanceData.attachment && attendanceData.attachment instanceof File) {
    const formData = new FormData();
    Object.keys(attendanceData).forEach(key => {
      if (attendanceData[key] !== null && attendanceData[key] !== undefined) {
        formData.append(key, attendanceData[key]);
      }
    });
    const response = await api.post('/attendance', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  } else {
    const response = await api.post('/attendance', attendanceData);
    return response.data;
  }
};

// Bulk mark attendance for multiple students
export const markBulkAttendance = async (projectId, leaderId, date, time, records) => {
  // projectId and leaderId are accepted for backwards compatibility but the
  // server overrides them from the JWT.
  const response = await api.post('/attendance/bulk', {
    date,
    time,
    records
  });
  return response.data;
};

// Resolve a queued-offline attendance conflict. Replaces the existing rows
// for (project, date) with the merged payload the leader picked. The
// server writes an audit row so the override is reviewable later.
export const resolveAttendanceBulk = async ({ date, time, records, resolution }) => {
  const response = await api.post('/attendance/bulk/resolve', {
    date, time, records, resolution,
  });
  return response.data;
};

export const getAttendanceByProjectAndDate = async (projectId, date) => {
  const response = await api.get(`/attendance/project/${projectId}/date/${date}`);
  return response.data;
};

export const getAttendanceByStudent = async (studentId) => {
  const response = await api.get(`/attendance/student/${studentId}`);
  return response.data;
};

export const getAttachmentUrl = (studentId, date) => {
  return `${API_BASE_URL}/attendance/attachment/${studentId}/${date}`;
};

// Profesor-only attendance "passes". Each session day can have a start
// pass and an end pass per student, both marked by a profesor.
export const getProfesorAttendance = async (projectId, date) => {
  const response = await api.get(`/profesor-attendance/project/${projectId}/date/${date}`);
  return response.data;
};

export const bulkSaveProfesorAttendance = async ({ projectId, date, passType, entries }) => {
  const response = await api.post(`/profesor-attendance/bulk`, {
    projectId,
    date,
    passType,
    entries,
  });
  return response.data;
};

// Coordinator-only oversight: per-project start/end pass status for a date.
export const getProfesorAttendanceCompliance = async (date) => {
  const response = await api.get(`/profesor-attendance/compliance/${date}`);
  return response.data;
};

// Statistics APIs.
// Pass either { date } for single-date stats, or { startDate, endDate } for
// range stats (inclusive on both ends).
export const getOverallStatistics = async (arg) => {
  const params = typeof arg === 'string' ? { date: arg } : (arg || {});
  const response = await api.get('/statistics/overall', { params });
  return response.data;
};

export const getProjectStatistics = async (arg) => {
  const params = typeof arg === 'string' ? { date: arg } : (arg || {});
  const response = await api.get('/statistics/by-project', { params });
  return response.data;
};

export const getAttendanceHistory = async (days = 7) => {
  const response = await api.get('/statistics/history', {
    params: { days }
  });
  return response.data;
};

export const getDetailedStudentData = async (date) => {
  const response = await api.get('/statistics/students-detail', {
    params: date ? { date } : {}
  });
  return response.data;
};

// Admin APIs (require admin JWT)
export const getAllStudentsAdmin = async () => {
  const response = await api.get('/admin/students');
  return response.data;
};

export const deleteStudentAdmin = async (id) => {
  const response = await api.delete(`/admin/students/${id}`);
  return response.data;
};

// Profesor APIs
export const getAbsentStudents = async (date = null, projectId = null, justification = null) => {
  const params = {};
  if (date) params.date = date;
  if (projectId) params.projectId = projectId;
  if (justification) params.justification = justification;

  const response = await api.get('/admin/absences', { params });
  return response.data;
};

export const getAllProjectsAdmin = async () => {
  const response = await api.get('/admin/projects');
  return response.data;
};

export const getAttendanceSummaryAdmin = async (startDate = null, endDate = null, projectId = null) => {
  const params = {};
  if (startDate) params.startDate = startDate;
  if (endDate) params.endDate = endDate;
  if (projectId) params.projectId = projectId;

  const response = await api.get('/admin/attendance-summary', { params });
  return response.data;
};

export default api;
