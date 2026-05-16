import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Sunset,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Clock,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getProfesorAttendanceCompliance } from '../../../api/client';
import { getTodayDate } from '../../../utils/dateUtils';
import { getProjectLabel } from '../../../lib/projectI18n';
import Card from '../../ui/Card';
import Button from '../../ui/Button';
import Badge from '../../ui/Badge';
import Skeleton from '../../ui/Skeleton';
import Message from '../../common/Message';
import { cn } from '../../../lib/cn';

/**
 * Coordinator-only oversight view: per-project status of the start
 * and end attendance passes for a selected date. Lets the lead
 * profesor see at a glance which projects still need the end-of-day
 * pass, who already marked it, and when.
 *
 * Server gates access with `is_coordinator` on the leaders row; we
 * also hide the tab in ProfesorDashboard so non-coordinators don't
 * see a 403 button.
 */
export default function ProfesorComplianceView() {
  const { t, i18n } = useTranslation(['profesor', 'common']);
  const { t: tProject } = useTranslation('projects');
  const pname = (p) => getProjectLabel(tProject, p);

  const [date, setDate] = useState(getTodayDate());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const fetchData = async (forDate) => {
    setLoading(true);
    setMessage(null);
    try {
      const data = await getProfesorAttendanceCompliance(forDate);
      setRows(data || []);
    } catch (err) {
      setMessage({
        type: 'error',
        text: err?.response?.data?.error || t('compliance.loadError'),
      });
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  // Profes only do the FINAL pass; Inicio is the leader's flow and
  // doesn't go through profesor_attendance. So the summary tracks
  // end-pass completion only — that's the supervisor's actual signal.
  const summary = useMemo(() => {
    const total = rows.length;
    const endDone = rows.filter((r) => r.end_recorded_at).length;
    return { total, endDone, endPending: total - endDone };
  }, [rows]);

  const formatWhen = (iso) => {
    if (!iso) return null;
    try {
      // SQLite returns naive UTC strings (no Z). Append Z so the JS
      // Date parses it as UTC and toLocaleString formats correctly in
      // the user's locale.
      return new Date(iso + 'Z').toLocaleString(i18n.language, {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      {message && (
        <Message type={message.type} text={message.text} onClose={() => setMessage(null)} />
      )}

      {/* Date + refresh */}
      <Card className="p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
          <div className="flex-1">
            <label className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] block mb-1">
              {t('compliance.dateLabel')}
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full sm:w-56 h-11 px-3 rounded-xl bg-[color:var(--color-bg-2)] hairline text-sm tabular"
            />
          </div>
          <div className="flex items-center gap-2 sm:ml-auto">
            <Button variant="ghost" size="sm" onClick={() => fetchData(date)} disabled={loading}>
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
              {t('compliance.refresh')}
            </Button>
          </div>
        </div>
      </Card>

      {/* Summary tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SummaryTile
          label={t('compliance.summary.projects')}
          value={summary.total}
          tone="default"
          icon={null}
        />
        <SummaryTile
          icon={Sunset}
          label={t('compliance.summary.endDone')}
          value={`${summary.endDone} / ${summary.total}`}
          tone={summary.total > 0 && summary.endDone === summary.total ? 'success' : 'warn'}
        />
        <SummaryTile
          icon={AlertTriangle}
          label={t('compliance.summary.endPending')}
          value={summary.endPending}
          tone={summary.endPending === 0 ? 'success' : 'danger'}
        />
      </div>

      {/* Per-project grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card className="p-8 text-center text-sm text-[color:var(--color-fg-muted)]">
          {t('compliance.empty')}
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {rows.map((r) => (
            <ProjectComplianceCard
              key={r.project_id}
              project={r}
              pname={pname}
              formatWhen={formatWhen}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryTile({ icon: Icon, label, value, tone }) {
  const color = {
    default: 'var(--color-fg)',
    success: 'var(--color-success)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  }[tone];
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)]">
          {label}
        </span>
        {Icon && <Icon className="size-4 shrink-0" style={{ color }} />}
      </div>
      <div className="text-2xl font-semibold tabular tracking-tight" style={{ color }}>
        {value}
      </div>
    </Card>
  );
}

function ProjectComplianceCard({ project, pname, formatWhen, t }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      <Card className="p-4">
        <header className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-[color:var(--color-fg-subtle)]">
              {project.project_number ? `#${project.project_number}` : ''}
            </div>
            <h3 className="text-sm font-semibold tracking-tight">{pname(project)}</h3>
          </div>
          <Badge tone="outline" className="shrink-0">
            {t('compliance.rosterSize', { n: project.roster_size })}
          </Badge>
        </header>

        {/* Only the end pass — profes don't do start; that's the
            leader's flow and lives in a different table. */}
        <PassStatus
          label={t('compliance.endPass')}
          icon={Sunset}
          done={!!project.end_recorded_at}
          who={project.end_profesor_name}
          when={formatWhen(project.end_recorded_at)}
          present={project.end_present_count}
          total={project.end_rows_count}
          t={t}
          isEnd
        />
      </Card>
    </motion.div>
  );
}

function PassStatus({ label, icon: Icon, done, who, when, present, total, t, isEnd }) {
  // We tone the missing end-pass as danger (that's the supervisor's
  // main interest — "did the closing pass happen?"). Missing start
  // is amber/warn instead.
  const pendingTone = isEnd ? 'danger' : 'warn';
  const tone = done ? 'success' : pendingTone;
  const bg = {
    success: 'bg-[color-mix(in_oklch,var(--color-success)_14%,transparent)]',
    warn: 'bg-[color-mix(in_oklch,var(--color-warn)_14%,transparent)]',
    danger: 'bg-[color-mix(in_oklch,var(--color-danger)_14%,transparent)]',
  }[tone];
  const fg = {
    success: 'var(--color-success)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  }[tone];

  return (
    <div className={cn('rounded-xl p-3 hairline', bg)}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide mb-1" style={{ color: fg }}>
        <Icon className="size-3.5" />
        {label}
      </div>
      {done ? (
        <>
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <CheckCircle2 className="size-4 shrink-0" style={{ color: fg }} />
            {t('compliance.markedBy', { who: who || t('compliance.unknownProfe') })}
          </div>
          <div className="text-[11px] text-[color:var(--color-fg-subtle)] mt-1 flex items-center gap-1">
            <Clock className="size-3" /> {when}
            {Number(total) > 0 && (
              <span className="ml-1 tabular">· {present}/{total} {t('compliance.present')}</span>
            )}
          </div>
        </>
      ) : (
        <div className="flex items-center gap-1.5 text-sm font-medium" style={{ color: fg }}>
          <AlertTriangle className="size-4 shrink-0" />
          {t('compliance.notYet')}
        </div>
      )}
    </div>
  );
}
