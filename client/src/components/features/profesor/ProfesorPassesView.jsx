import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Sunrise,
  Sunset,
  Save,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Clock,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  getAllProjectsAdmin,
  getCurrentRotationStudents,
  getProfesorAttendance,
  bulkSaveProfesorAttendance,
} from '../../../api/client';
import { formatDateToYYYYMMDD, getTodayDate } from '../../../utils/dateUtils';
import { getProjectLabel } from '../../../lib/projectI18n';
import Card from '../../ui/Card';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import Skeleton from '../../ui/Skeleton';
import Message from '../../common/Message';
import { Select } from '../../ui/Input';
import Tabs from '../../ui/Tabs';
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
  const [passType, setPassType] = useState('start');

  const [roster, setRoster] = useState([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [serverRows, setServerRows] = useState([]); // raw rows for both passes
  const [draft, setDraft] = useState({}); // { studentId: 'present'|'absent' }
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

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

  // Pivot server rows by pass_type so we can preload the draft based on
  // whatever was last saved for the currently-selected pass.
  const byPass = useMemo(() => {
    const m = { start: {}, end: {} };
    for (const r of serverRows) m[r.pass_type][r.student_id] = r;
    return m;
  }, [serverRows]);

  // When the user switches between START and END (or the data reloads),
  // re-seed the draft from the persisted state for that pass.
  useEffect(() => {
    const seeded = {};
    for (const s of roster) {
      const saved = byPass[passType]?.[s.id];
      seeded[s.id] = saved?.status || 'present'; // default present
    }
    setDraft(seeded);
  }, [roster, byPass, passType]);

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
      await bulkSaveProfesorAttendance({
        projectId: Number(projectId),
        date,
        passType,
        entries,
      });
      // Refresh server rows so the "last saved" timestamp updates
      const fresh = await getProfesorAttendance(projectId, date);
      setServerRows(fresh || []);
      setMessage({ type: 'success', text: t('passes.saveOk') });
    } catch (err) {
      setMessage({
        type: 'error',
        text: err?.response?.data?.error || t('passes.saveError'),
      });
    } finally {
      setSaving(false);
    }
  };

  // Latest recorded_at for the active pass (server time, formatted).
  const lastRecordedAt = useMemo(() => {
    const rows = serverRows.filter((r) => r.pass_type === passType);
    if (rows.length === 0) return null;
    const max = rows.reduce((a, b) => (a.recorded_at > b.recorded_at ? a : b));
    try {
      return new Date(max.recorded_at + 'Z').toLocaleString(i18n.language, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch {
      return max.recorded_at;
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

      {/* Toolbar: project picker, date, pass toggle */}
      <Card className="p-3 sm:p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] block mb-1">
              {t('passes.projectLabel')}
            </label>
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full h-11">
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
              onChange={(e) => setDate(e.target.value)}
              className="w-full h-11 px-3 rounded-xl bg-[color:var(--color-bg-2)] hairline text-sm tabular"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] block mb-1">
              {t('passes.passLabel')}
            </label>
            <Tabs
              value={passType}
              onChange={setPassType}
              tabs={[
                { key: 'start', label: t('passes.start'), icon: Sunrise },
                { key: 'end', label: t('passes.end'), icon: Sunset },
              ]}
            />
          </div>
        </div>
      </Card>

      {/* Roster + actions */}
      {!projectId ? (
        <Card className="p-8 text-center text-sm text-[color:var(--color-fg-muted)]">
          {t('passes.pickProjectHint')}
        </Card>
      ) : rosterLoading ? (
        <Card className="p-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-xl" />
          ))}
        </Card>
      ) : roster.length === 0 ? (
        <Card className="p-8 text-center text-sm text-[color:var(--color-fg-muted)]">
          {t('passes.emptyRoster')}
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
                          'shrink-0 h-10 px-3 sm:px-4 rounded-xl text-xs font-medium tracking-wide uppercase transition-colors flex items-center gap-1.5',
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

          {/* Save bar */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sticky bottom-0 bg-[color-mix(in_oklch,var(--color-bg)_85%,transparent)] backdrop-blur-md p-3 -mx-3 sm:-mx-4 sm:px-4 sm:rounded-2xl">
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
                  // Re-seed draft from server state, discarding edits
                  const seeded = {};
                  for (const s of roster) {
                    seeded[s.id] = byPass[passType]?.[s.id]?.status || 'present';
                  }
                  setDraft(seeded);
                }}
                disabled={saving}
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
