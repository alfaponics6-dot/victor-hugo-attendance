import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Sunset,
  Save,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Clock,
  Users,
  Inbox,
  Pencil,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  getAllProjectsAdmin,
  getCurrentRotationStudents,
  getProfesorAttendance,
  bulkSaveProfesorAttendance,
} from '../../../api/client';
import { getTodayDate } from '../../../utils/dateUtils';
import { getProjectLabel } from '../../../lib/projectI18n';
import Card from '../../ui/Card';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import Skeleton from '../../ui/Skeleton';
import Message from '../../common/Message';
import { Select } from '../../ui/Input';
import { cn } from '../../../lib/cn';

/**
 * Profe-only attendance "passes" UI. The profe picks a project + date,
 * toggles between the START pass and the END pass, marks each student
 * present/absent, then saves. Server upserts the bulk so re-saving is
 * non-destructive.
 *
 * Recorded timestamp is captured server-side (so the profe can't fake
 * "I marked it on time"); we render `recorded_at` next to the save
 * area so the profe sees when their last submission landed.
 */
export default function ProfesorPassesView() {
  const { t, i18n } = useTranslation(['profesor', 'common']);
  const { t: tProject } = useTranslation('projects');
  const pname = (p) => getProjectLabel(tProject, p);

  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [date, setDate] = useState(getTodayDate());
  // Profes only do the FINAL/end pass — the start (Inicio) of each
  // session is handled by the project leader through the regular
  // leader attendance flow. We hardcode passType to 'end' so the
  // saved row goes into the correct slot for Ronald's Supervisión
  // dashboard. (Schema still supports 'start' for future use, but
  // there's no UI to set it here.)
  const passType = 'end';

  const [roster, setRoster] = useState([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [serverRows, setServerRows] = useState([]); // raw rows for both passes
  const [draft, setDraft] = useState({}); // { studentId: 'present'|'absent' }
  const [baselineDraft, setBaselineDraft] = useState({}); // snapshot for dirty-check
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  // Track which project the draft belongs to so we can warn the user
  // before silently discarding edits when they pick a different project.
  // Ref instead of state because we read it inside the change handler and
  // don't want to trigger re-renders.
  const draftProjectIdRef = useRef('');

  // Load projects once (any profe can mark any project)
  useEffect(() => {
    (async () => {
      try {
        const ps = await getAllProjectsAdmin();
        setProjects(ps || []);
      } catch {
        setMessage({ type: 'error', text: t('passes.projectsLoadError') });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever (project, date) changes, refetch the roster + current passes
  useEffect(() => {
    if (!projectId) {
      setRoster([]);
      setServerRows([]);
      setDraft({});
      setBaselineDraft({});
      return;
    }
    let cancelled = false;
    setRosterLoading(true);
    (async () => {
      try {
        const [rosterRes, passesRes] = await Promise.all([
          getCurrentRotationStudents(projectId),
          getProfesorAttendance(projectId, date),
        ]);
        if (cancelled) return;
        setRoster(rosterRes?.students || []);
        setServerRows(passesRes || []);
      } catch {
        if (!cancelled) {
          setRoster([]);
          setServerRows([]);
          setMessage({ type: 'error', text: t('passes.rosterLoadError') });
        }
      } finally {
        if (!cancelled) setRosterLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, date, t]);

  // Has the user touched anything since the last load/save? Compared
  // against the baseline snapshot taken whenever we seed the draft from
  // server state. Empty draft (no roster yet) is never dirty.
  const isDirty = useMemo(() => {
    const keys = Object.keys(draft);
    if (keys.length === 0) return false;
    for (const k of keys) {
      if (draft[k] !== baselineDraft[k]) return true;
    }
    // Also count baseline-only keys (roster shrunk in-flight) as dirty so
    // we don't pretend "no changes" when the state diverged.
    for (const k of Object.keys(baselineDraft)) {
      if (!(k in draft)) return true;
    }
    return false;
  }, [draft, baselineDraft]);

  // Pivot server rows by pass_type so we can preload the draft based on
  // whatever was last saved for the currently-selected pass.
  const byPass = useMemo(() => {
    const m = { start: {}, end: {} };
    for (const r of serverRows) m[r.pass_type][r.student_id] = r;
    return m;
  }, [serverRows]);

  // When the user switches between START and END (or the data reloads),
  // re-seed the draft from the persisted state for that pass. The seeded
  // state becomes the new baseline so the dirty-check correctly says
  // "nothing changed" right after a fresh load.
  useEffect(() => {
    const seeded = {};
    for (const s of roster) {
      const saved = byPass[passType]?.[s.id];
      seeded[s.id] = saved?.status || 'present'; // default present
    }
    setDraft(seeded);
    setBaselineDraft(seeded);
    draftProjectIdRef.current = projectId;
  }, [roster, byPass, passType, projectId]);

  const toggle = (studentId) => {
    setDraft((d) => ({
      ...d,
      [studentId]: d[studentId] === 'present' ? 'absent' : 'present',
    }));
  };

  const markAll = (status) => {
    const next = {};
    for (const s of roster) next[s.id] = status;
    setDraft(next);
  };

  const handleSave = async () => {
    if (!projectId || roster.length === 0) return;
    setSaving(true);
    setMessage(null);
    try {
      const entries = roster.map((s) => ({
        student_id: s.id,
        status: draft[s.id] || 'present',
      }));
      const result = await bulkSaveProfesorAttendance({
        projectId: Number(projectId),
        date,
        passType,
        entries,
      });
      // Offline path: axios interceptor enqueued the POST and returned a
      // synthetic 202. We can't refresh server rows (the GET would 404 or
      // fail), but the draft IS preserved on disk via the queue, so tell
      // the user it's been queued for sync.
      if (result?._queued) {
        // Lock in the current draft as the new baseline so the dirty
        // indicator clears. When the queue drains the timestamps will
        // refresh on next manual reload.
        setBaselineDraft({ ...draft });
        setMessage({ type: 'success', text: t('passes.saveQueued') });
      } else {
        // Refresh server rows so the "last saved" timestamp updates. Don't
        // let a flaky refresh GET poison the success path — the save
        // itself returned 200, so the data IS in the DB.
        try {
          const fresh = await getProfesorAttendance(projectId, date);
          setServerRows(fresh || []);
        } catch {
          // Refresh failed but save succeeded. Update the baseline from the
          // saved draft so the dirty indicator clears either way.
          setBaselineDraft({ ...draft });
        }
        setMessage({ type: 'success', text: t('passes.saveOk') });
      }
    } catch (err) {
      // Server-validation errors include a useful message; fall back to a
      // generic one for network/unknown failures. The draft is left intact
      // so the profe can fix the issue and retry without re-marking.
      setMessage({
        type: 'error',
        text: err?.response?.data?.error || t('passes.saveError'),
      });
    } finally {
      setSaving(false);
    }
  };

  // Project-picker change handler. If there are unsaved edits, ask before
  // throwing them away — losing 30 manually-marked students because the
  // profe brushed the dropdown is the kind of "what just happened?"
  // failure that destroys trust in the tool.
  const handleProjectChange = (nextValue) => {
    if (nextValue === projectId) return;
    if (isDirty && draftProjectIdRef.current && draftProjectIdRef.current !== nextValue) {
      const ok = typeof window !== 'undefined'
        ? window.confirm(t('passes.unsavedConfirm'))
        : true;
      if (!ok) return;
    }
    setProjectId(nextValue);
  };

  // Same guard for the date picker — switching dates also wipes draft
  // edits because the seed effect runs again with a fresh byPass.
  const handleDateChange = (nextValue) => {
    if (nextValue === date) return;
    if (isDirty) {
      const ok = typeof window !== 'undefined'
        ? window.confirm(t('passes.unsavedConfirm'))
        : true;
      if (!ok) return;
    }
    setDate(nextValue);
  };

  // Latest recorded_at for the active pass (server time, formatted).
  const lastRecordedAt = useMemo(() => {
    const rows = serverRows.filter((r) => r.pass_type === passType);
    if (rows.length === 0) return null;
    const max = rows.reduce((a, b) => (a.recorded_at > b.recorded_at ? a : b));
    const raw = max.recorded_at;
    if (!raw) return null;
    // SQLite normally returns naive UTC strings ("2026-05-16 14:32:00").
    // Append Z so the JS Date parses as UTC. But if the driver ever
    // hands back a string that already carries a Z/+hh:mm offset (or an
    // ISO string with milliseconds), don't double-stamp it. Likewise,
    // Date() returning Invalid Date for some locale-specific oddity has
    // to fall back to the raw string instead of throwing "Invalid time
    // value" from toLocaleString.
    const hasTz = /[zZ]|[+\-]\d{2}:?\d{2}$/.test(raw);
    const iso = hasTz ? raw : (raw.includes('T') ? raw + 'Z' : raw.replace(' ', 'T') + 'Z');
    const d = new Date(iso);
    if (isNaN(d.getTime())) return raw;
    try {
      return d.toLocaleString(i18n.language, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch {
      return raw;
    }
  }, [serverRows, passType, i18n.language]);

  const presentCount = useMemo(
    () => Object.values(draft).filter((v) => v === 'present').length,
    [draft],
  );
  const absentCount = roster.length - presentCount;

  return (
    <div className="space-y-4 sm:space-y-5">
      {message && (
        <Message type={message.type} text={message.text} onClose={() => setMessage(null)} />
      )}

      {/* Toolbar: project picker + date. Profes only do the FINAL
          attendance pass (the start of each session is the leader's
          job), so no start/end toggle here — a static "Pasada final"
          badge keeps it obvious which pass is being saved. */}
      <Card className="p-3 sm:p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] block mb-1">
              {t('passes.projectLabel')}
            </label>
            <Select value={projectId} onChange={(e) => handleProjectChange(e.target.value)} className="w-full h-11">
              <option value="">{t('passes.pickProject')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.project_number ? `#${p.project_number} · ` : ''}{pname(p)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] block mb-1">
              {t('passes.dateLabel')}
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => handleDateChange(e.target.value)}
              className="w-full h-11 px-3 rounded-xl bg-[color:var(--color-bg-2)] hairline text-sm tabular"
            />
          </div>
        </div>
        {/* "Final del día" badge — visible on every viewport. flex-wrap lets
            the dirty-indicator pill move to the next line on narrow phones
            rather than squishing the badge text. */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-2 px-3 h-8 rounded-lg text-[12px] font-medium bg-[color-mix(in_oklch,var(--color-accent)_14%,transparent)] text-[color:var(--color-accent)]">
            <Sunset className="size-3.5" />
            {t('passes.finalOnlyBadge')}
          </div>
          {isDirty && (
            <div
              className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[11px] font-medium bg-[color-mix(in_oklch,var(--color-warn)_14%,transparent)] text-[color:var(--color-warn)]"
              aria-live="polite"
            >
              <Pencil className="size-3" />
              {t('passes.unsavedChanges')}
            </div>
          )}
        </div>
      </Card>

      {/* Roster + actions. The "no project chosen" and "project chosen but
          roster is empty" states render visually distinct icons/headings
          so the profe doesn't think the picker is broken when a real but
          empty project comes back from the API. */}
      {!projectId ? (
        <Card className="p-8 text-center">
          <div className="mx-auto size-12 rounded-2xl grid place-items-center bg-[color-mix(in_oklch,var(--color-accent)_14%,transparent)] text-[color:var(--color-accent)] mb-3">
            <Users className="size-6" />
          </div>
          <div className="text-sm text-[color:var(--color-fg-muted)]">
            {t('passes.pickProjectHint')}
          </div>
        </Card>
      ) : rosterLoading ? (
        <Card className="p-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-xl" />
          ))}
        </Card>
      ) : roster.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="mx-auto size-12 rounded-2xl grid place-items-center bg-[color-mix(in_oklch,var(--color-warn)_14%,transparent)] text-[color:var(--color-warn)] mb-3">
            <Inbox className="size-6" />
          </div>
          <div className="text-sm font-medium tracking-tight mb-1">
            {t('passes.emptyRosterTitle')}
          </div>
          <div className="text-xs text-[color:var(--color-fg-muted)]">
            {t('passes.emptyRoster')}
          </div>
        </Card>
      ) : (
        <>
          {/* Quick mark-all + counts */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Badge tone="success">
              <CheckCircle2 className="size-3" /> {presentCount} {t('passes.present')}
            </Badge>
            <Badge tone="danger">
              <XCircle className="size-3" /> {absentCount} {t('passes.absent')}
            </Badge>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => markAll('present')}>
                {t('passes.allPresent')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => markAll('absent')}>
                {t('passes.allAbsent')}
              </Button>
            </div>
          </div>

          <Card className="p-0 overflow-hidden">
            <ul className="divide-y divide-[color:var(--color-border)]">
              <AnimatePresence initial={false}>
                {roster.map((s) => {
                  const status = draft[s.id] || 'present';
                  const isPresent = status === 'present';
                  return (
                    <motion.li
                      key={s.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.15 }}
                      className="flex items-center justify-between gap-3 px-3 sm:px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{s.name}</div>
                        {s.student_id && (
                          <div className="text-[11px] text-[color:var(--color-fg-subtle)] truncate">
                            {s.student_id}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => toggle(s.id)}
                        aria-label={isPresent ? t('passes.markAbsent') : t('passes.markPresent')}
                        className={cn(
                          'shrink-0 h-11 sm:h-10 px-3 sm:px-4 rounded-xl text-xs font-medium tracking-wide uppercase transition-colors flex items-center gap-1.5 min-w-[100px] sm:min-w-0 justify-center',
                          isPresent
                            ? 'bg-[color-mix(in_oklch,var(--color-success)_18%,transparent)] text-[color:var(--color-success)] hover:bg-[color-mix(in_oklch,var(--color-success)_28%,transparent)]'
                            : 'bg-[color-mix(in_oklch,var(--color-danger)_18%,transparent)] text-[color:var(--color-danger)] hover:bg-[color-mix(in_oklch,var(--color-danger)_28%,transparent)]'
                        )}
                      >
                        {isPresent ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
                        {isPresent ? t('passes.present') : t('passes.absent')}
                      </button>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          </Card>

          {/* Save bar. `z-30` keeps it above the roster cards when they
              scroll under it; trailing spacer (added in the wrapper
              below) keeps the last row visible above the bar on short
              viewports. */}
          <div className="h-2 sm:h-0" aria-hidden />
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sticky bottom-0 z-30 bg-[color-mix(in_oklch,var(--color-bg)_92%,transparent)] backdrop-blur-md p-3 -mx-3 sm:-mx-4 sm:px-4 sm:rounded-2xl pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <div className="text-[11px] text-[color:var(--color-fg-subtle)] flex items-center gap-1.5">
              <Clock className="size-3.5" />
              {lastRecordedAt
                ? t('passes.lastSavedAt', { when: lastRecordedAt })
                : t('passes.notYetSaved')}
            </div>
            <div className="sm:ml-auto flex gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  // Re-seed draft from server state, discarding edits.
                  // Also resets the baseline so the dirty indicator clears.
                  const seeded = {};
                  for (const s of roster) {
                    seeded[s.id] = byPass[passType]?.[s.id]?.status || 'present';
                  }
                  setDraft(seeded);
                  setBaselineDraft(seeded);
                }}
                disabled={saving || !isDirty}
              >
                <RefreshCw className="size-4" />
                {t('passes.discard')}
              </Button>
              <Button onClick={handleSave} disabled={saving || roster.length === 0} loading={saving}>
                <Save className="size-4" />
                {t('passes.save')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
