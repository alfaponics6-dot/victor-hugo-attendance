import { useState, useEffect, useMemo } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'motion/react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import {
  LogOut,
  UserCog,
  Calendar,
  Filter,
  Download,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Search,
  RefreshCw,
  BarChart3,
  Users,
  Printer,
  ArrowUp,
  ArrowDown,
  X,
  History,
  ClipboardList,
  Activity,
  Folders,
  ListChecks,
  ClipboardCheck,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../context/useAuth.js';
import {
  getAbsentStudents,
  getAllProjectsAdmin,
  getAttendanceSummaryAdmin,
  getAttendanceByStudent,
  getAttachmentUrl,
} from '../api/client';
import { getTodayDate, addDays, formatDateForDisplay } from '../utils/dateUtils';
import AppShell, { PageHeader, SectionTitle } from '../components/ui/AppShell';
import LanguageSwitcher from '../components/ui/LanguageSwitcher';
import ThemeToggle from '../components/ui/ThemeToggle';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import StatCard from '../components/ui/StatCard';
import Modal from '../components/ui/Modal';
import Tabs from '../components/ui/Tabs';
import Spinner from '../components/ui/Spinner';
import Skeleton from '../components/ui/Skeleton';
import { Input, Select, Label } from '../components/ui/Input';
import { cn } from '../lib/cn';
import { getProjectLabel } from '../lib/projectI18n';
import ProfesorPassesView from '../components/features/profesor/ProfesorPassesView';
import ProfesorComplianceView from '../components/features/profesor/ProfesorComplianceView';

/* ────────────────────────────────────────────────────────────────────────────
   Small helpers used throughout the page. Kept inline so the file stays
   self-contained and the parent agents only own this single file.
   ──────────────────────────────────────────────────────────────────────── */

const fadeStagger = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.035, delayChildren: 0.05 },
  },
};
const fadeItem = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: [0.25, 1, 0.5, 1] } },
};

/** Pretty-format an YYYY-MM-DD date as a short localized label. */
const fmtShortDate = (s, locale = 'es-ES') => {
  if (!s) return '';
  try {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(locale, {
      day: '2-digit',
      month: 'short',
    });
  } catch {
    return s;
  }
};

/** A single segmented button used inside the quick-filter row. */
const SegButton = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={cn(
      'shrink-0 h-10 px-4 sm:h-9 sm:px-4 rounded-xl text-sm font-medium tracking-tight transition-colors',
      active
        ? 'bg-[color:var(--color-accent)] text-[oklch(0.18_0.02_260)] shadow-[0_8px_28px_-12px_color-mix(in_oklch,var(--color-accent)_60%,transparent)]'
        : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-hover)]'
    )}
  >
    {children}
  </button>
);

/* ────────────────────────────────────────────────────────────────────────── */

function ProfesorDashboard() {
  const { t, i18n } = useTranslation(['profesor', 'common']);
  const { t: tProject } = useTranslation('projects');
  const pname = (p) => getProjectLabel(tProject, p);
  const lang = i18n.language || 'es';
  const [absences, setAbsences] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [summaryData, setSummaryData] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState('table'); // 'table' or 'grouped'
  // Top-level view toggle: 'absences' (existing) vs 'passes' (new
  // profe-only start/end attendance passes).
  const [mainView, setMainView] = useState('absences');
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [studentHistory, setStudentHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [filters, setFilters] = useState({
    date: getTodayDate(),
    projectId: '',
    justification: '',
  });
  const [stats, setStats] = useState({
    total: 0,
    justified: 0,
    unjustified: 0,
    totalStudents: 0,
    attendanceRate: 0,
  });

  const { leader, logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    fetchProjects();
    fetchSummary();
  }, []);

  useEffect(() => {
    fetchAbsences();
  }, [filters]);

  const fetchProjects = async () => {
    try {
      const data = await getAllProjectsAdmin();
      setProjects(data);
    } catch (error) {
      console.error('Error fetching projects:', error);
    }
  };

  const fetchSummary = async () => {
    try {
      const today = getTodayDate();
      const startDate = addDays(today, -7);
      const data = await getAttendanceSummaryAdmin(startDate, today);
      setSummaryData(data);
    } catch (error) {
      console.error('Error fetching summary:', error);
    }
  };

  const fetchAbsences = async () => {
    setLoading(true);
    try {
      const data = await getAbsentStudents(
        filters.date || null,
        filters.projectId || null,
        filters.justification || null
      );
      setAbsences(data);

      const justified = data.filter((a) => a.justification === 'justificada').length;
      const unjustified = data.filter((a) => a.justification === 'injustificada').length;
      const uniqueProjects = [...new Set(data.map((a) => a.project_id))];

      setStats({
        total: data.length,
        justified,
        unjustified,
        totalStudents: data.length,
        projectsAffected: uniqueProjects.length,
      });
    } catch (error) {
      console.error('Error fetching absences:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchStudentHistory = async (studentId, studentName) => {
    setLoadingHistory(true);
    setSelectedStudent({ id: studentId, name: studentName });
    try {
      const data = await getAttendanceByStudent(studentId);
      setStudentHistory(data);
    } catch (error) {
      console.error('Error fetching student history:', error);
      setStudentHistory([]);
    } finally {
      setLoadingHistory(false);
    }
  };

  const closeHistoryModal = () => {
    setSelectedStudent(null);
    setStudentHistory([]);
  };

  const handleFilterChange = (field, value) => {
    setFilters((prev) => ({ ...prev, [field]: value }));
  };

  const setQuickDate = (option) => {
    let date = '';
    switch (option) {
      case 'today':
        date = getTodayDate();
        break;
      case 'yesterday':
        date = addDays(getTodayDate(), -1);
        break;
      case 'week':
        date = ''; // Show all
        break;
      default:
        date = getTodayDate();
    }
    setFilters((prev) => ({ ...prev, date }));
  };

  const clearFilters = () => {
    setFilters({ date: '', projectId: '', justification: '' });
    setSearchTerm('');
  };

  // Filter absences by search term
  const filteredAbsences = useMemo(() => {
    if (!searchTerm) return absences;
    const term = searchTerm.toLowerCase();
    return absences.filter(
      (a) =>
        a.student_name.toLowerCase().includes(term) ||
        a.student_code?.toLowerCase().includes(term) ||
        a.project_name.toLowerCase().includes(term)
    );
  }, [absences, searchTerm]);

  // Group absences by project
  const groupedAbsences = useMemo(() => {
    const groups = {};
    filteredAbsences.forEach((absence) => {
      const key = `${absence.project_number} - ${absence.project_name}`;
      if (!groups[key]) {
        groups[key] = {
          projectNumber: absence.project_number,
          projectName: absence.project_name,
          absences: [],
        };
      }
      groups[key].absences.push(absence);
    });
    return Object.values(groups).sort((a, b) => a.projectNumber - b.projectNumber);
  }, [filteredAbsences]);

  // Calculate weekly trend.
  //
  // summaryData comes from getAttendanceSummaryAdmin, which the server
  // groups by (date, project_id). So 7 days * 7 projects yields up to 49
  // rows, not 7. Dividing totalAbsences by summaryData.length gives a
  // per-(date,project) average and dramatically under-reports the daily
  // baseline. Collapse by date first.
  const weeklyTrend = useMemo(() => {
    if (summaryData.length < 2) return { direction: 'same', percentage: 0 };
    const byDate = new Map();
    for (const row of summaryData) {
      byDate.set(row.date, (byDate.get(row.date) || 0) + (row.absent_count || 0));
    }
    if (byDate.size < 2) return { direction: 'same', percentage: 0 };
    const totalAbsences = [...byDate.values()].reduce((s, n) => s + n, 0);
    const avgDaily = totalAbsences / byDate.size;
    const todayAbsences = stats.total;

    if (avgDaily === 0) return { direction: 'same', percentage: 0 };
    if (todayAbsences > avgDaily) {
      return {
        direction: 'up',
        percentage: Math.round(((todayAbsences - avgDaily) / avgDaily) * 100),
      };
    }
    if (todayAbsences < avgDaily) {
      return {
        direction: 'down',
        percentage: Math.round(((avgDaily - todayAbsences) / avgDaily) * 100),
      };
    }
    return { direction: 'same', percentage: 0 };
  }, [summaryData, stats.total]);

  // Sparkline data for the modal - last 14 entries in chronological order.
  // The server returns getAttendanceByStudent sorted DESC, so .slice(-14)
  // would grab the OLDEST 14. We sort ASC by date first, then take the
  // trailing 14 to get the most recent in left-to-right time order.
  const historyChartData = useMemo(() => {
    if (!studentHistory.length) return [];
    return [...studentHistory]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-14)
      .map((r) => ({
        date: r.date,
        present: r.status === 'present' ? 1 : 0,
      }))
      .reduce((acc, cur, i, arr) => {
        // running attendance ratio so the chart shows trajectory
        const upto = arr.slice(0, i + 1);
        const ratio = upto.filter((x) => x.present).length / upto.length;
        acc.push({ date: cur.date, ratio: Math.round(ratio * 100) });
        return acc;
      }, []);
  }, [studentHistory]);

  const exportToCSV = () => {
    if (filteredAbsences.length === 0) return;
    const headers = [
      t('csv.headers.date'),
      t('csv.headers.project'),
      t('csv.headers.student'),
      t('csv.headers.studentId'),
      t('csv.headers.email'),
      t('csv.headers.status'),
      t('csv.headers.justification'),
      t('csv.headers.observation'),
      t('csv.headers.leader'),
    ];
    const naLabel = t('csv.values.notAvailable');
    const noObs = t('csv.values.noObservation');
    const rows = filteredAbsences.map((a) => [
      a.date,
      `${a.project_number} - ${a.project_name}`,
      a.student_name,
      a.student_code || naLabel,
      a.student_email || naLabel,
      t('csv.values.absent'),
      a.justification === 'justificada'
        ? t('csv.values.justified')
        : t('csv.values.unjustified'),
      a.observation || noObs,
      a.leader_name,
    ]);
    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
    ].join('\n');

    const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${t('csv.filenamePrefix')}_${filters.date || t('csv.filenameAll')}.csv`;
    link.click();
  };

  const handlePrint = () => window.print();

  if (!leader || (leader.role !== 'profesor' && leader.role !== 'admin')) {
    return <Navigate to="/" replace />;
  }

  /* ──────────────────────────────────────────────────────────────────────
     Derived display values
     ────────────────────────────────────────────────────────────────────── */

  const justifiedPct = stats.total > 0 ? Math.round((stats.justified / stats.total) * 100) : 0;
  const unjustifiedPct = stats.total > 0 ? Math.round((stats.unjustified / stats.total) * 100) : 0;

  // We're displaying ABSENCES, so more absences is BAD. StatCard paints
  // `dir: 'up'` green and `dir: 'down'` red, so we invert: a real "more
  // absences than average" must map to the red `down` chip, and a "fewer
  // absences than average" to the green `up` chip. The arrow glyph in the
  // i18n string already conveys the direction the trend went; StatCard adds
  // its own glyph based on `dir` (which is the semantic, not the literal).
  const trendChip =
    weeklyTrend.direction !== 'same' && filters.date
      ? {
          dir: weeklyTrend.direction === 'up' ? 'down' : 'up',
          value:
            weeklyTrend.direction === 'up'
              ? t('trend.up', { n: weeklyTrend.percentage }).replace(/^[▲▼]\s*/, '')
              : t('trend.down', { n: weeklyTrend.percentage }).replace(/^[▲▼]\s*/, ''),
        }
      : null;

  const dateChips = [
    { key: 'today', label: t('common:labels.today'), match: filters.date === getTodayDate() },
    {
      key: 'yesterday',
      label: t('common:labels.yesterday'),
      match: filters.date === addDays(getTodayDate(), -1),
    },
    { key: 'week', label: t('common:labels.allDates'), match: filters.date === '' },
  ];

  const presentCount = studentHistory.filter((h) => h.status === 'present').length;
  const absentCount = studentHistory.filter((h) => h.status === 'absent').length;
  const histTotal = presentCount + absentCount;
  const presentRate = histTotal > 0 ? Math.round((presentCount / histTotal) * 100) : 0;

  /* ──────────────────────────────────────────────────────────────────────
     Render
     ────────────────────────────────────────────────────────────────────── */

  return (
    <AppShell>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('title')}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <UserCog className="size-4" /> {leader.name}
          </span>
        }
        actions={
          <>
            <ThemeToggle />
            <LanguageSwitcher align="left" />
            <Button
              variant="ghost"
              size="icon"
              onClick={handlePrint}
              title={t('common:actions.print')}
              aria-label={t('common:actions.print')}
            >
              <Printer className="size-4" />
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                logout();
                navigate('/');
              }}
              title={t('common:actions.logout')}
              aria-label={t('common:actions.logout')}
              className="px-3 sm:px-4"
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">{t('common:actions.logout')}</span>
            </Button>
          </>
        }
      />

      {/* Top-level switcher between the existing "Ausencias" oversight
          view and the new profe-only attendance "Pasadas" workflow.
          The "Supervisión" tab is coordinator-only — gated by
          leader.isCoordinator so non-coordinators don't even see it. */}
      <div className="mb-5">
        <Tabs
          value={mainView}
          onChange={setMainView}
          tabs={[
            { key: 'absences', label: t('mainViews.absences'), icon: ListChecks },
            { key: 'passes', label: t('mainViews.passes'), icon: ClipboardCheck },
            ...(leader?.isCoordinator
              ? [{ key: 'compliance', label: t('mainViews.compliance'), icon: ShieldCheck }]
              : []),
          ]}
        />
      </div>

      {mainView === 'passes' ? (
        <ProfesorPassesView />
      ) : mainView === 'compliance' && leader?.isCoordinator ? (
        <ProfesorComplianceView />
      ) : (
      <>

      {/* ─── Stat tiles ─────────────────────────────────────────────────── */}
      <motion.div
        variants={fadeStagger}
        initial="hidden"
        animate="show"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6 sm:mb-8"
      >
        <motion.div variants={fadeItem}>
          <StatCard
            label={t('stats.totalAbsences')}
            value={stats.total}
            icon={AlertTriangle}
            tone={stats.total > 0 ? 'warn' : 'default'}
            hint={
              filters.date
                ? `${formatDateForDisplay(filters.date, lang)}`
                : t('stats.totalAbsencesHintAll')
            }
            trend={trendChip}
          />
        </motion.div>
        <motion.div variants={fadeItem}>
          <StatCard
            label={t('stats.justified')}
            value={stats.justified}
            icon={CheckCircle2}
            tone="success"
            hint={t('stats.percentOfTotal', { n: justifiedPct })}
          />
        </motion.div>
        <motion.div variants={fadeItem}>
          <StatCard
            label={t('stats.unjustified')}
            value={stats.unjustified}
            icon={XCircle}
            tone="danger"
            hint={t('stats.percentOfTotal', { n: unjustifiedPct })}
          />
        </motion.div>
        <motion.div variants={fadeItem}>
          <StatCard
            label={t('stats.projectsAffected')}
            value={stats.projectsAffected || 0}
            icon={Folders}
            tone="default"
            hint={t('stats.ofTotal', { n: projects.length })}
          />
        </motion.div>
      </motion.div>

      {/* ─── Quick date chips + view toggle ─────────────────────────────── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between mb-4">
        <div
          className={cn(
            'flex items-center gap-1 surface rounded-2xl p-1 self-start max-w-full',
            'overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden'
          )}
        >
          {dateChips.map((c) => (
            <SegButton
              key={c.key}
              active={c.match}
              onClick={() => setQuickDate(c.key)}
            >
              {c.label}
            </SegButton>
          ))}
        </div>
        <div className="self-start lg:self-auto">
          <Tabs
            value={viewMode}
            onChange={setViewMode}
            tabs={[
              { key: 'table', label: t('views.list'), icon: ClipboardList },
              { key: 'grouped', label: t('views.grouped'), icon: BarChart3 },
            ]}
          />
        </div>
      </div>

      {/* ─── Filter card ─────────────────────────────────────────────────── */}
      <Card className="mb-6 sm:mb-8">
        <div className="flex items-center gap-2 mb-3 sm:mb-4 text-[color:var(--color-fg-muted)]">
          <Filter className="size-4" />
          <span className="text-[12px] sm:text-[13px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)]">
            {t('filters.title')}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-12 gap-3 items-end">
          {/* search */}
          <div className="xl:col-span-4">
            <Label>
              <span className="inline-flex items-center gap-1.5">
                <Search className="size-3" /> {t('common:actions.search')}
              </span>
            </Label>
            <div className="relative">
              <Input
                placeholder={t('filters.searchPlaceholder')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pr-9"
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  aria-label={t('actions.clearSearch')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 size-7 grid place-items-center rounded-md text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* date */}
          <div className="xl:col-span-2">
            <Label>
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="size-3" /> {t('common:labels.date')}
              </span>
            </Label>
            <Input
              type="date"
              value={filters.date}
              onChange={(e) => handleFilterChange('date', e.target.value)}
            />
          </div>

          {/* project */}
          <div className="xl:col-span-3">
            <Label>
              <span className="inline-flex items-center gap-1.5">
                <Users className="size-3" /> {t('common:labels.project')}
              </span>
            </Label>
            <Select
              value={filters.projectId}
              onChange={(e) => handleFilterChange('projectId', e.target.value)}
            >
              <option value="">{t('filters.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.project_number} - {pname(p)}
                </option>
              ))}
            </Select>
          </div>

          {/* justification */}
          <div className="xl:col-span-3">
            <Label>
              <span className="inline-flex items-center gap-1.5">
                <Filter className="size-3" /> {t('common:labels.justification')}
              </span>
            </Label>
            <Select
              value={filters.justification}
              onChange={(e) => handleFilterChange('justification', e.target.value)}
            >
              <option value="">{t('filters.allJustifications')}</option>
              <option value="justificada">{t('common:status.justified')}</option>
              <option value="injustificada">{t('common:status.unjustified')}</option>
            </Select>
          </div>

          {/* actions */}
          <div className="xl:col-span-12 flex flex-col sm:flex-row sm:flex-wrap gap-2 pt-1">
            <Button
              variant="ghost"
              onClick={clearFilters}
              className="w-full sm:w-auto h-11 sm:h-10"
            >
              <RefreshCw className="size-4" /> {t('common:actions.clear')}
            </Button>
            <Button
              variant="primary"
              onClick={exportToCSV}
              disabled={filteredAbsences.length === 0}
              className="w-full sm:w-auto sm:ml-auto h-11 sm:h-10"
            >
              <Download className="size-4" /> {t('common:actions.exportCsv')}
            </Button>
          </div>
        </div>
      </Card>

      {/* ─── Results section ─────────────────────────────────────────────── */}
      <SectionTitle
        action={
          <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2">
            {filters.date && (
              <Badge tone="accent">
                <Calendar className="size-3" /> {fmtShortDate(filters.date, lang)}
              </Badge>
            )}
            <Badge tone="outline">
              <span className="hidden sm:inline">
                {t('results.records', { count: filteredAbsences.length })}
              </span>
              <span className="sm:hidden">
                {t('results.recordsShort', { count: filteredAbsences.length })}
              </span>
            </Badge>
          </div>
        }
      >
        {t('results.title')}
      </SectionTitle>

      <AnimatePresence mode="wait">
        {loading ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-2"
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </motion.div>
        ) : filteredAbsences.length === 0 ? (
          <motion.div
            key="empty"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            <Card className="text-center py-14">
              <div className="mx-auto size-12 rounded-2xl grid place-items-center bg-[color-mix(in_oklch,var(--color-success)_18%,transparent)] text-[color:var(--color-success)] mb-4">
                <CheckCircle2 className="size-6" />
              </div>
              <h3 className="text-base font-semibold tracking-tight">{t('results.empty')}</h3>
              <p className="text-sm text-[color:var(--color-fg-muted)] mt-1">
                {t('results.emptyHint')}
              </p>
              {searchTerm && (
                <p className="text-xs text-[color:var(--color-fg-subtle)] mt-2">
                  {t('results.searchHint')}
                </p>
              )}
            </Card>
          </motion.div>
        ) : viewMode === 'table' ? (
          <motion.div
            key="table"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
          >
            {/* Phone: card list */}
            <motion.div
              variants={fadeStagger}
              initial="hidden"
              animate="show"
              className="sm:hidden space-y-2"
            >
              {filteredAbsences.map((absence) => (
                <motion.div key={absence.attendance_id} variants={fadeItem}>
                  <Card hover className="p-3.5">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1 space-y-2">
                        {/* Top row: date + project number badge */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[11px] tabular text-[color:var(--color-fg-muted)] whitespace-nowrap">
                            {fmtShortDate(absence.date, lang)}
                          </span>
                          <span className="inline-flex h-5 px-1.5 items-center rounded-md text-[10px] font-mono tabular bg-[color-mix(in_oklch,var(--color-accent)_15%,transparent)] text-[color:var(--color-accent)]">
                            {absence.project_number}
                          </span>
                          <span className="text-[11px] text-[color:var(--color-fg-subtle)] truncate min-w-0">
                            {pname(absence)}
                          </span>
                        </div>
                        {/* Student name */}
                        <div className="text-[15px] font-semibold tracking-tight leading-tight">
                          {absence.student_name}
                        </div>
                        {/* Carnet + leader */}
                        <div className="text-[11px] tabular text-[color:var(--color-fg-subtle)] truncate">
                          {absence.student_code || t('table.noCarnet')} · {absence.leader_name}
                        </div>
                        {/* Justification badge + observation */}
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          {absence.justification === 'justificada' ? (
                            <Badge tone="success">
                              <CheckCircle2 className="size-3" /> {t('common:status.justified')}
                            </Badge>
                          ) : (
                            <Badge tone="danger">
                              <XCircle className="size-3" /> {t('common:status.unjustified')}
                            </Badge>
                          )}
                          {absence.observation && (
                            <span
                              className="text-[11px] text-[color:var(--color-fg-muted)] line-clamp-2 min-w-0"
                              title={absence.observation}
                            >
                              {absence.observation}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* Right-side actions */}
                      <div className="flex flex-col items-center gap-1 shrink-0">
                        <button
                          onClick={() =>
                            fetchStudentHistory(absence.student_id, absence.student_name)
                          }
                          title={t('common:actions.viewHistory')}
                          aria-label={t('common:actions.viewHistory')}
                          className="size-11 grid place-items-center rounded-lg text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
                        >
                          <History className="size-4" />
                        </button>
                        {absence.attachment_file_name && (
                          <a
                            href={getAttachmentUrl(absence.student_id, absence.date)}
                            title={t('downloadAttachmentTitle', { name: absence.attachment_file_name })}
                            aria-label={t('downloadAttachmentAria')}
                            download
                            className="size-11 grid place-items-center rounded-lg text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-accent)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
                          >
                            <Download className="size-4" />
                          </a>
                        )}
                      </div>
                    </div>
                  </Card>
                </motion.div>
              ))}
            </motion.div>

            {/* Desktop: table */}
            <Card className="hidden sm:block p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] sticky top-0 bg-[color-mix(in_oklch,var(--color-surface)_95%,transparent)] backdrop-blur z-10">
                      <th className="px-4 py-3 font-medium">{t('common:labels.date')}</th>
                      <th className="px-4 py-3 font-medium">{t('common:labels.project')}</th>
                      <th className="px-4 py-3 font-medium">{t('table.student')}</th>
                      <th className="px-4 py-3 font-medium">{t('common:labels.studentId')}</th>
                      <th className="px-4 py-3 font-medium">{t('common:labels.justification')}</th>
                      <th className="px-4 py-3 font-medium">{t('common:labels.observation')}</th>
                      <th className="px-4 py-3 font-medium">{t('common:labels.leader')}</th>
                      <th className="px-4 py-3 font-medium text-right">{t('common:labels.actions')}</th>
                    </tr>
                  </thead>
                  <motion.tbody
                    variants={fadeStagger}
                    initial="hidden"
                    animate="show"
                  >
                    {filteredAbsences.map((absence) => (
                      <motion.tr
                        key={absence.attendance_id}
                        variants={fadeItem}
                        className="group border-t border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
                      >
                        <td className="px-4 py-3.5 tabular text-[color:var(--color-fg-muted)] whitespace-nowrap">
                          {fmtShortDate(absence.date, lang)}
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2">
                            <span className="inline-flex h-6 px-2 items-center rounded-md text-[11px] font-mono tabular bg-[color-mix(in_oklch,var(--color-accent)_15%,transparent)] text-[color:var(--color-accent)]">
                              {absence.project_number}
                            </span>
                            <span className="text-[color:var(--color-fg)] truncate max-w-[18ch]">
                              {pname(absence)}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 font-medium tracking-tight">
                          {absence.student_name}
                        </td>
                        <td className="px-4 py-3.5 tabular text-[color:var(--color-fg-muted)]">
                          {absence.student_code || '-'}
                        </td>
                        <td className="px-4 py-3.5">
                          {absence.justification === 'justificada' ? (
                            <Badge tone="success">
                              <CheckCircle2 className="size-3" /> {t('common:status.justified')}
                            </Badge>
                          ) : (
                            <Badge tone="danger">
                              <XCircle className="size-3" /> {t('common:status.unjustified')}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-[color:var(--color-fg-muted)] max-w-[26ch]">
                          <span className="truncate block" title={absence.observation || ''}>
                            {absence.observation || (
                              <span className="text-[color:var(--color-fg-subtle)]">-</span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 text-[color:var(--color-fg-muted)] whitespace-nowrap">
                          {absence.leader_name}
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() =>
                                fetchStudentHistory(absence.student_id, absence.student_name)
                              }
                              title={t('common:actions.viewHistory')}
                              className="size-8 grid place-items-center rounded-lg text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
                            >
                              <History className="size-4" />
                            </button>
                            {absence.attachment_file_name && (
                              <a
                                href={getAttachmentUrl(absence.student_id, absence.date)}
                                title={t('downloadAttachmentTitle', { name: absence.attachment_file_name })}
                                download
                                className="size-8 grid place-items-center rounded-lg text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-accent)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
                              >
                                <Download className="size-4" />
                              </a>
                            )}
                          </div>
                        </td>
                      </motion.tr>
                    ))}
                  </motion.tbody>
                </table>
              </div>
            </Card>
          </motion.div>
        ) : (
          <motion.div
            key="grouped"
            variants={fadeStagger}
            initial="hidden"
            animate="show"
            exit={{ opacity: 0 }}
            className="grid grid-cols-1 lg:grid-cols-2 gap-4"
          >
            {groupedAbsences.map((group) => (
              <motion.div key={group.projectNumber} variants={fadeItem}>
                <Card hover className="p-0 overflow-hidden">
                  <div className="flex items-center justify-between gap-2 sm:gap-3 px-4 sm:px-5 py-3 sm:py-4 border-b border-[color:var(--color-border)]">
                    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                      <span className="inline-flex h-7 sm:h-8 px-2 sm:px-2.5 items-center rounded-lg text-[11px] sm:text-[12px] font-mono tabular bg-[color-mix(in_oklch,var(--color-accent)_18%,transparent)] text-[color:var(--color-accent)] shrink-0">
                        {group.projectNumber}
                      </span>
                      <h3 className="text-sm font-semibold tracking-tight truncate">
                        {pname({ project_number: group.projectNumber, project_name: group.projectName })}
                      </h3>
                    </div>
                    <Badge
                      tone={group.absences.length > 3 ? 'warn' : 'outline'}
                      className="shrink-0"
                      title={t('grouped.absences', { count: group.absences.length })}
                    >
                      <Activity className="size-3" />
                      <span className="tabular">{group.absences.length}</span>
                    </Badge>
                  </div>
                  <ul className="divide-y divide-[color:var(--color-border)]">
                    {group.absences.map((absence) => (
                      <li
                        key={absence.attendance_id}
                        className="flex items-center gap-2 sm:gap-3 px-4 sm:px-5 py-3 sm:py-3.5 hover:bg-[color:var(--color-surface-hover)] transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium tracking-tight truncate">
                            {absence.student_name}
                          </div>
                          <div className="text-[11px] tabular text-[color:var(--color-fg-subtle)] mt-0.5 truncate">
                            {absence.student_code || t('table.noCarnet')} · {fmtShortDate(absence.date, lang)}
                          </div>
                        </div>
                        {absence.justification === 'justificada' ? (
                          <Badge tone="success" className="shrink-0">{t('grouped.justifiedShort')}</Badge>
                        ) : (
                          <Badge tone="danger" className="shrink-0">{t('grouped.unjustifiedShort')}</Badge>
                        )}
                        <button
                          onClick={() =>
                            fetchStudentHistory(absence.student_id, absence.student_name)
                          }
                          title={t('common:actions.viewHistory')}
                          aria-label={t('common:actions.viewHistory')}
                          className="size-11 sm:size-8 grid place-items-center rounded-lg text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface)] transition-colors shrink-0"
                        >
                          <History className="size-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </Card>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Student history modal ───────────────────────────────────────── */}
      <Modal
        open={!!selectedStudent}
        onClose={closeHistoryModal}
        size="lg"
        title={selectedStudent ? t('history.title', { name: selectedStudent.name }) : ''}
        description={t('history.description')}
      >
        {loadingHistory ? (
          <div className="flex items-center justify-center py-14 text-[color:var(--color-fg-muted)]">
            <Spinner size="lg" className="text-[color:var(--color-accent)]" />
          </div>
        ) : studentHistory.length === 0 ? (
          <div className="text-center py-10 text-sm text-[color:var(--color-fg-muted)]">
            {t('history.noRecords')}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Summary chips */}
            <div className="grid grid-cols-3 gap-2">
              <div className="surface-flat rounded-xl px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] flex items-center gap-1.5">
                  <CheckCircle2 className="size-3" /> {t('history.summary.present')}
                </div>
                <div className="text-2xl font-semibold tabular tracking-tight mt-1 text-[color:var(--color-success)]">
                  {presentCount}
                </div>
              </div>
              <div className="surface-flat rounded-xl px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] flex items-center gap-1.5">
                  <XCircle className="size-3" /> {t('history.summary.absent')}
                </div>
                <div className="text-2xl font-semibold tabular tracking-tight mt-1 text-[color:var(--color-danger)]">
                  {absentCount}
                </div>
              </div>
              <div className="surface-flat rounded-xl px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] flex items-center gap-1.5">
                  <Activity className="size-3" /> {t('history.summary.rate')}
                </div>
                <div className="text-2xl font-semibold tabular tracking-tight mt-1 gradient-text">
                  {presentRate}
                  <span className="text-sm text-[color:var(--color-fg-subtle)] ml-0.5">%</span>
                </div>
              </div>
            </div>

            {/* Sparkline of attendance ratio over time */}
            {historyChartData.length >= 2 && (
              <div className="surface-flat rounded-xl p-3">
                <div className="text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] mb-2 px-1">
                  {t('history.chartTitle')}
                </div>
                <div className="h-[140px] sm:h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={historyChartData} margin={{ top: 4, right: 8, bottom: 0, left: -22 }}>
                      <defs>
                        <linearGradient id="attRatio" x1="0" x2="0" y1="0" y2="1">
                          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.55} />
                          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tickFormatter={(d) => fmtShortDate(d, lang)}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        domain={[0, 100]}
                        ticks={[0, 50, 100]}
                        axisLine={false}
                        tickLine={false}
                        width={32}
                      />
                      <RTooltip
                        formatter={(v) => [`${v}%`, t('history.attendance')]}
                        labelFormatter={(d) => fmtShortDate(d, lang)}
                      />
                      <Area
                        type="monotone"
                        dataKey="ratio"
                        stroke="var(--color-accent)"
                        strokeWidth={2}
                        fill="url(#attRatio)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* History list */}
            <div>
              <div className="text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] mb-2 px-1">
                {t('history.details', { count: studentHistory.length })}
              </div>
              <div className="surface-flat rounded-xl overflow-hidden max-h-72 overflow-y-auto">
                <ul className="divide-y divide-[color:var(--color-border)]">
                  {studentHistory.map((record, idx) => (
                    <li
                      key={idx}
                      className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-3"
                    >
                      <span
                        className={cn(
                          'inline-block size-2 rounded-full shrink-0',
                          record.status === 'present'
                            ? 'bg-[color:var(--color-success)]'
                            : 'bg-[color:var(--color-danger)]'
                        )}
                        aria-hidden
                      />
                      <span className="text-[11px] sm:text-xs tabular text-[color:var(--color-fg-muted)] w-14 sm:w-20 shrink-0">
                        {fmtShortDate(record.date, lang)}
                      </span>
                      <span className="text-xs sm:text-sm truncate flex-1 min-w-0">{pname(record)}</span>
                      {record.status === 'present' ? (
                        <Badge tone="success" className="shrink-0">{t('common:status.present')}</Badge>
                      ) : (
                        <Badge tone="danger" className="shrink-0">{t('common:status.absent')}</Badge>
                      )}
                      {record.status === 'absent' && record.justification && (
                        <Badge
                          tone={
                            record.justification === 'justificada' ? 'success' : 'warn'
                          }
                          className="hidden sm:inline-flex shrink-0"
                        >
                          {record.justification === 'justificada'
                            ? t('grouped.justifiedShort')
                            : t('grouped.unjustifiedShort')}
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
      </Modal>

      </>
      )}
    </AppShell>
  );
}

export default ProfesorDashboard;
