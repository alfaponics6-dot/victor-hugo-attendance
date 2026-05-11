import { lazy, Suspense, useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { LayoutDashboard, Users, BarChart3, LogOut, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../context/useAuth.js';
import AppShell from '../components/ui/AppShell';
import Tabs from '../components/ui/Tabs';
import Button from '../components/ui/Button';
import LanguageSwitcher from '../components/ui/LanguageSwitcher';
import Loading from '../components/common/Loading';

const Statistics = lazy(() => import('./Statistics'));
const AdminStudents = lazy(() => import('../components/features/admin/AdminStudents'));
const AdminOverview = lazy(() => import('../components/features/admin/AdminOverview'));

/**
 * Admin landing page. Hosts the three admin tabs (overview / students /
 * statistics) inside the shared <AppShell> chrome and a pill-style <Tabs>
 * switcher with a sliding indicator.
 */
function AdminDashboard() {
  const [activeTab, setActiveTab] = useState('home');
  const { leader, logout } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation(['admin', 'common']);

  // localStorage fallback handles a brief race where the auth context hasn't
  // hydrated yet but the persisted user is already an admin.
  if (!leader || leader.role !== 'admin') {
    const storedLeader = localStorage.getItem('auth_user') || localStorage.getItem('leader');
    let parsedRole = null;
    if (storedLeader) {
      try {
        parsedRole = JSON.parse(storedLeader).role;
      } catch { /* malformed cache - fall through to redirect */ }
    }
    if (parsedRole === 'admin') {
      return (
        <AppShell>
          <div className="flex items-center justify-center py-32 text-sm text-[color:var(--color-fg-muted)]">
            {t('dashboard.loading')}
          </div>
        </AppShell>
      );
    }
    return <Navigate to="/" replace />;
  }

  const TABS = [
    { key: 'home', label: t('dashboard.tabs.home'), icon: LayoutDashboard },
    { key: 'students', label: t('dashboard.tabs.students'), icon: Users },
    { key: 'stats', label: t('dashboard.tabs.stats'), icon: BarChart3 },
  ];

  return (
    <AppShell>
      {/* Custom header - replaces <PageHeader> so we can inline the EARTH logo
          beside the title block. Keeps the same eyebrow/title/subtitle rhythm. */}
      <header className="flex flex-col gap-4 mb-6 sm:mb-8 sm:flex-row sm:items-start sm:justify-between lg:items-end">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <img
            src="/Logo-Universidad-EARTH_academico-300x257.png"
            alt="EARTH"
            className="h-9 sm:h-11 w-auto opacity-90 select-none brightness-0 invert shrink-0"
            draggable={false}
          />
          <div className="space-y-1 min-w-0">
            <div className="text-[10px] sm:text-[11px] font-medium uppercase tracking-[0.16em] text-[color:var(--color-fg-subtle)]">
              {t('dashboard.eyebrow')}
            </div>
            <h1 className="text-2xl sm:text-[1.65rem] font-semibold tracking-tight leading-tight">
              {t('dashboard.title')} <span className="gradient-text">{t('dashboard.titleAccent')}</span>
            </h1>
            <div className="inline-flex items-center gap-1.5 text-xs sm:text-sm text-[color:var(--color-fg-muted)] truncate max-w-full">
              <ShieldCheck className="size-3.5 text-[color:var(--color-accent)] shrink-0" />
              <span className="truncate">{leader.name}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <LanguageSwitcher align="left" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => { logout(); navigate('/'); }}
            className="h-11 sm:h-8 px-3"
            aria-label={t('dashboard.logoutAria')}
          >
            <LogOut className="size-4" />
            <span className="hidden sm:inline">{t('common:actions.logout')}</span>
          </Button>
        </div>
      </header>

      <div className="mb-5 sm:mb-6">
        <Tabs tabs={TABS} value={activeTab} onChange={setActiveTab} />
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
        >
          <Suspense fallback={<Loading />}>
            {activeTab === 'home' && <AdminOverview />}
            {activeTab === 'students' && <AdminStudents />}
            {activeTab === 'stats' && <Statistics isAdmin={true} />}
          </Suspense>
        </motion.div>
      </AnimatePresence>
    </AppShell>
  );
}

export default AdminDashboard;
