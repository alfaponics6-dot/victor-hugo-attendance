import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  Users,
  LayoutDashboard,
  TrendingUp,
  XCircle,
  CheckCircle2,
  AlertTriangle,
  Activity,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { useTranslation } from 'react-i18next';

import { getOverallStatistics, getAttendanceHistory } from '../../../api/client';
import { getTodayDate, formatDateForDisplay } from '../../../utils/dateUtils';
import StatCard from '../../ui/StatCard';
import Card, { CardHeader, CardTitle } from '../../ui/Card';
import Skeleton from '../../ui/Skeleton';
import Badge from '../../ui/Badge';

/**
 * Admin home tab. A dense data-console: four KPI tiles up top, a 14-day
 * attendance area chart on the left and an "alertas recientes" feed on the
 * right. All data flows through the existing statistics endpoints - no new
 * server work needed.
 */
function AdminOverview() {
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const { t, i18n } = useTranslation(['admin', 'common']);

  // Localized date formatter for chart X-axis labels - keeps charts consistent
  // with whichever language the user picked.
  const formatChartLabel = (dateStr) => {
    if (typeof dateStr !== 'string') return dateStr;
    const parsed = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return dateStr.slice(5);
    return new Intl.DateTimeFormat(i18n.language, { day: '2-digit', month: 'short' }).format(parsed);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [overall, hist] = await Promise.all([
          getOverallStatistics(getTodayDate()),
          getAttendanceHistory(14),
        ]);
        if (cancelled) return;
        setStats(overall);
        setHistory(Array.isArray(hist) ? hist : []);
      } catch (error) {
        console.error('Error loading admin overview:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Derived metrics - guard against missing fields. We pre-compute these so
  // the JSX below stays readable.
  const totalStudents = stats?.total_students ?? 0;
  const totalProjects = stats?.total_projects ?? 0;
  const totalPresent = stats?.total_present ?? 0;
  const totalAbsent = stats?.total_absent ?? 0;
  const totalMarked = totalPresent + totalAbsent;
  const attendanceRate = totalMarked > 0
    ? ((totalPresent / totalMarked) * 100).toFixed(1)
    : '-';

  // Recent alerts derived from the 14-day history: any day where attendance
  // was unusually low (below 70%) becomes an alert chip. Kept lightweight -
  // no new API needed.
  const alerts = history
    .map((d) => {
      const total = (d.present || 0) + (d.absent || 0);
      const rate = total > 0 ? ((d.present || 0) / total) * 100 : null;
      return { date: d.date, rate, present: d.present || 0, absent: d.absent || 0, total };
    })
    .filter((d) => d.rate !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 8);

  const chartData = history
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((d) => ({
      date: d.date,
      // Localized "DD MMM" label - short enough to fit on the X-axis and
      // adapts to the user's chosen language.
      label: formatChartLabel(d.date),
      presentes: d.present || 0,
      ausentes: d.absent || 0,
    }));

  if (loading) {
    return (
      <div className="space-y-4 sm:space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 sm:h-32 rounded-2xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
          <Skeleton className="lg:col-span-2 h-56 sm:h-80 rounded-2xl" />
          <Skeleton className="h-56 sm:h-80 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* KPI strip ─────────────────────────────────────────────────────── */}
      <motion.div
        initial="hidden"
        animate="show"
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.07 } },
        }}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4"
      >
        {[
          {
            label: t('overview.kpi.totalStudents'),
            value: totalStudents,
            icon: Users,
            tone: 'default',
            hint: t('overview.kpi.totalStudentsHint', { count: totalProjects }),
          },
          {
            label: t('overview.kpi.totalProjects'),
            value: totalProjects,
            icon: LayoutDashboard,
            tone: 'default',
            hint: t('overview.kpi.totalProjectsHint'),
          },
          {
            label: t('overview.kpi.attendanceToday'),
            value: attendanceRate === '-' ? '-' : attendanceRate,
            unit: attendanceRate === '-' ? undefined : '%',
            icon: TrendingUp,
            tone: 'success',
            hint: t('overview.kpi.attendanceTodayHint', {
              present: totalPresent,
              total: totalMarked || totalStudents,
            }),
          },
          {
            label: t('overview.kpi.absencesToday'),
            value: totalAbsent,
            icon: XCircle,
            tone: totalAbsent > 0 ? 'danger' : 'default',
            hint: stats?.total_absent_unjustified
              ? t('overview.kpi.absencesUnjustified', { count: stats.total_absent_unjustified })
              : t('overview.kpi.absencesNone'),
          },
        ].map((s) => (
          <motion.div
            key={s.label}
            variants={{
              hidden: { opacity: 0, y: 10 },
              show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.25, 1, 0.5, 1] } },
            }}
          >
            <StatCard
              label={s.label}
              value={s.value}
              unit={s.unit}
              hint={s.hint}
              icon={s.icon}
              tone={s.tone}
            />
          </motion.div>
        ))}
      </motion.div>

      {/* Chart + alerts ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
        {/* 14-day attendance area chart */}
        <Card className="lg:col-span-2 p-4 sm:p-6">
          <CardHeader className="mb-1 flex-col items-start gap-2 sm:flex-row sm:items-start sm:gap-3">
            <div>
              <CardTitle>{t('overview.chart.title')}</CardTitle>
              <p className="mt-1 text-xs text-[color:var(--color-fg-subtle)]">
                {t('overview.chart.subtitle')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">
                <span className="inline-block size-1.5 rounded-full bg-[color:var(--color-accent)]" />
                {t('overview.chart.present')}
              </Badge>
              <Badge tone="danger">
                <span className="inline-block size-1.5 rounded-full bg-[color:var(--color-danger)]" />
                {t('overview.chart.absent')}
              </Badge>
            </div>
          </CardHeader>

          {chartData.length === 0 ? (
            <EmptyChart message={t('overview.chart.empty')} />
          ) : (
            <div className="h-48 sm:h-64 lg:h-72 -mx-2">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 8, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="g-presentes" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.55} />
                      <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="g-ausentes" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-danger)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="var(--color-danger)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                    tick={{ fontSize: 10 }}
                    interval="preserveStartEnd"
                    minTickGap={16}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={6}
                    width={32}
                    tick={{ fontSize: 10 }}
                  />
                  <Tooltip
                    content={
                      <ChartTooltip
                        seriesNames={{
                          presentes: t('overview.chart.present'),
                          ausentes: t('overview.chart.absent'),
                        }}
                      />
                    }
                    cursor={{ stroke: 'var(--color-border-strong)' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="presentes"
                    stroke="var(--color-accent)"
                    strokeWidth={2}
                    fill="url(#g-presentes)"
                  />
                  <Area
                    type="monotone"
                    dataKey="ausentes"
                    stroke="var(--color-danger)"
                    strokeWidth={2}
                    fill="url(#g-ausentes)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        {/* Activity feed */}
        <Card className="p-4 sm:p-6">
          <CardHeader className="mb-1">
            <div>
              <CardTitle>{t('overview.activity.title')}</CardTitle>
              <p className="mt-1 text-xs text-[color:var(--color-fg-subtle)]">
                {t('overview.activity.subtitle')}
              </p>
            </div>
            <Activity className="size-4 text-[color:var(--color-fg-subtle)] shrink-0" />
          </CardHeader>

          {alerts.length === 0 ? (
            <div className="text-sm text-[color:var(--color-fg-muted)] py-12 text-center">
              {t('overview.activity.empty')}
            </div>
          ) : (
            <ul className="space-y-1 -mx-2 max-h-64 sm:max-h-72 overflow-y-auto pr-1">
              {alerts.map((a) => {
                const isLow = a.rate < 70;
                const isMid = a.rate >= 70 && a.rate < 90;
                const Icon = isLow ? AlertTriangle : CheckCircle2;
                const tone = isLow ? 'danger' : isMid ? 'warn' : 'success';
                return (
                  <li
                    key={a.date}
                    className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-[color:var(--color-surface-hover)] transition-colors"
                  >
                    <span
                      className={`size-7 grid place-items-center rounded-md shrink-0 ${
                        isLow
                          ? 'bg-[color-mix(in_oklch,var(--color-danger)_18%,transparent)] text-[color:var(--color-danger)]'
                          : isMid
                          ? 'bg-[color-mix(in_oklch,var(--color-warn)_22%,transparent)] text-[color:var(--color-warn)]'
                          : 'bg-[color-mix(in_oklch,var(--color-success)_18%,transparent)] text-[color:var(--color-success)]'
                      }`}
                    >
                      <Icon className="size-3.5" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs sm:text-sm font-medium truncate">
                        {formatDateForDisplay(a.date, i18n.language)}
                      </div>
                      <div className="text-[11px] sm:text-xs text-[color:var(--color-fg-subtle)] tabular truncate">
                        {t('overview.activity.summary', {
                          present: a.present,
                          absent: a.absent,
                          total: a.total,
                        })}
                      </div>
                    </div>
                    <Badge tone={tone} className="shrink-0">{a.rate.toFixed(0)}%</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// Custom tooltip styled to match the rest of the design system. We render
// our own pill-style chip per series so the colors come straight from the
// design tokens. `seriesNames` maps dataKey → localized series label.
const ChartTooltip = ({ active, payload, label, seriesNames = {} }) => {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="surface rounded-xl px-3 py-2.5 text-xs shadow-lg">
      <div className="text-[color:var(--color-fg-subtle)] mb-1 tracking-wide">{label}</div>
      <div className="space-y-1">
        {payload.map((p) => (
          <div key={p.dataKey} className="flex items-center gap-2">
            <span
              className="inline-block size-2 rounded-full"
              style={{ background: p.color }}
            />
            <span className="text-[color:var(--color-fg-muted)] capitalize">
              {seriesNames[p.dataKey] || p.dataKey}
            </span>
            <span className="ml-auto tabular text-[color:var(--color-fg)] font-medium">
              {p.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

const EmptyChart = ({ message }) => (
  <div className="h-48 sm:h-64 lg:h-72 grid place-items-center text-sm text-[color:var(--color-fg-muted)] px-4 text-center">
    {message}
  </div>
);

export default AdminOverview;
