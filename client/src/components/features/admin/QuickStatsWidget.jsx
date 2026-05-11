import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Users, CheckCircle2, XCircle, Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getCurrentRotationStudents, getAttendanceByProjectAndDate } from '../../../api/client';
import { getTodayDate } from '../../../utils/dateUtils';
import StatCard from '../../ui/StatCard';
import Skeleton from '../../ui/Skeleton';

/**
 * Four hero stat tiles for the leader's "Inicio" tab. Wraps the new <StatCard>
 * primitive so each tile gets the consistent gradient halo + tabular numerals.
 */
function QuickStatsWidget({ projectId }) {
  const { t } = useTranslation(['leader', 'common']);
  const [stats, setStats] = useState({
    totalStudents: 0,
    todayPresent: 0,
    todayAbsent: 0,
    attendanceRate: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (projectId) fetchQuickStats();
  }, [projectId]);

  const fetchQuickStats = async () => {
    setLoading(true);
    try {
      const todayDate = getTodayDate();
      const [studentsData, attendanceData] = await Promise.all([
        getCurrentRotationStudents(projectId),
        getAttendanceByProjectAndDate(projectId, todayDate),
      ]);

      const totalStudents = studentsData.students?.length || 0;
      const present = attendanceData.filter((a) => a.status === 'present').length;
      const absent = attendanceData.filter((a) => a.status === 'absent').length;
      const rate = totalStudents > 0 ? +((present / totalStudents) * 100).toFixed(1) : 0;

      setStats({ totalStudents, todayPresent: present, todayAbsent: absent, attendanceRate: rate });
    } catch (error) {
      console.error('Error fetching quick stats:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[112px] rounded-2xl" />
        ))}
      </div>
    );
  }

  const rateTone =
    stats.attendanceRate >= 80 ? 'success' : stats.attendanceRate >= 50 ? 'warn' : 'danger';

  const tiles = [
    {
      label: t('quickStats.students'),
      value: stats.totalStudents,
      hint: t('quickStats.studentsHint'),
      icon: Users,
      tone: 'default',
    },
    {
      label: t('quickStats.presentToday'),
      value: stats.todayPresent,
      hint:
        stats.totalStudents > 0
          ? t('quickStats.ofTotal', { n: stats.totalStudents })
          : t('quickStats.noRecords'),
      icon: CheckCircle2,
      tone: 'success',
    },
    {
      label: t('quickStats.absentToday'),
      value: stats.todayAbsent,
      hint:
        stats.totalStudents > 0
          ? t('quickStats.ofTotal', { n: stats.totalStudents })
          : t('quickStats.noRecords'),
      icon: XCircle,
      tone: stats.todayAbsent > 0 ? 'danger' : 'default',
    },
    {
      label: t('quickStats.attendanceRate'),
      value: stats.attendanceRate,
      unit: '%',
      hint: t('quickStats.today'),
      icon: Activity,
      tone: rateTone,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {tiles.map((tile, i) => (
        <motion.div
          key={tile.label}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: i * 0.05, ease: [0.25, 1, 0.5, 1] }}
        >
          <StatCard {...tile} />
        </motion.div>
      ))}
    </div>
  );
}

export default QuickStatsWidget;
