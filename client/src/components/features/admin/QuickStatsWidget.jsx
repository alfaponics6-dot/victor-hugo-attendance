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
    noRotation: false,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const todayDate = getTodayDate();

        // Fetch independently. Previously these were wrapped in Promise.all,
        // which meant a 404 from getCurrentRotationStudents (legitimately
        // returned when no rotation is active) rejected the whole batch and
        // we ended up showing four zeroed tiles with hint "Current rotation"
        // — actively misleading. Now: roster failure → noRotation flag,
        // attendance still loads (today's marked rows are still meaningful
        // for a between-rotations day).
        const rosterPromise = getCurrentRotationStudents(projectId).catch((err) => {
          if (err?.response?.status === 404) return { _noRotation: true, students: [] };
          throw err;
        });
        const attendancePromise = getAttendanceByProjectAndDate(projectId, todayDate)
          .catch(() => []);

        const [studentsData, attendanceData] = await Promise.all([
          rosterPromise,
          attendancePromise,
        ]);

        if (cancelled) return;

        const noRotation = studentsData?._noRotation === true;
        const totalStudents = studentsData?.students?.length || 0;
        const rows = Array.isArray(attendanceData) ? attendanceData : [];
        const present = rows.filter((a) => a.status === 'present').length;
        const absent = rows.filter((a) => a.status === 'absent').length;
        const rate = totalStudents > 0 ? +((present / totalStudents) * 100).toFixed(1) : 0;

        setStats({
          totalStudents,
          todayPresent: present,
          todayAbsent: absent,
          attendanceRate: rate,
          noRotation,
        });
      } catch (error) {
        console.error('Error fetching quick stats:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

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

  // When the project has no active rotation, the API returns 404 and the
  // tiles below would otherwise show "0 students · Current rotation" which
  // reads as a data bug. Swap in the existing "noRecords" hint so the user
  // understands the zeros aren't a stale render but the system's actual
  // state. The "—" value avoids implying the roster is empty (it isn't —
  // there just isn't a current rotation to pull from).
  const tiles = [
    {
      label: t('quickStats.students'),
      value: stats.noRotation ? '—' : stats.totalStudents,
      hint: stats.noRotation ? t('quickStats.noRecords') : t('quickStats.studentsHint'),
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
      // With no active rotation the rate would always be 0 (no denominator),
      // which would light up the "danger" tone. Show "—" + neutral tone
      // instead so an admin doesn't mistake "between rotations" for a 0%
      // attendance crisis.
      value: stats.noRotation ? '—' : stats.attendanceRate,
      unit: stats.noRotation ? undefined : '%',
      hint: t('quickStats.today'),
      icon: Activity,
      tone: stats.noRotation ? 'default' : rateTone,
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
