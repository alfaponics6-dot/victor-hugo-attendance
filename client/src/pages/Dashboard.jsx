import { lazy, Suspense, useState, useEffect, useMemo } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { LayoutDashboard, ClipboardCheck, Users, BarChart3, LogOut, TrendingUp, Mail } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from 'recharts';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/useAuth.js';
import Loading from '../components/common/Loading';
import AlertsWidget from '../components/features/admin/AlertsWidget';
import { getProjectLabel } from '../lib/projectI18n';

const StudentManagement = lazy(() => import('./StudentManagement'));
const Attendance = lazy(() => import('./Attendance'));
const Statistics = lazy(() => import('./Statistics'));
const MailRotation = lazy(() => import('../components/features/leader/MailRotation'));
import QuickStatsWidget from '../components/features/admin/QuickStatsWidget';
import AttendanceCalendar from '../components/features/attendance/AttendanceCalendar';
import AppShell, { PageHeader, SectionTitle } from '../components/ui/AppShell';
import Tabs from '../components/ui/Tabs';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Skeleton from '../components/ui/Skeleton';
import Badge from '../components/ui/Badge';
import LanguageSwitcher from '../components/ui/LanguageSwitcher';
import { getAttendanceByProjectAndDate } from '../api/client';
import { formatDateToYYYYMMDD } from '../utils/dateUtils';

function Dashboard() {
  const { t } = useTranslation(['leader', 'common']);
  const { t: tProject } = useTranslation('projects');
  const [activeTab, setActiveTab] = useState('home');
  const { leader, logout } = useAuth();
  const navigate = useNavigate();

  const TABS = useMemo(
    () => [
      { key: 'home', label: t('dashboard.tabs.home'), icon: LayoutDashboard },
      { key: 'attendance', label: t('dashboard.tabs.attendance'), icon: ClipboardCheck },
      { key: 'students', label: t('dashboard.tabs.students'), icon: Users },
      { key: 'mail', label: t('dashboard.tabs.mail'), icon: Mail },
      { key: 'statistics', label: t('dashboard.tabs.statistics'), icon: BarChart3 },
    ],
    [t],
  );

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  if (!leader) {
    const stored = localStorage.getItem('auth_user') || localStorage.getItem('leader');
    if (!stored) return <Navigate to="/" replace />;
    return (
      <div className="min-h-screen grid place-items-center text-sm text-[color:var(--color-fg-muted)]">
        {t('common:actions.loading')}
      </div>
    );
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow={t('dashboard.welcome', { name: leader.name })}
        title={
          <span className="flex items-center gap-2 sm:gap-3 flex-wrap">
            <img
              src="/Logo-Universidad-EARTH_academico-300x257.png"
              alt={t('common:app.university')}
              className="h-7 sm:h-9 w-auto opacity-90 brightness-0 invert"
            />
            <span>{t('dashboard.title')}</span>
          </span>
        }
        subtitle={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <Badge tone="accent" className="!h-6">
              {t('dashboard.projectBadge', { number: leader.projectNumber })}
            </Badge>
            <span className="text-[color:var(--color-fg-muted)] truncate">
              {getProjectLabel(tProject, { project_number: leader.projectNumber, project_name: leader.projectName })}
            </span>
          </span>
        }
        actions={
          <>
            <LanguageSwitcher align="left" />
            <Button
              variant="ghost"
              onClick={handleLogout}
              className="gap-2"
              aria-label={t('common:actions.logout')}
            >
              <LogOut className="size-4" />
              <span className="hidden sm:inline">{t('common:actions.logout')}</span>
            </Button>
          </>
        }
      />

      <div className="mb-5 sm:mb-6">
        <Tabs tabs={TABS} value={activeTab} onChange={setActiveTab} />
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
        >
          <Suspense fallback={<Loading />}>
            {activeTab === 'home' && <HomeTab leader={leader} onSwitchToAttendance={() => setActiveTab('attendance')} />}
            {activeTab === 'attendance' && <Attendance />}
            {activeTab === 'students' && <StudentManagement />}
            {activeTab === 'mail' && <MailRotation />}
            {activeTab === 'statistics' && <Statistics />}
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </AppShell>
  );
}

function HomeTab({ leader, onSwitchToAttendance }) {
  const { t } = useTranslation(['leader', 'common']);
  return (
    <div className="space-y-5 sm:space-y-6">
      <section>
        <SectionTitle>{t('dashboard.summary')}</SectionTitle>
        <QuickStatsWidget projectId={leader.projectId} />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5">
        <div className="lg:col-span-2 space-y-4 sm:space-y-5 min-w-0">
          <TrendCard projectId={leader.projectId} />
          <AlertsWidget projectId={leader.projectId} />
        </div>
        <div className="lg:col-span-1 min-w-0">
          <AttendanceCalendar projectId={leader.projectId} onDateSelect={onSwitchToAttendance} />
        </div>
      </section>
    </div>
  );
}

function TrendCard({ projectId }) {
  const { t, i18n } = useTranslation(['leader', 'common']);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const today = new Date();
        const days = [];
        for (let i = 13; i >= 0; i--) {
          const d = new Date(today);
          d.setDate(today.getDate() - i);
          days.push(d);
        }
        const results = await Promise.all(
          days.map((d) =>
            getAttendanceByProjectAndDate(projectId, formatDateToYYYYMMDD(d))
              .then((rows) => ({ date: d, rows }))
              .catch(() => ({ date: d, rows: [] })),
          ),
        );
        if (cancelled) return;

        const series = results.map(({ date, rows }) => {
          const present = rows.filter((r) => r.status === 'present').length;
          const total = rows.length;
          const rate = total > 0 ? +((present / total) * 100).toFixed(1) : null;
          return {
            date,
            label: date.toLocaleDateString(i18n.language, { day: '2-digit', month: 'short' }),
            present,
            total,
            rate,
          };
        });
        setData(series);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, i18n.language]);

  const tracked = useMemo(() => data?.filter((d) => d.total > 0) ?? [], [data]);
  const avg = useMemo(() => {
    if (!tracked.length) return null;
    const sum = tracked.reduce((acc, d) => acc + d.rate, 0);
    return +(sum / tracked.length).toFixed(1);
  }, [tracked]);

  return (
    <Card className="p-0 overflow-hidden">
      <header className="flex items-start sm:items-center justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="size-8 grid place-items-center rounded-xl bg-[color-mix(in_oklch,var(--color-accent)_18%,transparent)] text-[color:var(--color-accent)] shrink-0">
            <TrendingUp className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight">{t('dashboard.trend.title')}</h3>
            <p className="text-[11px] text-[color:var(--color-fg-subtle)] line-clamp-2">
              {t('dashboard.trend.subtitle')}
            </p>
          </div>
        </div>
        {avg != null && (
          <div className="text-right shrink-0">
            <div className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)]">
              {t('dashboard.trend.average')}
            </div>
            <div className="text-lg sm:text-xl font-semibold tabular tracking-tight gradient-text">
              {avg}%
            </div>
          </div>
        )}
      </header>

      <div className="px-1 sm:px-2 pb-3">
        {loading ? (
          <div className="px-3 pb-2">
            <Skeleton className="h-40 sm:h-44 rounded-xl" />
          </div>
        ) : !tracked.length ? (
          <div className="px-4 sm:px-5 pb-5 pt-2 text-center">
            <p className="text-sm text-[color:var(--color-fg-muted)]">
              {t('dashboard.trend.emptyTitle')}
            </p>
            <p className="text-xs text-[color:var(--color-fg-subtle)] mt-1">
              {t('dashboard.trend.emptySubtitle')}
            </p>
          </div>
        ) : (
          <div className="h-40 sm:h-44">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="rateFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 10 }} />
                <YAxis
                  domain={[0, 100]}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  formatter={(v) => [`${v}%`, t('dashboard.trend.rate')]}
                  labelFormatter={(l) => l}
                  cursor={{ stroke: 'var(--color-accent)', strokeWidth: 1, strokeOpacity: 0.4 }}
                />
                <Area
                  type="monotone"
                  dataKey="rate"
                  stroke="var(--color-accent)"
                  strokeWidth={2}
                  fill="url(#rateFill)"
                  connectNulls
                  dot={{ r: 2.5, stroke: 'var(--color-accent)', strokeWidth: 1.5, fill: 'var(--color-bg)' }}
                  activeDot={{ r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </Card>
  );
}

export default Dashboard;
