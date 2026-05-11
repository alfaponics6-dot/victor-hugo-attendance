import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Calendar, CheckCircle2, XCircle, BarChart3, History, User } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from 'recharts';
import { useTranslation } from 'react-i18next';
import { getStudentAttendanceHistory } from '../../../api/client';
import Modal from '../../ui/Modal';
import Badge from '../../ui/Badge';
import Skeleton from '../../ui/Skeleton';
import { cn } from '../../../lib/cn';
import { getProjectLabel } from '../../../lib/projectI18n';

/**
 * Per-student attendance history. Stat row at the top, a small monthly bar
 * chart for shape, then a sticky-header data table of every record.
 */
function AttendanceHistoryModal({ student, onClose }) {
  const { t, i18n } = useTranslation(['leader', 'common']);
  const { t: tProject } = useTranslation('projects');
  const pname = (r) => getProjectLabel(tProject, r);
  const [loading, setLoading] = useState(true);
  const [attendance, setAttendance] = useState([]);
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    if (student) fetchAttendanceHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student]);

  const fetchAttendanceHistory = async () => {
    setLoading(true);
    try {
      const data = await getStudentAttendanceHistory(student.id);
      setAttendance(data.attendance || []);
      setSummary(data.summary || {});
    } catch (error) {
      console.error('Error fetching attendance history:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(i18n.language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const rate = useMemo(() => {
    if (!summary || summary.total_records === 0) return 0;
    return +((summary.total_present / summary.total_records) * 100).toFixed(1);
  }, [summary]);

  const monthly = useMemo(() => {
    const buckets = {};
    attendance.forEach((r) => {
      const [y, m] = r.date.split('-');
      const key = `${y}-${m}`;
      if (!buckets[key]) buckets[key] = { month: key, present: 0, absent: 0 };
      if (r.status === 'present') buckets[key].present += 1;
      else buckets[key].absent += 1;
    });
    return Object.values(buckets)
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((b) => ({
        ...b,
        label: new Date(`${b.month}-01T00:00:00`).toLocaleDateString(i18n.language, {
          month: 'short',
        }),
      }));
  }, [attendance, i18n.language]);

  const rateTone = rate >= 80 ? 'success' : rate >= 50 ? 'warn' : 'danger';

  return (
    <Modal
      open={!!student}
      onClose={onClose}
      size="xl"
      title={
        <span className="flex items-center gap-2">
          <History className="size-4 text-[color:var(--color-accent)]" />
          {t('history.title')}
        </span>
      }
      description={
        <span className="flex items-center gap-2 text-[color:var(--color-fg-muted)]">
          <User className="size-3.5" />
          {student?.name}
          {student?.student_id && (
            <Badge tone="outline" className="ml-1">{student.student_id}</Badge>
          )}
        </span>
      }
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : (
        <div className="space-y-4 sm:space-y-5">
          {/* Summary tiles */}
          {summary && summary.total_records > 0 && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
              <SummaryTile icon={Calendar} label={t('history.summary.records')} value={summary.total_records} />
              <SummaryTile
                icon={CheckCircle2}
                label={t('history.summary.present')}
                value={summary.total_present}
                tone="success"
              />
              <SummaryTile
                icon={XCircle}
                label={t('history.summary.absent')}
                value={summary.total_absent}
                tone="danger"
              />
              <SummaryTile
                icon={BarChart3}
                label={t('history.summary.rate')}
                value={`${rate}%`}
                tone={rateTone}
              />
            </div>
          )}

          {/* Monthly trend chart */}
          {monthly.length > 0 && (
            <div className="rounded-xl bg-[color:var(--color-bg-2)] hairline px-3 sm:px-4 pt-3 sm:pt-4 pb-2">
              <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)]">
                  {t('history.monthlyTrend')}
                </span>
                <div className="flex items-center gap-2 sm:gap-3 text-[11px] text-[color:var(--color-fg-muted)]">
                  <LegendDot color="var(--color-success)" label={t('history.legend.present')} />
                  <LegendDot color="var(--color-danger)" label={t('history.legend.absent')} />
                </div>
              </div>
              <div className="h-32 sm:h-36 -mx-1 sm:mx-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthly} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="label"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 10 }}
                    />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip cursor={{ fill: 'color-mix(in oklch, var(--color-accent) 8%, transparent)' }} />
                    <Bar dataKey="present" stackId="a" fill="var(--color-success)" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="absent" stackId="a" fill="var(--color-danger)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Records list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[13px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)]">
                {t('history.detailedRecords')}
              </h3>
              <span className="text-[11px] text-[color:var(--color-fg-subtle)] tabular">
                {t('history.totalLabel', { count: attendance.length })}
              </span>
            </div>
            {attendance.length === 0 ? (
              <p className="text-sm text-[color:var(--color-fg-muted)] text-center py-8">
                {t('history.noRecords')}
              </p>
            ) : (
              <>
                {/* Phone: card list */}
                <ul className="sm:hidden max-h-[55vh] overflow-y-auto space-y-1.5">
                  <AnimatePresence initial={false}>
                    {attendance.map((r, i) => (
                      <motion.li
                        key={`${r.date}-${i}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.2, delay: Math.min(i * 0.01, 0.3) }}
                        className="rounded-xl bg-[color:var(--color-bg-2)] hairline px-3 py-2.5"
                      >
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-sm font-medium tabular">
                            {formatDate(r.date)}
                          </span>
                          <Badge tone={r.status === 'present' ? 'success' : 'danger'}>
                            {r.status === 'present' ? t('common:status.present') : t('common:status.absent')}
                          </Badge>
                        </div>
                        <div className="text-[11px] text-[color:var(--color-fg-muted)] truncate">
                          <span className="tabular text-[color:var(--color-fg-subtle)] mr-1">
                            #{r.project_number}
                          </span>
                          {pname(r)}
                        </div>
                        {r.leader_name && (
                          <div className="text-[11px] text-[color:var(--color-fg-subtle)] truncate">
                            {t('history.leaderPrefix', { name: r.leader_name })}
                          </div>
                        )}
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>

                {/* Tablet+: table */}
                <div className="hidden sm:block rounded-xl hairline overflow-hidden bg-[color:var(--color-bg-2)]">
                  <div className="max-h-[360px] overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-[color:var(--color-surface)] backdrop-blur-md z-10">
                        <tr className="text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)]">
                          <th className="text-left font-medium px-4 py-2.5">{t('history.table.date')}</th>
                          <th className="text-left font-medium px-4 py-2.5">{t('history.table.project')}</th>
                          <th className="text-left font-medium px-4 py-2.5">{t('history.table.leader')}</th>
                          <th className="text-right font-medium px-4 py-2.5">{t('history.table.status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <AnimatePresence initial={false}>
                          {attendance.map((r, i) => (
                            <motion.tr
                              key={`${r.date}-${i}`}
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              transition={{ duration: 0.2, delay: Math.min(i * 0.01, 0.3) }}
                              className={cn(
                                'border-t border-[color:var(--color-border)] transition-colors hover:bg-[color:var(--color-surface-hover)]',
                                i % 2 === 1 && 'bg-[color-mix(in_oklch,var(--color-bg-3)_30%,transparent)]',
                              )}
                            >
                              <td className="px-4 py-2.5 tabular text-[color:var(--color-fg)]">
                                {formatDate(r.date)}
                              </td>
                              <td className="px-4 py-2.5 text-[color:var(--color-fg-muted)]">
                                <span className="tabular text-[color:var(--color-fg-subtle)] mr-1">
                                  #{r.project_number}
                                </span>
                                {pname(r)}
                              </td>
                              <td className="px-4 py-2.5 text-[color:var(--color-fg-muted)]">
                                {r.leader_name || '-'}
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                <Badge tone={r.status === 'present' ? 'success' : 'danger'}>
                                  {r.status === 'present' ? t('common:status.present') : t('common:status.absent')}
                                </Badge>
                              </td>
                            </motion.tr>
                          ))}
                        </AnimatePresence>
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function SummaryTile({ icon: Icon, label, value, tone = 'default' }) {
  const color = {
    default: 'var(--color-fg)',
    success: 'var(--color-success)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  }[tone];
  const bg = {
    default: 'color-mix(in oklch, var(--color-fg-muted) 15%, transparent)',
    success: 'color-mix(in oklch, var(--color-success) 18%, transparent)',
    warn: 'color-mix(in oklch, var(--color-warn) 22%, transparent)',
    danger: 'color-mix(in oklch, var(--color-danger) 18%, transparent)',
  }[tone];
  return (
    <div className="rounded-xl bg-[color:var(--color-bg-2)] hairline px-3 sm:px-4 py-2.5 sm:py-3">
      <div className="flex items-center gap-2 mb-1">
        <span
          className="size-6 grid place-items-center rounded-md shrink-0"
          style={{ background: bg, color }}
        >
          <Icon className="size-3" />
        </span>
        <span className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] truncate">
          {label}
        </span>
      </div>
      <div className="text-xl sm:text-2xl font-semibold tabular tracking-tight" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

export default AttendanceHistoryModal;
