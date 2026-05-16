import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Users,
  CheckCircle2,
  XCircle,
  TrendingUp,
  BarChart3,
  Calendar,
  Download,
  Search,
  PieChart as PieIcon,
  LineChart as LineIcon,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { useTranslation } from 'react-i18next';

import {
  getOverallStatistics,
  getProjectStatistics,
  getAttendanceHistory,
  getDetailedStudentData,
} from '../api/client';
import { getTodayDate, formatDateForDisplay } from '../utils/dateUtils';
import Card, { CardHeader, CardTitle } from '../components/ui/Card';
import StatCard from '../components/ui/StatCard';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import { Input, Select } from '../components/ui/Input';
import Skeleton from '../components/ui/Skeleton';
import Loading from '../components/common/Loading';
import { getProjectLabel } from '../lib/projectI18n';

/**
 * Charts page used by both leader and admin views (admin sets `isAdmin`).
 * The original data flow is preserved verbatim; only the visual layer is
 * rebuilt around the design system.
 */
function Statistics({ isAdmin = false }) {
  const { t: tProject } = useTranslation('projects');
  const [overallStats, setOverallStats] = useState(null);
  const [projectStats, setProjectStats] = useState([]);
  const [historyStats, setHistoryStats] = useState([]);
  const [selectedDate, setSelectedDate] = useState(getTodayDate());
  const [historyDays, setHistoryDays] = useState(14);
  const [dateRangeMode, setDateRangeMode] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { t, i18n } = useTranslation(['admin', 'common']);

  // Localized "DD MMM" formatter for chart axis labels - keeps the X-axis
  // legible in any of the four supported languages.
  const formatChartLabel = (dateStr) => {
    if (typeof dateStr !== 'string') return dateStr;
    const parsed = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return dateStr.slice(5);
    return new Intl.DateTimeFormat(i18n.language, { day: '2-digit', month: 'short' }).format(parsed);
  };

  useEffect(() => {
    fetchStatistics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, historyDays, dateRangeMode, startDate, endDate]);

  const fetchStatistics = async () => {
    setLoading(true);
    try {
      // Range mode: send startDate + endDate; the server aggregates attendance
      // rows inclusively over that range. Single-date mode: send the date as
      // a string for backward compat with both endpoints.
      const inRange = dateRangeMode && startDate && endDate;
      const statsArg = inRange ? { startDate, endDate } : selectedDate;
      const [overall, projects, history] = await Promise.all([
        getOverallStatistics(statsArg),
        getProjectStatistics(statsArg),
        getAttendanceHistory(historyDays),
      ]);
      setOverallStats(overall);
      setProjectStats(projects || []);
      setHistoryStats(history || []);
    } catch (error) {
      console.error('Error fetching statistics:', error);
    } finally {
      setLoading(false);
    }
  };

  const calculateRate = (present, total) => {
    if (!total || total === 0) return 0;
    return ((present / total) * 100).toFixed(1);
  };

  // ─── Excel export ─────────────────────────────────────────────────────
  // Logic copied straight from the original. Wrapped to expose a loading
  // state on the button so users see something is happening.
  const exportToExcel = async () => {
    if (projectStats.length === 0) return;
    setExporting(true);
    try {
      const XLSX = await import('xlsx');
      // Range mode: the detailed-students endpoint is single-date only, so
      // export the per-student detail for the start of the range (the most
      // common ask) and label the summary as the range. Without this guard
      // we used to send stale `selectedDate` while the rest of the workbook
      // reflected the visible range — confusing for the user.
      const inRange = dateRangeMode && startDate && endDate;
      const detailDate = inRange ? startDate : selectedDate;
      const detailedStudents = await getDetailedStudentData(detailDate);
      const wb = XLSX.utils.book_new();

      const rangeLabel = inRange ? `${startDate} → ${endDate}` : null;
      const summaryData = [
        [t('statistics.excel.title')],
        [t('statistics.excel.date'), rangeLabel || selectedDate || t('statistics.excel.allDates')],
        [''],
        [t('statistics.excel.summarySection')],
        [t('statistics.excel.totalProjects'), overallStats?.total_projects || 0],
        [t('statistics.excel.totalStudents'), overallStats?.total_students || 0],
        [''],
      ];
      // We have presence/absence numbers whenever a date or range is set.
      const hasDateScope = !!(selectedDate || inRange);
      if (hasDateScope) {
        summaryData.push(
          [t('statistics.excel.present'), overallStats?.total_present || 0, `${calculateRate(overallStats?.total_present || 0, overallStats?.total_students || 0)}%`],
          [t('statistics.excel.justified'), overallStats?.total_absent_justified || 0, `${calculateRate(overallStats?.total_absent_justified || 0, overallStats?.total_students || 0)}%`],
          [t('statistics.excel.unjustified'), overallStats?.total_absent_unjustified || 0, `${calculateRate(overallStats?.total_absent_unjustified || 0, overallStats?.total_students || 0)}%`]
        );
      }
      const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
      XLSX.utils.book_append_sheet(wb, ws1, t('statistics.excel.sheetSummary'));

      const projectHeaders = hasDateScope
        ? [t('statistics.excel.projectNumber'), t('statistics.excel.projectName'), t('statistics.excel.studentsTotal'), t('statistics.excel.present'), t('statistics.excel.absentCol'), t('statistics.excel.rateCol')]
        : [t('statistics.excel.projectNumber'), t('statistics.excel.projectName'), t('statistics.excel.studentsTotal')];
      const projectRows = projectStats.map((p) => {
        const row = [p.project_number, p.project_name, p.total_students];
        if (hasDateScope) {
          row.push(p.present || 0, p.absent || 0, calculateRate(p.present || 0, p.total_students));
        }
        return row;
      });
      const ws2 = XLSX.utils.aoa_to_sheet([projectHeaders, ...projectRows]);
      XLSX.utils.book_append_sheet(wb, ws2, t('statistics.excel.sheetProjects'));

      // Per-student detail comes from a single-date endpoint, so the
      // status/justification columns are only meaningful when we actually
      // sent a date (single or range-start). hasDateScope covers both.
      const studentHeaders = hasDateScope
        ? [t('statistics.excel.projectNumber'), t('statistics.excel.projectName'), t('statistics.excel.studentName'), t('statistics.excel.studentId'), t('statistics.excel.email'), t('statistics.excel.status'), t('statistics.excel.justification'), t('statistics.excel.observation')]
        : [t('statistics.excel.projectNumber'), t('statistics.excel.projectName'), t('statistics.excel.studentName'), t('statistics.excel.studentId'), t('statistics.excel.email')];
      const studentRows = (detailedStudents || []).map((s) => {
        const row = [
          s.project_number,
          s.project_name,
          s.name,
          s.student_id || 'N/A',
          s.email || t('statistics.excel.noEmail'),
        ];
        if (hasDateScope) {
          const statusText =
            s.status === 'present' ? t('statistics.excel.statusPresent') :
            s.status === 'absent' ? t('statistics.excel.statusAbsent') : t('statistics.excel.statusUnmarked');
          const justificationText =
            s.status === 'absent' && s.justification
              ? (s.justification === 'justificada' ? t('statistics.excel.justifiedLabel') : t('statistics.excel.unjustifiedLabel'))
              : '-';
          row.push(statusText, justificationText, s.observation || '-');
        }
        return row;
      });
      const ws3 = XLSX.utils.aoa_to_sheet([studentHeaders, ...studentRows]);
      XLSX.utils.book_append_sheet(wb, ws3, t('statistics.excel.sheetStudents'));

      if (historyStats.length > 0) {
        const historyHeaders = [t('statistics.excel.historyDate'), t('statistics.excel.present'), t('statistics.excel.absentCol'), t('statistics.excel.historyTotal')];
        const historyRows = historyStats.map((s) => [s.date, s.present, s.absent, s.total]);
        const ws4 = XLSX.utils.aoa_to_sheet([historyHeaders, ...historyRows]);
        XLSX.utils.book_append_sheet(wb, ws4, t('statistics.excel.sheetHistory'));
      }

      // Filename reflects whichever scope was actually exported. Range mode
      // uses `start_end`, single uses the date, otherwise "completo".
      const fileScope = inRange ? `${startDate}_${endDate}` : (selectedDate || 'completo');
      const fileName = `estadisticas_victorhugo_${fileScope}_${Date.now()}.xlsx`;
      XLSX.writeFile(wb, fileName);
    } catch (error) {
      console.error('Error exporting to Excel:', error);
    } finally {
      setExporting(false);
    }
  };

  // ─── Derived data ─────────────────────────────────────────────────────
  const filteredProjectStats = useMemo(() => {
    if (!searchQuery.trim()) return projectStats;
    const q = searchQuery.trim().toLowerCase();
    return projectStats.filter((p) =>
      (p.project_name || '').toLowerCase().includes(q) ||
      String(p.project_number || '').includes(q)
    );
  }, [projectStats, searchQuery]);

  const totalStudents = overallStats?.total_students ?? 0;
  const totalPresent = overallStats?.total_present ?? 0;
  const totalAbsent = overallStats?.total_absent ?? 0;
  const totalProjects = overallStats?.total_projects ?? 0;
  const totalMarked = totalPresent + totalAbsent;
  const attendanceRate = totalMarked > 0
    ? ((totalPresent / totalMarked) * 100).toFixed(1)
    : '0.0';

  const pieData = overallStats && selectedDate ? [
    {
      name: t('statistics.charts.present'),
      value: overallStats.total_present || 0,
      color: 'var(--color-success)',
    },
    {
      name: t('statistics.charts.justified'),
      value: overallStats.total_absent_justified || 0,
      color: 'var(--color-warn)',
    },
    {
      name: t('statistics.charts.unjustified'),
      value: overallStats.total_absent_unjustified || 0,
      color: 'var(--color-danger)',
    },
    {
      name: t('statistics.charts.unmarked'),
      value: Math.max(
        0,
        (overallStats.total_students || 0)
          - (overallStats.total_present || 0)
          - (overallStats.total_absent || 0)
      ),
      color: 'var(--color-fg-subtle)',
    },
  ].filter((d) => d.value > 0) : [];

  const historyChart = useMemo(
    () => historyStats
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => ({
        date: d.date,
        label: formatChartLabel(d.date),
        presentes: d.present || 0,
        ausentes: d.absent || 0,
        total: d.total || 0,
      })),
    // formatChartLabel closes over i18n.language; re-derive when it changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyStats, i18n.language]
  );

  const projectChart = useMemo(
    () => projectStats.map((p) => ({
      key: `#${p.project_number}`,
      project_number: p.project_number,
      project_name: p.project_name,
      total_students: p.total_students,
      presentes: p.present || 0,
      ausentes: p.absent || 0,
    })),
    [projectStats]
  );

  // ─── UI ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Page intro - admin view sits inside AdminDashboard so we suppress
          our own page header in that case. */}
      {!isAdmin && (
        <div className="flex flex-col gap-3 sm:gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-1">
            <div className="text-[10px] sm:text-[11px] font-medium uppercase tracking-[0.16em] text-[color:var(--color-fg-subtle)]">
              {t('statistics.eyebrow')}
            </div>
            <h1 className="text-2xl sm:text-[1.65rem] font-semibold tracking-tight leading-tight">
              <span className="gradient-text">{t('statistics.title')}</span> {t('statistics.titleSuffix')}
            </h1>
            <p className="text-xs sm:text-sm text-[color:var(--color-fg-muted)] max-w-xl">
              {t('statistics.subtitle')}
            </p>
          </div>
        </div>
      )}

      {/* Toolbar ──────────────────────────────────────────────────────── */}
      <Card className="p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              value={dateRangeMode ? 'range' : 'single'}
              onChange={(v) => setDateRangeMode(v === 'range')}
              options={[
                { value: 'single', label: t('statistics.modes.single') },
                { value: 'range', label: t('statistics.modes.range') },
              ]}
            />

            {!dateRangeMode ? (
              <DateField
                label={t('statistics.dateLabels.date')}
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                max={getTodayDate()}
              />
            ) : (
              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                <DateField
                  label={t('statistics.dateLabels.from')}
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  max={endDate || getTodayDate()}
                />
                <DateField
                  label={t('statistics.dateLabels.to')}
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  min={startDate}
                  max={getTodayDate()}
                />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
            <Select
              value={historyDays}
              onChange={(e) => setHistoryDays(parseInt(e.target.value, 10))}
              className="w-full sm:w-44 h-11 sm:h-10"
            >
              <option value={7}>{t('statistics.history.last7')}</option>
              <option value={14}>{t('statistics.history.last14')}</option>
              <option value={30}>{t('statistics.history.last30')}</option>
            </Select>
            <Button
              variant="primary"
              size="md"
              onClick={exportToExcel}
              loading={exporting}
              disabled={projectStats.length === 0}
              className="w-full sm:w-auto h-11 sm:h-10"
            >
              <Download className="size-4" />
              {t('statistics.export')}
            </Button>
          </div>
        </div>

        {dateRangeMode && startDate && endDate && (
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] sm:text-xs text-[color:var(--color-fg-muted)]">
            <Calendar className="size-3.5 shrink-0" />
            <span>{t('statistics.dateLabels.showingFrom')}</span>
            <span className="text-[color:var(--color-fg)]">{formatDateForDisplay(startDate, i18n.language)}</span>
            <span>{t('statistics.dateLabels.showingTo')}</span>
            <span className="text-[color:var(--color-fg)]">{formatDateForDisplay(endDate, i18n.language)}</span>
          </div>
        )}
      </Card>

      {loading && !overallStats ? (
        <Loading message={t('statistics.loading')} />
      ) : (
        <>
          {/* Hero KPI strip ──────────────────────────────────────────── */}
          <motion.div
            initial="hidden"
            animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06 } } }}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4"
          >
            {[
              {
                label: t('statistics.kpi.totalStudents'),
                value: totalStudents,
                icon: Users,
                tone: 'default',
                hint: t('statistics.kpi.totalStudentsHint', { count: totalProjects }),
              },
              {
                label: t('statistics.kpi.present'),
                value: totalPresent,
                icon: CheckCircle2,
                tone: 'success',
                hint: selectedDate ? formatDateForDisplay(selectedDate, i18n.language) : '-',
              },
              {
                label: t('statistics.kpi.absent'),
                value: totalAbsent,
                icon: XCircle,
                tone: totalAbsent > 0 ? 'danger' : 'default',
                hint: overallStats?.total_absent_unjustified
                  ? t('statistics.kpi.absentUnjustified', { count: overallStats.total_absent_unjustified })
                  : t('statistics.kpi.absentNone'),
              },
              {
                label: t('statistics.kpi.rate'),
                value: attendanceRate,
                unit: '%',
                icon: TrendingUp,
                tone: 'success',
                hint: t('statistics.kpi.rateHint', { present: totalPresent, total: totalMarked || totalStudents }),
              },
            ].map((s) => (
              <motion.div
                key={s.label}
                variants={{
                  hidden: { opacity: 0, y: 10 },
                  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.25, 1, 0.5, 1] } },
                }}
              >
                <StatCard {...s} />
              </motion.div>
            ))}
          </motion.div>

          {/* Daily attendance area chart ─────────────────────────────── */}
          <Card className="p-4 sm:p-6">
            <CardHeader className="mb-1 flex-col items-start gap-2 sm:flex-row sm:items-start sm:gap-3">
              <div>
                <CardTitle>{t('statistics.charts.daily')}</CardTitle>
                <p className="mt-1 text-[11px] sm:text-xs text-[color:var(--color-fg-subtle)]">
                  {t('statistics.charts.dailySubtitle')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <LineIcon className="size-4 text-[color:var(--color-fg-subtle)]" />
                <Badge tone="accent">
                  <span className="size-1.5 rounded-full bg-[color:var(--color-accent)]" />
                  {t('statistics.charts.present')}
                </Badge>
                <Badge tone="danger">
                  <span className="size-1.5 rounded-full bg-[color:var(--color-danger)]" />
                  {t('statistics.charts.absent')}
                </Badge>
              </div>
            </CardHeader>

            {historyChart.length === 0 ? (
              <div className="h-48 sm:h-56 lg:h-72 grid place-items-center text-sm text-[color:var(--color-fg-muted)] px-4 text-center">
                {t('statistics.charts.emptyRange')}
              </div>
            ) : (
              <div className="h-48 sm:h-56 lg:h-72 -mx-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={historyChart} margin={{ top: 10, right: 8, left: -16, bottom: 0 }}>
                    <defs>
                      <linearGradient id="stat-presentes" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.6} />
                        <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="stat-ausentes" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-danger)" stopOpacity={0.45} />
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
                            presentes: t('statistics.charts.present'),
                            ausentes: t('statistics.charts.absent'),
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
                      fill="url(#stat-presentes)"
                    />
                    <Area
                      type="monotone"
                      dataKey="ausentes"
                      stroke="var(--color-danger)"
                      strokeWidth={2}
                      fill="url(#stat-ausentes)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {/* Bar + pie row ───────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
            <Card className="lg:col-span-2 p-4 sm:p-6">
              <CardHeader className="mb-1">
                <div>
                  <CardTitle>{t('statistics.charts.byProject')}</CardTitle>
                  <p className="mt-1 text-[11px] sm:text-xs text-[color:var(--color-fg-subtle)]">
                    {t('statistics.charts.byProjectSubtitle')}
                  </p>
                </div>
                <BarChart3 className="size-4 text-[color:var(--color-fg-subtle)] shrink-0" />
              </CardHeader>

              {projectChart.length === 0 ? (
                <div className="h-48 sm:h-56 lg:h-72 grid place-items-center text-sm text-[color:var(--color-fg-muted)] px-4 text-center">
                  {t('statistics.charts.emptyProjects')}
                </div>
              ) : (
                <div className="h-48 sm:h-56 lg:h-72 -mx-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={projectChart} margin={{ top: 10, right: 8, left: -16, bottom: 0 }} barCategoryGap="22%">
                      <defs>
                        <linearGradient id="bar-presentes" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.95} />
                          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.55} />
                        </linearGradient>
                        <linearGradient id="bar-ausentes" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--color-accent-2)" stopOpacity={0.95} />
                          <stop offset="100%" stopColor="var(--color-accent-2)" stopOpacity={0.5} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="key"
                        tickLine={false}
                        axisLine={false}
                        tickMargin={6}
                        tick={{ fontSize: 10 }}
                        interval="preserveStartEnd"
                        minTickGap={8}
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
                          <ProjectTooltip
                            labels={{
                              projectHeader: (n) => t('statistics.tooltip.project', { number: n }),
                              present: t('statistics.charts.present'),
                              absent: t('statistics.charts.absent'),
                              total: t('statistics.tooltip.total'),
                            }}
                          />
                        }
                        cursor={{ fill: 'color-mix(in oklch, var(--color-fg-subtle) 8%, transparent)' }}
                      />
                      <Bar dataKey="presentes" fill="url(#bar-presentes)" radius={[6, 6, 0, 0]} />
                      <Bar dataKey="ausentes" fill="url(#bar-ausentes)" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>

            {/* Pie / distribution */}
            <Card className="p-4 sm:p-6">
              <CardHeader className="mb-1">
                <div>
                  <CardTitle>{t('statistics.charts.distribution')}</CardTitle>
                  <p className="mt-1 text-[11px] sm:text-xs text-[color:var(--color-fg-subtle)]">
                    {t('statistics.charts.distributionSubtitle')}
                  </p>
                </div>
                <PieIcon className="size-4 text-[color:var(--color-fg-subtle)] shrink-0" />
              </CardHeader>

              {pieData.length === 0 ? (
                <div className="h-48 sm:h-56 lg:h-72 grid place-items-center text-sm text-[color:var(--color-fg-muted)] px-4 text-center">
                  {t('statistics.charts.emptyDistribution')}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <div className="h-44 sm:h-48 lg:h-56 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={pieData}
                          cx="50%"
                          cy="50%"
                          innerRadius="40%"
                          outerRadius="70%"
                          paddingAngle={2}
                          dataKey="value"
                          stroke="var(--color-bg)"
                          strokeWidth={2}
                        >
                          {pieData.map((entry, i) => (
                            <Cell key={i} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip content={<DonutTooltip />} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="w-full space-y-1.5">
                    {pieData.map((d) => (
                      <li key={d.name} className="flex items-center gap-2 text-[11px] sm:text-xs">
                        <span className="size-2.5 rounded-sm shrink-0" style={{ background: d.color }} />
                        <span className="text-[color:var(--color-fg-muted)] flex-1 truncate">{d.name}</span>
                        <span className="tabular text-[color:var(--color-fg)] font-medium">{d.value}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          </div>

          {/* Project breakdown ───────────────────────────────────────── */}
          <Card className="p-0 overflow-hidden">
            <div className="flex flex-col gap-2 sm:gap-3 p-3 sm:p-5 lg:flex-row lg:items-center lg:justify-between border-b border-[color:var(--color-border)]">
              <div>
                <CardTitle>{t('statistics.table.title')}</CardTitle>
                <p className="mt-1 text-[11px] sm:text-xs text-[color:var(--color-fg-subtle)]">
                  {t('statistics.table.subtitle', { filtered: filteredProjectStats.length, total: projectStats.length })}
                </p>
              </div>
              <div className="relative w-full lg:max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-[color:var(--color-fg-subtle)] pointer-events-none" />
                <Input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('statistics.table.search')}
                  className="pl-9 h-11 sm:h-10"
                />
              </div>
            </div>

            {/* Mobile card list (phones) ──────────────────────────────── */}
            <div className="sm:hidden p-3 space-y-2 max-h-[60vh] overflow-auto">
              {loading && filteredProjectStats.length === 0 ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <Card key={i} className="p-3">
                    <Skeleton className="h-4 w-2/3 mb-2" />
                    <Skeleton className="h-3 w-1/2" />
                  </Card>
                ))
              ) : filteredProjectStats.length === 0 ? (
                <div className="py-12 text-center text-sm text-[color:var(--color-fg-muted)]">
                  {searchQuery
                    ? t('statistics.table.noResults')
                    : t('statistics.table.noData')}
                </div>
              ) : (
                <AnimatePresence initial={false}>
                  {filteredProjectStats.map((p) => {
                    const rate = parseFloat(calculateRate(p.present || 0, p.total_students));
                    return (
                      <motion.div
                        key={p.id ?? `${p.project_number}-${p.project_name}`}
                        layout
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.18 }}
                      >
                        <Card className="p-3">
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="min-w-0 flex-1">
                              <div className="text-[11px] tabular text-[color:var(--color-fg-subtle)]">
                                #{p.project_number}
                              </div>
                              <div className="text-sm font-semibold tracking-tight truncate">
                                {getProjectLabel(tProject, p)}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-fg-subtle)]">
                                {t('statistics.table.mobile.total')}
                              </div>
                              <div className="text-sm tabular font-medium">
                                {p.total_students}
                              </div>
                            </div>
                          </div>
                          {selectedDate && (
                            <>
                              <div className="flex items-center justify-between text-xs tabular mb-2">
                                <span className="text-[color:var(--color-success)]">
                                  {t('statistics.table.mobile.present', { count: p.present || 0 })}
                                </span>
                                <span className="text-[color:var(--color-danger)]">
                                  {t('statistics.table.mobile.absent', { count: p.absent || 0 })}
                                </span>
                              </div>
                              <RateBar value={rate} />
                            </>
                          )}
                        </Card>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              )}
            </div>

            {/* Desktop / tablet table ─────────────────────────────────── */}
            <div className="hidden sm:block max-h-[60vh] overflow-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="sticky top-0 z-10 bg-[color-mix(in_oklch,var(--color-bg-2)_92%,transparent)] backdrop-blur-md">
                    <Th>{t('statistics.table.columns.projectNumber')}</Th>
                    <Th>{t('statistics.table.columns.name')}</Th>
                    <Th align="right">{t('statistics.table.columns.students')}</Th>
                    {selectedDate && (
                      <>
                        <Th align="right">{t('statistics.table.columns.present')}</Th>
                        <Th align="right">{t('statistics.table.columns.absent')}</Th>
                        <Th>{t('statistics.table.columns.rate')}</Th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {loading && filteredProjectStats.length === 0 ? (
                    Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: selectedDate ? 6 : 3 }).map((__, j) => (
                          <td key={j} className="px-5 py-4 border-t border-[color:var(--color-border)]">
                            <Skeleton className="h-4 w-3/4" />
                          </td>
                        ))}
                      </tr>
                    ))
                  ) : filteredProjectStats.length === 0 ? (
                    <tr>
                      <td
                        colSpan={selectedDate ? 6 : 3}
                        className="px-5 py-16 text-center text-sm text-[color:var(--color-fg-muted)]"
                      >
                        {searchQuery
                          ? t('statistics.table.noResults')
                          : t('statistics.table.noData')}
                      </td>
                    </tr>
                  ) : (
                    <AnimatePresence initial={false}>
                      {filteredProjectStats.map((p) => {
                        const rate = parseFloat(calculateRate(p.present || 0, p.total_students));
                        return (
                          <motion.tr
                            key={p.id ?? `${p.project_number}-${p.project_name}`}
                            layout
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.18 }}
                            className="border-t border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
                          >
                            <td className="px-5 py-3.5 tabular text-[color:var(--color-fg-muted)]">
                              #{p.project_number}
                            </td>
                            <td className="px-5 py-3.5 font-medium tracking-tight">
                              {getProjectLabel(tProject, p)}
                            </td>
                            <td className="px-5 py-3.5 text-right tabular">
                              {p.total_students}
                            </td>
                            {selectedDate && (
                              <>
                                <td className="px-5 py-3.5 text-right tabular text-[color:var(--color-success)]">
                                  {p.present || 0}
                                </td>
                                <td className="px-5 py-3.5 text-right tabular text-[color:var(--color-danger)]">
                                  {p.absent || 0}
                                </td>
                                <td className="px-5 py-3.5 min-w-[180px]">
                                  <RateBar value={rate} />
                                </td>
                              </>
                            )}
                          </motion.tr>
                        );
                      })}
                    </AnimatePresence>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

const Th = ({ children, align = 'left' }) => (
  <th
    className={
      'px-5 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] border-b border-[color:var(--color-border)] ' +
      (align === 'right' ? 'text-right' : 'text-left')
    }
  >
    {children}
  </th>
);

// Inline progress bar that picks tone from the rate. Keeps its own width
// math so the parent table doesn't have to know about it.
const RateBar = ({ value }) => {
  const safe = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  const tone =
    safe >= 90 ? 'var(--color-success)' :
    safe >= 70 ? 'var(--color-accent)' :
    safe >= 40 ? 'var(--color-warn)' :
    'var(--color-danger)';
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 flex-1 rounded-full bg-[color-mix(in_oklch,var(--color-fg-subtle)_18%,transparent)] overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${safe}%` }}
          transition={{ duration: 0.6, ease: [0.25, 1, 0.5, 1] }}
          className="h-full rounded-full"
          style={{ background: tone }}
        />
      </div>
      <span className="tabular text-xs text-[color:var(--color-fg-muted)] w-12 text-right">
        {safe.toFixed(0)}%
      </span>
    </div>
  );
};

// Compact filter pill group used by the date-mode toggle. Uses a layoutId
// so the active background morphs between options.
const ToggleGroup = ({ value, onChange, options }) => (
  <div role="tablist" className="inline-flex items-center gap-1 p-1 rounded-xl surface">
    {options.map((o) => {
      const active = o.value === value;
      return (
        <button
          key={o.value}
          role="tab"
          aria-selected={active}
          onClick={() => onChange(o.value)}
          className={
            'relative inline-flex items-center h-9 sm:h-8 px-3 rounded-lg text-xs font-medium tracking-tight transition-colors ' +
            (active
              ? 'text-[oklch(0.18_0.02_260)]'
              : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]')
          }
        >
          {active && (
            <motion.span
              layoutId="stat-toggle-pill"
              className="absolute inset-0 bg-[color:var(--color-accent)] rounded-lg"
              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      );
    })}
  </div>
);

const DateField = ({ label, ...props }) => (
  <label className="inline-flex items-center gap-2 h-11 sm:h-10 px-3 rounded-xl surface text-sm min-w-0">
    <Calendar className="size-3.5 text-[color:var(--color-fg-subtle)] shrink-0" />
    <span className="text-[11px] sm:text-xs text-[color:var(--color-fg-subtle)] shrink-0">{label}</span>
    <input
      type="date"
      {...props}
      className="bg-transparent text-xs sm:text-sm text-[color:var(--color-fg)] focus:outline-none tabular [color-scheme:dark] min-w-0 w-full"
    />
  </label>
);

// Generic chart tooltip - used by the area chart. `seriesNames` maps the
// recharts dataKey to a localized label.
const ChartTooltip = ({ active, payload, label, seriesNames = {} }) => {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="surface rounded-xl px-3 py-2.5 text-xs shadow-lg">
      <div className="text-[color:var(--color-fg-subtle)] mb-1 tracking-wide">{label}</div>
      <div className="space-y-1">
        {payload.map((p) => (
          <div key={p.dataKey} className="flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ background: p.color }} />
            <span className="text-[color:var(--color-fg-muted)] capitalize">
              {seriesNames[p.dataKey] || p.dataKey}
            </span>
            <span className="ml-auto tabular text-[color:var(--color-fg)] font-medium">{p.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Bar-chart tooltip carries the project name + total in addition to the
// usual two series. `labels` carries localized strings - the parent owns the
// translation so the tooltip stays a presentational component.
const ProjectTooltip = ({ active, payload, labels }) => {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  const headerText = labels?.projectHeader
    ? labels.projectHeader(row.project_number)
    : `#${row.project_number}`;
  return (
    <div className="surface rounded-xl px-3 py-2.5 text-xs shadow-lg min-w-[180px]">
      <div className="font-medium text-[color:var(--color-fg)] mb-0.5">
        {headerText}
      </div>
      <div className="text-[color:var(--color-fg-subtle)] mb-2 truncate max-w-[26ch]">
        {row.project_name}
      </div>
      <div className="space-y-1">
        <Row color="var(--color-accent)" label={labels?.present ?? 'Presentes'} value={row.presentes} />
        <Row color="var(--color-accent-2)" label={labels?.absent ?? 'Ausentes'} value={row.ausentes} />
        <Row color="var(--color-fg-subtle)" label={labels?.total ?? 'Total'} value={row.total_students} />
      </div>
    </div>
  );
};

const DonutTooltip = ({ active, payload }) => {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  return (
    <div className="surface rounded-xl px-3 py-2 text-xs shadow-lg">
      <div className="flex items-center gap-2">
        <span className="size-2 rounded-full" style={{ background: row.color }} />
        <span className="text-[color:var(--color-fg-muted)]">{row.name}</span>
        <span className="ml-3 tabular text-[color:var(--color-fg)] font-medium">{row.value}</span>
      </div>
    </div>
  );
};

const Row = ({ color, label, value }) => (
  <div className="flex items-center gap-2">
    <span className="size-2 rounded-full" style={{ background: color }} />
    <span className="text-[color:var(--color-fg-muted)]">{label}</span>
    <span className="ml-auto tabular text-[color:var(--color-fg)] font-medium">{value}</span>
  </div>
);

export default Statistics;
