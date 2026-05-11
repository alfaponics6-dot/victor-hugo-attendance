#!/usr/bin/env node
/**
 * Concurrent-attendance load test. Simulates every leader submitting bulk
 * attendance for their current rotation at the same moment.
 *
 * Usage:
 *   node scripts/load-test-attendance.js                # one wave, today
 *   node scripts/load-test-attendance.js --waves=3      # multiple waves
 *   node scripts/load-test-attendance.js --date=2026-04-29
 *
 * The script:
 *   1. Hits /api/auth/leaders to learn the leader IDs.
 *   2. Logs each leader in (parallel) to get a session cookie.
 *   3. Fetches each leader's current rotation roster.
 *   4. Submits bulk attendance for every leader concurrently and records
 *      timings, status codes, and per-leader outcomes.
 *
 * The DB has a UNIQUE(student_id, date) constraint, so if attendance for the
 * test date already exists the API returns 409. The test treats 200, 409 and
 * 429 as "system stayed up" (the latter means rate limiting caught us) and
 * reports any 5xx or hang as a failure.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const BASE = process.env.BASE || 'http://localhost:3000/api';
const ACCESS_CODE = process.env.LEADER_ACCESS_CODE || 'EARTHFOREST2026';
const WAVES = parseInt(args.waves) || 1;
const DATE = args.date || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
const TIME = '09:00';

const fmt = (n) => Number(n).toFixed(0).padStart(4);
const pct = (n, total) => `${(n / total * 100).toFixed(1)}%`;

// Tiny cookie jar — we only ever need the auth_token, so a string is fine.
const parseSetCookie = (header) => {
  if (!header) return '';
  const m = header.match(/auth_token=([^;]+)/);
  return m ? `auth_token=${m[1]}` : '';
};

const fetchJson = async (url, opts = {}, cookie = '') => {
  const t0 = Date.now();
  let res, body;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }), ...(opts.headers || {}) },
    });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    return { status: 0, body: { error: e.message }, ms: Date.now() - t0, setCookie: '' };
  }
  return {
    status: res.status,
    body,
    ms: Date.now() - t0,
    setCookie: parseSetCookie(res.headers.get('set-cookie')),
  };
};

async function loginLeader(leader) {
  const r = await fetchJson(`${BASE}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ leaderId: leader.id, accessCode: ACCESS_CODE }),
  });
  if (r.status !== 200) return null;
  return { ...leader, cookie: r.setCookie };
}

async function fetchRoster(leader) {
  const r = await fetchJson(`${BASE}/projects/${leader.project_id}/current-rotation-students`, {}, leader.cookie);
  if (r.status !== 200) return [];
  return Array.isArray(r.body.students) ? r.body.students : [];
}

async function submitBulk(leader, roster) {
  // ~88% present, 12% absent — same distribution as the mock attendance.
  const records = roster.map(s => {
    const present = Math.random() < 0.88;
    return {
      studentId: s.id,
      status: present ? 'present' : 'absent',
      justification: present ? null : (Math.random() < 0.3 ? 'justificada' : 'injustificada'),
      observation: null,
    };
  });
  return fetchJson(
    `${BASE}/attendance/bulk`,
    { method: 'POST', body: JSON.stringify({ date: DATE, time: TIME, records }) },
    leader.cookie
  );
}

(async () => {
  console.log(`Load test against ${BASE}`);
  console.log(`Date: ${DATE}, Waves: ${WAVES}`);
  console.log();

  // 1. discover leaders
  const ldRes = await fetchJson(`${BASE}/auth/leaders`);
  if (!Array.isArray(ldRes.body)) {
    console.error(`Failed to fetch leaders: HTTP ${ldRes.status} body=${JSON.stringify(ldRes.body).slice(0, 200)}`);
    process.exit(1);
  }
  const allLeaders = ldRes.body.filter(l => l.role === 'leader');
  console.log(`Discovered ${allLeaders.length} leaders.`);

  // 2. log in all of them in parallel
  const logT0 = Date.now();
  const sessions = (await Promise.all(allLeaders.map(loginLeader))).filter(Boolean);
  console.log(`Logged in ${sessions.length} leaders in ${Date.now() - logT0}ms.`);
  if (sessions.length === 0) {
    console.error('No leaders could log in. Check LEADER_ACCESS_CODE / rate limits.');
    process.exit(1);
  }

  // 3. fetch roster per leader (parallel)
  const rosters = await Promise.all(
    sessions.map(async (l) => ({ leader: l, roster: await fetchRoster(l) }))
  );
  const totalStudents = rosters.reduce((s, r) => s + r.roster.length, 0);
  console.log(`Fetched ${totalStudents} students across ${rosters.length} leaders.`);
  console.log();

  // 4. waves of concurrent bulk submissions
  for (let w = 1; w <= WAVES; w++) {
    console.log(`=== Wave ${w}/${WAVES} ===`);
    const waveT0 = Date.now();
    const promises = rosters.map(({ leader, roster }) =>
      submitBulk(leader, roster).then(r => ({ leader, roster, r }))
    );
    const results = await Promise.all(promises);
    const waveMs = Date.now() - waveT0;

    let ok = 0, conflict = 0, ratelimit = 0, fail = 0;
    let minMs = Infinity, maxMs = 0, sumMs = 0;
    for (const { leader, roster, r } of results) {
      sumMs += r.ms; minMs = Math.min(minMs, r.ms); maxMs = Math.max(maxMs, r.ms);
      const tag =
        r.status === 200 ? (ok++, '[32mOK [0m') :
        r.status === 409 ? (conflict++, '[33m409[0m') :
        r.status === 429 ? (ratelimit++, '[33m429[0m') :
        (fail++, '[31m' + r.status + '[0m');
      console.log(`  ${tag}  ${fmt(r.ms)}ms  ${String(leader.id).padStart(3)} ${leader.name.padEnd(36)}  (${roster.length} students)`);
    }
    const n = results.length;
    console.log();
    console.log(`  Wave clock time:   ${waveMs}ms`);
    console.log(`  Latency: min ${minMs}ms  avg ${(sumMs/n).toFixed(0)}ms  max ${maxMs}ms`);
    console.log(`  Outcomes: [32m${ok} OK[0m  ${conflict} conflict  ${ratelimit} rate-limited  [31m${fail} failed[0m  (of ${n})`);
    console.log();

    if (fail > 0) process.exitCode = 1;
    if (w < WAVES) await new Promise(r => setTimeout(r, 1500));
  }
})();
