import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Cloud, Smartphone } from 'lucide-react';
import Button from '../ui/Button';
import Spinner from '../ui/Spinner';
import {
  getAttendanceByProjectAndDate,
  resolveAttendanceBulk,
} from '../../api/client';
import { removeConflict } from '../../lib/offlineQueue';

// Resolves a queued POST /api/attendance/bulk that hit a 409. Shows
// side-by-side: my queued mark vs the server's current mark, per student.
// Leader picks per-student or "all mine"/"all theirs", then submits.
//
// Props:
//   conflict — the row from the conflicts store (has .body with original payload)
//   leader   — current authenticated user (for projectId)
//   onResolved — callback after a successful resolve, removes from queue
export default function AttendanceConflictResolver({ conflict, leader, onResolved }) {
  const { t } = useTranslation('common');
  const [serverRows, setServerRows] = useState(null);
  const [serverError, setServerError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  // Per-studentId picker: 'mine' | 'theirs'. Default to 'mine' since the
  // leader took the trouble to mark offline — that's likely the truth.
  const [picks, setPicks] = useState({});

  const projectId = leader?.projectId;
  // Server stores body as { kind: 'json', body: { date, time, records } }.
  // After deserialize we get isFormData/body fields back; for json conflicts
  // we kept body in the original shape under the 'body' key.
  const myPayload = useMemo(() => {
    if (!conflict?.body) return null;
    if (conflict.body.kind === 'json') return conflict.body.body;
    if (conflict.body.kind === 'formdata') {
      // Reconstruct from fields (records will be a JSON string)
      const f = conflict.body.fields || {};
      let records = [];
      try { records = f.records ? JSON.parse(f.records) : []; } catch { /* keep [] */ }
      return { date: f.date, time: f.time, records };
    }
    return null;
  }, [conflict]);

  const myRecords = myPayload?.records || [];
  const date = myPayload?.date;
  const time = myPayload?.time;

  useEffect(() => {
    if (!projectId || !date) return;
    let cancelled = false;
    getAttendanceByProjectAndDate(projectId, date)
      .then((rows) => { if (!cancelled) setServerRows(rows || []); })
      .catch((e) => {
        if (!cancelled) {
          setServerRows([]);
          setServerError(e?.response?.data?.error || e.message || 'Network error');
        }
      });
    return () => { cancelled = true; };
  }, [projectId, date]);

  // Index server rows by studentId for fast lookup
  const serverByStudent = useMemo(() => {
    const map = {};
    for (const row of serverRows || []) {
      map[String(row.student_id)] = row;
    }
    return map;
  }, [serverRows]);

  // Union of student IDs across both sets so we don't drop anyone.
  const allStudentIds = useMemo(() => {
    const s = new Set();
    for (const r of myRecords) s.add(String(r.studentId));
    for (const r of serverRows || []) s.add(String(r.student_id));
    return [...s];
  }, [myRecords, serverRows]);

  const setAll = (choice) => {
    const next = {};
    for (const id of allStudentIds) next[id] = choice;
    setPicks(next);
  };

  const pickFor = (id) => picks[id] ?? 'mine';

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Build the merged record set per the leader's picks.
      const myByStudent = {};
      for (const r of myRecords) myByStudent[String(r.studentId)] = r;

      const merged = [];
      for (const id of allStudentIds) {
        const choice = pickFor(id);
        if (choice === 'mine') {
          const m = myByStudent[id];
          if (m) merged.push(m);
        } else {
          const s = serverByStudent[id];
          if (s) {
            merged.push({
              studentId: s.student_id,
              status: s.status,
              justification: s.justification ?? null,
              observation: s.observation ?? null,
            });
          }
        }
      }

      if (merged.length === 0) {
        setSubmitError(t('offline.conflictResolver.emptyAfterMerge'));
        return;
      }

      await resolveAttendanceBulk({
        date,
        time: time || serverRows?.[0]?.time || '08:00',
        records: merged,
        resolution: 'merge',
      });
      await removeConflict(conflict.id);
      onResolved?.();
    } catch (e) {
      const msg = e?.response?.data?.error || e?.response?.data?.message || e.message;
      setSubmitError(msg || t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!myPayload) {
    return <p className="text-sm text-[color:var(--color-fg-muted)]">{t('offline.conflictResolver.unsupported')}</p>;
  }

  if (serverRows === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-[color:var(--color-fg-muted)]">
        <Spinner /> {t('actions.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-[color:var(--color-fg-muted)]">
        {t('offline.conflictResolver.intro', { date })}
        {serverError && (
          <p className="mt-1 text-amber-700 dark:text-amber-300">
            {t('offline.conflictResolver.serverFetchFailed')}: {serverError}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => setAll('mine')}>
          <Smartphone className="size-3.5" /> {t('offline.conflictResolver.allMine')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setAll('theirs')}>
          <Cloud className="size-3.5" /> {t('offline.conflictResolver.allTheirs')}
        </Button>
      </div>

      <div className="space-y-2">
        {allStudentIds.map((id) => {
          const m = myRecords.find((r) => String(r.studentId) === id);
          const s = serverByStudent[id];
          const pick = pickFor(id);
          return (
            <div
              key={id}
              className="rounded-lg border border-[color:var(--color-border)] p-3 grid gap-2 sm:grid-cols-[1fr_auto_1fr]"
            >
              <button
                type="button"
                onClick={() => setPicks((p) => ({ ...p, [id]: 'mine' }))}
                className={`text-left rounded-md p-2 transition-colors ${
                  pick === 'mine'
                    ? 'bg-sky-100 dark:bg-sky-950 ring-2 ring-sky-400'
                    : 'hover:bg-[color:var(--color-surface-hover)]'
                }`}
              >
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[color:var(--color-fg-subtle)]">
                  <Smartphone className="size-3" /> {t('offline.conflictResolver.mine')}
                </div>
                {m ? <RecordSummary record={m} t={t} /> : <em className="text-xs text-[color:var(--color-fg-subtle)]">{t('offline.conflictResolver.noRecord')}</em>}
              </button>
              <ArrowRight className="size-4 self-center text-[color:var(--color-fg-subtle)] hidden sm:block" />
              <button
                type="button"
                onClick={() => setPicks((p) => ({ ...p, [id]: 'theirs' }))}
                className={`text-left rounded-md p-2 transition-colors ${
                  pick === 'theirs'
                    ? 'bg-sky-100 dark:bg-sky-950 ring-2 ring-sky-400'
                    : 'hover:bg-[color:var(--color-surface-hover)]'
                }`}
              >
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[color:var(--color-fg-subtle)]">
                  <Cloud className="size-3" /> {t('offline.conflictResolver.theirs')}
                </div>
                {s ? <RecordSummary record={{
                  studentId: s.student_id,
                  status: s.status,
                  justification: s.justification,
                  observation: s.observation,
                  studentName: s.student_name,
                }} t={t} /> : <em className="text-xs text-[color:var(--color-fg-subtle)]">{t('offline.conflictResolver.noRecord')}</em>}
              </button>
            </div>
          );
        })}
      </div>

      {submitError && (
        <p className="text-sm text-red-700 dark:text-red-300">{submitError}</p>
      )}

      <div className="flex justify-end gap-2 pt-2 border-t border-[color:var(--color-border)]">
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting ? <Spinner /> : null}
          {t('offline.conflictResolver.confirm')}
        </Button>
      </div>
    </div>
  );
}

function RecordSummary({ record, t }) {
  const status = record.status;
  const justification = record.justification;
  const label = status === 'present'
    ? t('status.present')
    : (justification === 'justificada' ? t('status.justified') : t('status.unjustified'));
  const dotColor =
    status === 'present' ? 'bg-emerald-500' :
    justification === 'justificada' ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="mt-1">
      {record.studentName && (
        <div className="text-xs font-medium truncate">{record.studentName}</div>
      )}
      <div className="text-sm flex items-center gap-1.5">
        <span className={`size-2 rounded-full ${dotColor}`} />
        {label}
      </div>
      {record.observation && (
        <div className="text-[11px] text-[color:var(--color-fg-subtle)] line-clamp-2 mt-0.5">
          {record.observation}
        </div>
      )}
    </div>
  );
}
