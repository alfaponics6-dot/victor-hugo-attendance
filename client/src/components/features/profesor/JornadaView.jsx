import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion } from 'motion/react';
import { CalendarCheck, CheckCircle2, Clock, Lock, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../../context/useAuth.js';
import { getJornada, closeDay, closeSession } from '../../../api/client';
import { getTodayDate, formatDateForDisplay } from '../../../utils/dateUtils';
import { getProjectLabel } from '../../../lib/projectI18n';
import Card from '../../ui/Card';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import Modal from '../../ui/Modal';
import Skeleton from '../../ui/Skeleton';
import Message from '../../common/Message';
import { cn } from '../../../lib/cn';

/**
 * Jornada review + sign-off for profesores. Per project for a date it shows
 * the primera lista (leader attendance) and segunda lista (final pass) status,
 * lets a profesor "Cerrar día" per project (both lists required), and lets the
 * coordinator "Cerrar jornada" — which locks the whole date.
 */
export default function JornadaView() {
  const { t, i18n } = useTranslation(['profesor', 'common']);
  const { t: tProject } = useTranslation('projects');
  const { leader } = useAuth();
  const isCoordinator = !!leader?.isCoordinator;
  const lang = i18n.language || 'es';
  const pname = (p) => getProjectLabel(tProject, p);

  const [date, setDate] = useState(getTodayDate());
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [closingSession, setClosingSession] = useState(false);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getJornada(date);
      setProjects(res.projects || []);
    } catch {
      setProjects([]);
      setMsg({ type: 'error', text: t('jornada.loadError') });
    } finally {
      setLoading(false);
    }
  }, [date, t]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    if (!msg.text) return;
    const id = setTimeout(() => setMsg({ type: '', text: '' }), 3500);
    return () => clearTimeout(id);
  }, [msg]);

  const { closedCount, total, sessionLocked, allClosed } = useMemo(() => {
    const total = projects.length;
    const closedCount = projects.filter((p) => p.closedDay?.by).length;
    const sessionLocked = total > 0 && projects.some((p) => p.locked);
    return { closedCount, total, sessionLocked, allClosed: total > 0 && closedCount === total };
  }, [projects]);

  const handleCloseDay = async (p) => {
    setActingId(p.project_id);
    try {
      const res = await closeDay(p.project_id, date);
      setProjects(res.projects || []);
      setMsg({ type: 'success', text: t('jornada.dayClosedMsg', { project: p.project_number }) });
    } catch (err) {
      const code = err.response?.data?.error;
      if (err.response?.status === 409 && code === 'Lists incomplete') setMsg({ type: 'error', text: t('jornada.listsIncomplete') });
      else if (err.response?.status === 409) setMsg({ type: 'error', text: t('jornada.alreadyLocked') });
      else setMsg({ type: 'error', text: t('jornada.closeDayError') });
    } finally {
      setActingId(null);
    }
  };

  const handleCloseSession = async () => {
    setClosingSession(true);
    try {
      const res = await closeSession(date);
      setProjects(res.projects || []);
      setConfirmOpen(false);
      setMsg({ type: 'success', text: t('jornada.sessionClosedMsg') });
    } catch (err) {
      const pending = err.response?.data?.pending;
      if (err.response?.status === 409 && Array.isArray(pending) && pending.length) {
        setMsg({ type: 'error', text: t('jornada.pendingProjects', { list: pending.map((p) => `#${p.project_number}`).join(', ') }) });
      } else {
        setMsg({ type: 'error', text: t('jornada.closeSessionError') });
      }
      setConfirmOpen(false);
    } finally {
      setClosingSession(false);
    }
  };

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-4 sm:px-5 py-4 border-b border-[color:var(--color-border)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="size-9 grid place-items-center rounded-xl bg-[color-mix(in_oklch,var(--color-accent)_18%,transparent)] text-[color:var(--color-accent)] shrink-0">
            <CalendarCheck className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight">{t('jornada.title')}</h3>
            <p className="text-[11px] text-[color:var(--color-fg-subtle)]">{t('jornada.subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-2 px-3 h-10 rounded-xl bg-[color:var(--color-bg-2)] hairline">
            <Clock className="size-4 text-[color:var(--color-fg-muted)] shrink-0" />
            <input type="date" value={date} max={getTodayDate()} onChange={(e) => setDate(e.target.value)}
              className="bg-transparent outline-none text-sm tabular" />
          </div>
          <Button variant="ghost" size="icon" onClick={fetchStatus} title={t('jornada.refresh')} aria-label={t('jornada.refresh')}>
            <RefreshCw className={cn('size-4', loading && 'animate-spin-slow')} />
          </Button>
        </div>
      </div>

      <div className="px-4 sm:px-5 py-4">
        <Message type={msg.type} text={msg.text} onClose={() => setMsg({ type: '', text: '' })} />

        {sessionLocked && (
          <div className="mb-3 surface-flat rounded-xl px-3.5 py-2.5 flex items-center gap-2.5 border-l-4 border-l-[color:var(--color-accent)]/60">
            <Lock className="size-4 text-[color:var(--color-accent)] shrink-0" />
            <span className="text-sm">
              <span className="font-medium">{t('jornada.sessionLocked')}</span>{' '}
              <span className="text-[color:var(--color-fg-muted)]">{t('jornada.lockedNote')}</span>
            </span>
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
          </div>
        ) : total === 0 ? (
          <div className="text-center py-8 text-sm text-[color:var(--color-fg-muted)]">{t('jornada.empty')}</div>
        ) : (
          <ul className="space-y-2">
            {projects.map((p) => {
              const bothLists = p.primera?.passed && p.segunda?.passed;
              const closed = !!p.closedDay?.by;
              return (
                <motion.li
                  key={p.project_id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between rounded-xl bg-[color:var(--color-bg-2)] hairline px-3.5 py-3"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <span className="inline-flex h-6 px-2 items-center rounded-md text-[11px] font-mono tabular bg-[color-mix(in_oklch,var(--color-accent)_15%,transparent)] text-[color:var(--color-accent)] shrink-0 mt-0.5">
                      {p.project_number}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium tracking-tight truncate">{pname(p)}</div>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        <ListChip label={t('jornada.primera')} passed={p.primera?.passed} time={p.primera?.time} t={t} />
                        <ListChip label={t('jornada.segunda')} passed={p.segunda?.passed} time={p.segunda?.recorded_at} t={t} isDateTime />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 lg:shrink-0 lg:pl-3">
                    {closed ? (
                      <Badge tone="success" title={p.closedDay.at || ''}>
                        <CheckCircle2 className="size-3" /> {t('jornada.closedBy', { name: p.closedDay.by })}
                      </Badge>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!bothLists || p.locked || actingId === p.project_id}
                        loading={actingId === p.project_id}
                        onClick={() => handleCloseDay(p)}
                        title={!bothLists ? t('jornada.needBothLists') : t('jornada.closeDay')}
                      >
                        {actingId !== p.project_id && <CheckCircle2 className="size-4" />}
                        {bothLists ? t('jornada.closeDay') : t('jornada.needBothLists')}
                      </Button>
                    )}
                  </div>
                </motion.li>
              );
            })}
          </ul>
        )}

        {total > 0 && (
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-[color:var(--color-border)] pt-4">
            <div className="text-sm text-[color:var(--color-fg-muted)] inline-flex items-center gap-2">
              <ShieldCheck className="size-4 text-[color:var(--color-fg-subtle)]" />
              {t('jornada.progress', { done: closedCount, total })}
            </div>
            {isCoordinator ? (
              <Button variant="primary" disabled={!allClosed || sessionLocked} onClick={() => setConfirmOpen(true)}
                title={!allClosed ? t('jornada.needAllClosed') : t('jornada.closeSession')}>
                <Lock className="size-4" />
                {sessionLocked ? t('jornada.sessionLocked') : t('jornada.closeSession')}
              </Button>
            ) : (
              <span className="text-[11px] text-[color:var(--color-fg-subtle)] inline-flex items-center gap-1.5">
                <AlertTriangle className="size-3.5" /> {t('jornada.coordinatorOnly')}
              </span>
            )}
          </div>
        )}
      </div>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} size="sm"
        title={t('jornada.confirmTitle')} description={t('jornada.confirmBody', { date: formatDateForDisplay(date, lang) })}>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={closingSession}>{t('common:actions.cancel')}</Button>
          <Button variant="primary" onClick={handleCloseSession} loading={closingSession}>
            <Lock className="size-4" /> {t('jornada.confirmYes')}
          </Button>
        </div>
      </Modal>
    </Card>
  );
}

function ListChip({ label, passed, time, t, isDateTime }) {
  // primera lista stores a clock time ("08:00"); segunda stores a datetime
  // (recorded_at) — show just the time portion for a compact chip.
  let shown = time;
  if (passed && time && isDateTime) {
    const m = String(time).match(/(\d{2}:\d{2})/);
    shown = m ? m[1] : time;
  }
  return (
    <span className={cn(
      'inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] font-medium',
      passed
        ? 'bg-[color-mix(in_oklch,var(--color-success)_16%,transparent)] text-[color:var(--color-success)]'
        : 'bg-[color:var(--color-bg-3)] text-[color:var(--color-fg-subtle)]'
    )}>
      {passed ? <CheckCircle2 className="size-3" /> : <Clock className="size-3" />}
      <span>{label}</span>
      <span className="tabular opacity-80">{passed && shown ? shown : t('jornada.pending')}</span>
    </span>
  );
}
