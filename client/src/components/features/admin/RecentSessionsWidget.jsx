import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { CalendarClock, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAttendanceByProjectAndDate } from '../../../api/client';
import { formatDateToYYYYMMDD } from '../../../utils/dateUtils';
import Card from '../../ui/Card';
import Skeleton from '../../ui/Skeleton';

/**
 * Compact session-by-session log: walks backward from today across the
 * project's session days (Wed/Sat) and shows the most recent ones that
 * actually have attendance records, with present/justified/unjustified
 * counts. Complements TrendCard (visual rate) and the calendar (month
 * grid) with a concrete "what happened in each session" breakdown.
 */
function RecentSessionsWidget({ projectId }) {
  const { t, i18n } = useTranslation(['leader', 'common']);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // Collect the most recent session days (Wednesdays + Saturdays),
        // walking backward from today. Cap at 8 candidates so we have
        // headroom to drop empty days and still surface ~6 with data.
        const sessionDays = [];
        const cursor = new Date();
        let guard = 0;
        while (sessionDays.length < 8 && guard < 80) {
          const dow = cursor.getDay();
          if (dow === 3 || dow === 6) sessionDays.push(new Date(cursor));
          cursor.setDate(cursor.getDate() - 1);
          guard++;
        }

        const results = await Promise.all(
          sessionDays.map((d) =>
            getAttendanceByProjectAndDate(projectId, formatDateToYYYYMMDD(d))
              .then((rows) => ({ date: d, rows }))
              .catch(() => ({ date: d, rows: [] })),
          ),
        );

        if (cancelled) return;

        // Drop sessions that have no record at all (leader hasn't marked
        // attendance for that day yet); keep up to 6 of the rest.
        const formatted = results
          .filter(({ rows }) => rows.length > 0)
          .map(({ date, rows }) => {
            const present = rows.filter((r) => r.status === 'present').length;
            const justified = rows.filter(
              (r) => r.status === 'absent' && r.justification === 'justificada',
            ).length;
            const unjustified = rows.filter(
              (r) => r.status === 'absent' && r.justification === 'injustificada',
            ).length;
            const total = rows.length;
            const rate = total > 0 ? Math.round((present / total) * 100) : 0;
            return { date, present, justified, unjustified, total, rate };
          })
          .slice(0, 6);

        setSessions(formatted);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <Card className="p-0 overflow-hidden">
      <header className="flex items-center justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="size-8 grid place-items-center rounded-xl bg-[color-mix(in_oklch,var(--color-accent-2)_18%,transparent)] text-[color:var(--color-accent-2)] shrink-0">
            <CalendarClock className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight truncate">
              {t('recentSessions.title')}
            </h3>
            <p className="text-[11px] text-[color:var(--color-fg-subtle)] line-clamp-2">
              {t('recentSessions.subtitle')}
            </p>
          </div>
        </div>
      </header>

      <div className="px-4 sm:px-5 pb-4 sm:pb-5">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="h-12 rounded-xl" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-sm font-medium">{t('recentSessions.emptyTitle')}</p>
            <p className="text-xs text-[color:var(--color-fg-subtle)] mt-1">
              {t('recentSessions.emptySubtitle')}
            </p>
          </div>
        ) : (
          <>
            {/* Table-style layout on sm+, compact stacked rows on mobile.
                We avoid a real <table> so each row can be a motion item
                with rounded card styling — matches the look of the
                alerts/calendar rows elsewhere on the page. */}
            <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-3 px-3 pb-2 text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)]">
              <span>{t('recentSessions.col.date')}</span>
              <span className="text-center">{t('recentSessions.col.present')}</span>
              <span className="text-center">{t('recentSessions.col.justified')}</span>
              <span className="text-center">{t('recentSessions.col.unjustified')}</span>
              <span className="text-center">{t('recentSessions.col.total')}</span>
              <span className="text-right">{t('recentSessions.col.rate')}</span>
            </div>
            <ul className="space-y-1.5">
              {sessions.map((s, i) => (
                <SessionRow key={i} index={i} {...s} lang={i18n.language} t={t} />
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}

function SessionRow({ date, present, justified, unjustified, total, rate, lang, t, index }) {
  const tone = rate >= 80 ? 'success' : rate >= 50 ? 'warn' : 'danger';
  const accent = {
    success: 'var(--color-success)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  }[tone];
  const weekday = date.toLocaleDateString(lang, { weekday: 'long' });
  const dateLabel = date.toLocaleDateString(lang, { day: '2-digit', month: 'short' });

  return (
    <motion.li
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.03 }}
      className="rounded-xl bg-[color:var(--color-bg-2)] hairline hover:border-[color:var(--color-border-strong)] transition-colors"
    >
      {/* Desktop: aligned grid columns matching the header above. */}
      <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto_auto_auto] items-center gap-3 px-3 py-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            aria-hidden
            className="size-1.5 rounded-full shrink-0"
            style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium capitalize truncate">{dateLabel}</div>
            <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-fg-subtle)] truncate">
              {weekday}
            </div>
          </div>
        </div>
        <Stat icon={CheckCircle2} color="var(--color-success)" value={present} />
        <Stat icon={AlertCircle} color="var(--color-warn)" value={justified} dim={justified === 0} />
        <Stat icon={XCircle} color="var(--color-danger)" value={unjustified} dim={unjustified === 0} />
        <span className="text-sm text-[color:var(--color-fg-muted)] tabular text-center whitespace-nowrap">
          {total}
        </span>
        <span className="text-sm font-semibold tabular text-right whitespace-nowrap" style={{ color: accent }}>
          {rate}%
        </span>
      </div>

      {/* Mobile: stacked, with stats as a small row underneath the date. */}
      <div className="sm:hidden px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              aria-hidden
              className="size-1.5 rounded-full shrink-0"
              style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
            />
            <div className="min-w-0">
              <div className="text-sm font-medium capitalize truncate">{dateLabel}</div>
              <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-fg-subtle)] truncate">
                {weekday}
              </div>
            </div>
          </div>
          <span className="text-base font-semibold tabular" style={{ color: accent }}>
            {rate}%
          </span>
        </div>
        <div className="mt-2 flex items-center gap-3 text-[11px] text-[color:var(--color-fg-muted)]">
          <Stat icon={CheckCircle2} color="var(--color-success)" value={present} compact />
          <Stat icon={AlertCircle} color="var(--color-warn)" value={justified} dim={justified === 0} compact />
          <Stat icon={XCircle} color="var(--color-danger)" value={unjustified} dim={unjustified === 0} compact />
          <span className="ml-auto text-[10px] uppercase tracking-wide text-[color:var(--color-fg-subtle)]">
            {present}/{total} {t('recentSessions.ofLabel')}
          </span>
        </div>
      </div>
    </motion.li>
  );
}

function Stat({ icon: Icon, color, value, dim = false, compact = false }) {
  return (
    <span
      className={
        compact
          ? 'inline-flex items-center gap-1 tabular'
          : 'inline-flex items-center justify-center gap-1 tabular text-sm'
      }
      style={{ color: dim ? 'var(--color-fg-subtle)' : color, opacity: dim ? 0.55 : 1 }}
    >
      <Icon className={compact ? 'size-3' : 'size-3.5'} />
      {value}
    </span>
  );
}

export default RecentSessionsWidget;
