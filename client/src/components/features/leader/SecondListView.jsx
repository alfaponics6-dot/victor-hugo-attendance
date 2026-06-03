import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sunset, Save, CheckCircle2, XCircle, RefreshCw, Clock, Inbox, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../../context/useAuth.js';
import {
  getCurrentRotationStudents,
  getProfesorAttendance,
  bulkSaveProfesorAttendance,
} from '../../../api/client';
import { getTodayDate } from '../../../utils/dateUtils';
import Card from '../../ui/Card';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import Skeleton from '../../ui/Skeleton';
import Message from '../../common/Message';
import { cn } from '../../../lib/cn';

/**
 * Leader-owned "segunda lista" (final pass). The leader marks their own
 * project's roster present/absent for the day's second roll call; rows go
 * into profesor_attendance with pass_type='end' (recorded_at is the
 * auto-captured time). Reuses the same bulk endpoint + offline queue as the
 * old profe pass. Writes are rejected once the coordinator locks the jornada.
 */
export default function SecondListView() {
  // Reuse the existing, already-translated pass strings for the marking UI;
  // leader-specific framing lives under the `leader:secondList` namespace.
  const { t } = useTranslation(['leader', 'profesor', 'common']);
  const { leader } = useAuth();
  const projectId = leader?.projectId;
  const passType = 'end';

  const [date, setDate] = useState(getTodayDate());
  const [roster, setRoster] = useState([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [serverRows, setServerRows] = useState([]);
  const [draft, setDraft] = useState({}); // { studentId: 'present'|'absent' }
  const [saving, setSaving] = useState(false);
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setRosterLoading(true);
    setLocked(false);
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
          setMessage({ type: 'error', text: t('profesor:passes.rosterLoadError') });
        }
      } finally {
        if (!cancelled) setRosterLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, date, t]);

  // Seed the draft from whatever 'end' pass was last saved for the date.
  const savedByStudent = useMemo(() => {
    const m = {};
    for (const r of serverRows) if (r.pass_type === passType) m[r.student_id] = r;
    return m;
  }, [serverRows]);

  useEffect(() => {
    const seeded = {};
    for (const s of roster) seeded[s.id] = savedByStudent[s.id]?.status || 'present';
    setDraft(seeded);
  }, [roster, savedByStudent]);

  const toggle = (id) =>
    setDraft((d) => ({ ...d, [id]: d[id] === 'present' ? 'absent' : 'present' }));
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
      const entries = roster.map((s) => ({ student_id: s.id, status: draft[s.id] || 'present' }));
      const result = await bulkSaveProfesorAttendance({ projectId: Number(projectId), date, passType, entries });
      if (result?._queued) {
        setMessage({ type: 'success', text: t('profesor:passes.saveQueued') });
      } else {
        try {
          const fresh = await getProfesorAttendance(projectId, date);
          setServerRows(fresh || []);
        } catch { /* save landed; refresh is best-effort */ }
        setMessage({ type: 'success', text: t('profesor:passes.saveOk') });
      }
    } catch (err) {
      // 409 = the coordinator already locked this date's jornada.
      if (err?.response?.status === 409) {
        setLocked(true);
        setMessage({ type: 'error', text: t('leader:secondList.locked') });
      } else {
        setMessage({ type: 'error', text: err?.response?.data?.error || t('profesor:passes.saveError') });
      }
    } finally {
      setSaving(false);
    }
  };

  const lastRecordedAt = useMemo(() => {
    const rows = serverRows.filter((r) => r.pass_type === passType);
    if (!rows.length) return null;
    const raw = rows.reduce((a, b) => (a.recorded_at > b.recorded_at ? a : b)).recorded_at;
    if (!raw) return null;
    const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw);
    const iso = hasTz ? raw : (raw.includes('T') ? raw + 'Z' : raw.replace(' ', 'T') + 'Z');
    const d = new Date(iso);
    return isNaN(d.getTime()) ? raw : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }, [serverRows]);

  const presentCount = useMemo(() => Object.values(draft).filter((v) => v === 'present').length, [draft]);

  if (!projectId) {
    return (
      <Card className="p-8 text-center text-sm text-[color:var(--color-fg-muted)]">
        {t('leader:secondList.noProject')}
      </Card>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <header className="min-w-0">
        <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[color:var(--color-fg-subtle)]">
          {t('leader:secondList.sectionTitle')}
        </div>
        <h2 className="text-lg sm:text-xl font-semibold tracking-tight flex items-center gap-2 flex-wrap">
          <Sunset className="size-5 text-[color:var(--color-accent)] shrink-0" />
          {t('leader:secondList.heading')}
        </h2>
        <p className="text-xs text-[color:var(--color-fg-muted)] mt-1">{t('leader:secondList.subtitle')}</p>
      </header>

      {message && <Message type={message.type} text={message.text} onClose={() => setMessage(null)} />}

      {locked && (
        <div className="surface rounded-xl px-4 py-3 flex items-center gap-3 border-l-4 border-l-[color:var(--color-accent)]/60">
          <Lock className="size-4 text-[color:var(--color-accent)]" />
          <div className="text-sm">
            <span className="font-medium">{t('leader:secondList.locked')}</span>{' '}
            <span className="text-[color:var(--color-fg-muted)]">{t('leader:secondList.lockedHint')}</span>
          </div>
        </div>
      )}

      <Card className="p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-2 px-3 h-10 rounded-xl bg-[color:var(--color-bg-2)] hairline">
            <Clock className="size-4 text-[color:var(--color-fg-muted)] shrink-0" />
            <input
              type="date"
              value={date}
              max={getTodayDate()}
              onChange={(e) => setDate(e.target.value)}
              className="bg-transparent outline-none text-sm tabular"
            />
          </div>
          <div className="inline-flex items-center gap-2 px-3 h-8 rounded-lg text-[12px] font-medium bg-[color-mix(in_oklch,var(--color-accent)_14%,transparent)] text-[color:var(--color-accent)]">
            <Sunset className="size-3.5" /> {t('profesor:passes.finalOnlyBadge')}
          </div>
        </div>
      </Card>

      {rosterLoading ? (
        <Card className="p-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
        </Card>
      ) : roster.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="mx-auto size-12 rounded-2xl grid place-items-center bg-[color-mix(in_oklch,var(--color-warn)_14%,transparent)] text-[color:var(--color-warn)] mb-3">
            <Inbox className="size-6" />
          </div>
          <div className="text-sm text-[color:var(--color-fg-muted)]">{t('profesor:passes.emptyRoster')}</div>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Badge tone="success"><CheckCircle2 className="size-3" /> {presentCount} {t('profesor:passes.present')}</Badge>
            <Badge tone="danger"><XCircle className="size-3" /> {roster.length - presentCount} {t('profesor:passes.absent')}</Badge>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => markAll('present')} disabled={locked}>{t('profesor:passes.allPresent')}</Button>
              <Button variant="ghost" size="sm" onClick={() => markAll('absent')} disabled={locked}>{t('profesor:passes.allAbsent')}</Button>
            </div>
          </div>

          <Card className="p-0 overflow-hidden">
            <ul className="divide-y divide-[color:var(--color-border)]">
              <AnimatePresence initial={false}>
                {roster.map((s) => {
                  const isPresent = (draft[s.id] || 'present') === 'present';
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
                          <div className="text-[11px] text-[color:var(--color-fg-subtle)] truncate">{s.student_id}</div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => toggle(s.id)}
                        disabled={locked}
                        className={cn(
                          'shrink-0 h-11 sm:h-10 px-3 sm:px-4 rounded-xl text-xs font-medium tracking-wide uppercase transition-colors flex items-center gap-1.5 min-w-[100px] sm:min-w-0 justify-center disabled:opacity-50',
                          isPresent
                            ? 'bg-[color-mix(in_oklch,var(--color-success)_18%,transparent)] text-[color:var(--color-success)]'
                            : 'bg-[color-mix(in_oklch,var(--color-danger)_18%,transparent)] text-[color:var(--color-danger)]'
                        )}
                      >
                        {isPresent ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
                        {isPresent ? t('profesor:passes.present') : t('profesor:passes.absent')}
                      </button>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          </Card>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sticky bottom-0 z-30 bg-[color-mix(in_oklch,var(--color-bg)_92%,transparent)] backdrop-blur-md p-3 -mx-3 sm:-mx-4 sm:px-4 sm:rounded-2xl pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <div className="text-[11px] text-[color:var(--color-fg-subtle)] flex items-center gap-1.5">
              <Clock className="size-3.5" />
              {lastRecordedAt ? t('profesor:passes.lastSavedAt', { when: lastRecordedAt }) : t('profesor:passes.notYetSaved')}
            </div>
            <div className="sm:ml-auto">
              <Button onClick={handleSave} disabled={saving || locked || roster.length === 0} loading={saving}>
                <Save className="size-4" /> {t('profesor:passes.save')}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
