import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, Ban, TrendingDown, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getStudentsWithLowAttendance, getStudentsWithConsecutiveAbsences } from '../../../api/client';
import Card from '../../ui/Card';
import Badge from '../../ui/Badge';
import Skeleton from '../../ui/Skeleton';
import { cn } from '../../../lib/cn';

/**
 * Surfaces the two attendance risk signals leaders care about: low overall rate
 * and an unbroken absence streak. Shown side-by-side on the dashboard "Inicio".
 */
function AlertsWidget({ projectId }) {
  const { t } = useTranslation(['leader', 'common']);
  const [lowAttendance, setLowAttendance] = useState([]);
  const [consecutiveAbsences, setConsecutiveAbsences] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (projectId) fetchAlerts();
  }, [projectId]);

  const fetchAlerts = async () => {
    setLoading(true);
    try {
      const [lowAtt, consAbs] = await Promise.all([
        getStudentsWithLowAttendance(projectId, 75),
        getStudentsWithConsecutiveAbsences(projectId, 3),
      ]);
      setLowAttendance(lowAtt);
      setConsecutiveAbsences(consAbs);
    } catch (error) {
      console.error('Error fetching alerts:', error);
    } finally {
      setLoading(false);
    }
  };

  const totalAlerts = lowAttendance.length + consecutiveAbsences.length;

  return (
    // Card uses flex-col so the header stays fixed and the body fills the
    // remaining height. Combined with h-full, that means: when the grid
    // sibling (the calendar) is tall, our body absorbs the extra height
    // gracefully (empty state centers, long lists scroll internally)
    // instead of leaving a gap above or below.
    <Card className="h-full p-0 overflow-hidden flex flex-col">
      <header className="flex items-center justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="size-8 grid place-items-center rounded-xl bg-[color-mix(in_oklch,var(--color-warn)_18%,transparent)] text-[color:var(--color-warn)] shrink-0">
            <AlertTriangle className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight truncate">{t('alerts.title')}</h3>
            <p className="text-[11px] text-[color:var(--color-fg-subtle)] line-clamp-2">
              {t('alerts.subtitle')}
            </p>
          </div>
        </div>
        {!loading && totalAlerts > 0 && (
          <Badge tone="warn" className="shrink-0">{t('alerts.count', { count: totalAlerts })}</Badge>
        )}
      </header>

      <div className="flex-1 min-h-0 px-4 sm:px-5 pb-4 sm:pb-5 overflow-y-auto">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="h-12 rounded-xl" />
          </div>
        ) : totalAlerts === 0 ? (
          // Empty state fills the available height and centers vertically
          // so there's no top-aligned "Sin alertas" with a tall empty
          // band below it (which is what looked broken on the screenshot).
          <div className="flex flex-col items-center justify-center text-center gap-2 h-full py-6 min-h-[140px]">
            <span className="size-10 grid place-items-center rounded-full bg-[color-mix(in_oklch,var(--color-success)_18%,transparent)] text-[color:var(--color-success)]">
              <CheckCircle2 className="size-5" />
            </span>
            <p className="text-sm font-medium">{t('alerts.emptyTitle')}</p>
            <p className="text-xs text-[color:var(--color-fg-subtle)] max-w-xs">
              {t('alerts.emptyHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {lowAttendance.length > 0 && (
              <AlertSection
                icon={TrendingDown}
                tone="warn"
                title={t('alerts.lowAttendance.title')}
                subtitle={t('alerts.lowAttendance.subtitle')}
                count={lowAttendance.length}
              >
                {lowAttendance.map((s, i) => (
                  <AlertRow
                    key={s.id}
                    index={i}
                    name={s.name}
                    sub={s.student_id ? t('alerts.studentId', { id: s.student_id }) : null}
                    metric={`${s.attendance_rate}%`}
                    metricSub={t('alerts.lowAttendance.metricSub', {
                      present: s.total_present,
                      total: s.total_records,
                    })}
                    tone="warn"
                  />
                ))}
              </AlertSection>
            )}

            {consecutiveAbsences.length > 0 && (
              <AlertSection
                icon={Ban}
                tone="danger"
                title={t('alerts.consecutive.title')}
                subtitle={t('alerts.consecutive.subtitle')}
                count={consecutiveAbsences.length}
              >
                {consecutiveAbsences.map((s, i) => (
                  <AlertRow
                    key={s.id}
                    index={i}
                    name={s.name}
                    sub={s.student_id ? t('alerts.studentId', { id: s.student_id }) : null}
                    metric={`${s.consecutive_absences}`}
                    metricSub={t('alerts.consecutive.metricSub')}
                    tone="danger"
                  />
                ))}
              </AlertSection>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function AlertSection({ icon: Icon, tone, title, subtitle, count, children }) {
  const toneClass = {
    warn: 'text-[color:var(--color-warn)] bg-[color-mix(in_oklch,var(--color-warn)_18%,transparent)]',
    danger: 'text-[color:var(--color-danger)] bg-[color-mix(in_oklch,var(--color-danger)_18%,transparent)]',
  }[tone];

  return (
    <section>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className={cn('size-7 grid place-items-center rounded-lg shrink-0', toneClass)}>
          <Icon className="size-3.5" />
        </span>
        <h4 className="text-[13px] font-medium tracking-tight">{title}</h4>
        <span className="text-[11px] text-[color:var(--color-fg-subtle)]">{subtitle}</span>
        <Badge tone={tone} className="ml-auto">{count}</Badge>
      </div>
      <ul className="space-y-1.5">
        <AnimatePresence initial={false}>{children}</AnimatePresence>
      </ul>
    </section>
  );
}

function AlertRow({ name, sub, metric, metricSub, tone, index }) {
  const accent = {
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  }[tone];

  return (
    <motion.li
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, delay: index * 0.04 }}
      className="flex items-center justify-between gap-2 sm:gap-3 px-2.5 sm:px-3 py-2.5 rounded-xl bg-[color:var(--color-bg-2)] hairline hover:border-[color:var(--color-border-strong)] transition-colors"
    >
      <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
        <span
          aria-hidden
          className="size-1.5 rounded-full shrink-0"
          style={{ background: accent, boxShadow: `0 0 12px ${accent}` }}
        />
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{name}</div>
          {sub && (
            <div className="text-[11px] text-[color:var(--color-fg-subtle)] truncate">{sub}</div>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-semibold tabular" style={{ color: accent }}>
          {metric}
        </div>
        <div className="text-[10px] text-[color:var(--color-fg-subtle)] uppercase tracking-wide whitespace-nowrap">
          {metricSub}
        </div>
      </div>
    </motion.li>
  );
}

export default AlertsWidget;
