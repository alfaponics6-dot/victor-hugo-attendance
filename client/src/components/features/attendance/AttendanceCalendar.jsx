import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, ChevronRight, CheckCircle2, XCircle, Calendar as CalendarIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getCurrentRotationStudents, getAttendanceByProjectAndDate } from '../../../api/client';
import { formatDateToYYYYMMDD, formatDateForDisplay } from '../../../utils/dateUtils';
import Card from '../../ui/Card';
import Badge from '../../ui/Badge';
import Modal from '../../ui/Modal';
import Skeleton from '../../ui/Skeleton';
import Spinner from '../../ui/Spinner';
import { cn } from '../../../lib/cn';

/**
 * Month-grid calendar of attendance density. Only Wednesdays/Saturdays are
 * tappable (the project's session days); other days are visually receded.
 * Clicking a tracked day opens a glass modal with the per-student breakdown.
 */
function AttendanceCalendar({ projectId, onDateSelect }) {
  const { t, i18n } = useTranslation(['leader', 'common']);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [attendanceData, setAttendanceData] = useState({});
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedDateData, setSelectedDateData] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [modalLoading, setModalLoading] = useState(false);

  useEffect(() => {
    if (projectId) {
      fetchStudents();
      fetchMonthAttendance();
    }
  }, [projectId, currentDate]);

  const fetchStudents = async () => {
    try {
      const data = await getCurrentRotationStudents(projectId);
      setStudents(data.students || []);
    } catch (error) {
      console.error('Error fetching students:', error);
    }
  };

  const fetchMonthAttendance = async () => {
    setLoading(true);
    try {
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth();
      const daysInMonth = new Date(year, month + 1, 0).getDate();

      const promises = [];
      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        const dateStr = formatDateToYYYYMMDD(date);
        promises.push(
          getAttendanceByProjectAndDate(projectId, dateStr)
            .then((data) => ({ date: dateStr, data }))
            .catch(() => ({ date: dateStr, data: [] })),
        );
      }

      const results = await Promise.all(promises);
      const dataMap = {};
      results.forEach(({ date, data }) => {
        dataMap[date] = {
          present: data.filter((a) => a.status === 'present').length,
          absent: data.filter((a) => a.status === 'absent').length,
          total: data.length,
        };
      });
      setAttendanceData(dataMap);
    } catch (error) {
      console.error('Error fetching month attendance:', error);
    } finally {
      setLoading(false);
    }
  };

  const days = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startingDayOfWeek = firstDay.getDay();
    const arr = [];
    for (let i = 0; i < startingDayOfWeek; i++) arr.push(null);
    for (let day = 1; day <= lastDay.getDate(); day++) arr.push(new Date(year, month, day));
    return arr;
  }, [currentDate]);

  const formatMonthYear = () =>
    currentDate.toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' });

  const isToday = (date) => {
    if (!date) return false;
    const t = new Date();
    return (
      date.getDate() === t.getDate() &&
      date.getMonth() === t.getMonth() &&
      date.getFullYear() === t.getFullYear()
    );
  };

  const isAttendanceDay = (date) => {
    if (!date) return false;
    const dow = date.getDay();
    return dow === 3 || dow === 6;
  };

  const getRate = (date) => {
    if (!date) return null;
    const data = attendanceData[formatDateToYYYYMMDD(date)];
    if (!data || data.total === 0) return null;
    return (data.present / Math.max(students.length || data.total, 1)) * 100;
  };

  const handleDateClick = async (date) => {
    if (!date || !isAttendanceDay(date)) return;
    const dateStr = formatDateToYYYYMMDD(date);
    setSelectedDate(dateStr);
    setShowModal(true);
    setModalLoading(true);
    try {
      const data = await getAttendanceByProjectAndDate(projectId, dateStr);
      setSelectedDateData(data);
    } catch {
      setSelectedDateData([]);
    } finally {
      setModalLoading(false);
    }
    onDateSelect?.(dateStr);
  };

  const closeModal = () => {
    setShowModal(false);
    setSelectedDate(null);
    setSelectedDateData([]);
  };

  const weekDays = [
    { full: t('calendar.weekdays.sunFull'), short: t('calendar.weekdays.sunShort') },
    { full: t('calendar.weekdays.monFull'), short: t('calendar.weekdays.monShort') },
    { full: t('calendar.weekdays.tueFull'), short: t('calendar.weekdays.tueShort') },
    { full: t('calendar.weekdays.wedFull'), short: t('calendar.weekdays.wedShort') },
    { full: t('calendar.weekdays.thuFull'), short: t('calendar.weekdays.thuShort') },
    { full: t('calendar.weekdays.friFull'), short: t('calendar.weekdays.friShort') },
    { full: t('calendar.weekdays.satFull'), short: t('calendar.weekdays.satShort') },
  ];

  return (
    <Card className="p-0 overflow-hidden h-full">
      <header className="flex items-center justify-between gap-3 px-4 sm:px-5 pt-4 sm:pt-5 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="size-8 grid place-items-center rounded-xl bg-[color-mix(in_oklch,var(--color-accent)_18%,transparent)] text-[color:var(--color-accent)] shrink-0">
            <CalendarIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight capitalize truncate">{formatMonthYear()}</h3>
            <p className="text-[11px] text-[color:var(--color-fg-subtle)] hidden sm:block">
              {t('calendar.subtitle')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() =>
              setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1))
            }
            aria-label={t('calendar.prevMonth')}
            className="size-8 grid place-items-center rounded-lg text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            onClick={() =>
              setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1))
            }
            aria-label={t('calendar.nextMonth')}
            className="size-8 grid place-items-center rounded-lg text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </header>

      <div className="px-3 sm:px-5 pb-4">
        <div className="grid grid-cols-7 gap-1 mb-2">
          {weekDays.map((d) => (
            <div
              key={d.full}
              className="text-center text-[10px] font-medium tracking-[0.12em] uppercase text-[color:var(--color-fg-subtle)] py-1.5"
            >
              <span className="sm:hidden">{d.short}</span>
              <span className="hidden sm:inline">{d.full}</span>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1 relative">
          {loading && (
            <div className="absolute inset-0 grid place-items-center bg-[color-mix(in_oklch,var(--color-bg)_60%,transparent)] rounded-xl backdrop-blur-sm z-10">
              <Spinner size="md" className="text-[color:var(--color-accent)]" />
            </div>
          )}
          {days.map((date, i) => {
            const isValid = date && isAttendanceDay(date);
            const rate = getRate(date);
            const today = isToday(date);
            return (
              <DayCell
                key={i}
                date={date}
                isValid={isValid}
                rate={rate}
                today={today}
                data={date ? attendanceData[formatDateToYYYYMMDD(date)] : null}
                onClick={() => handleDateClick(date)}
              />
            );
          })}
        </div>
      </div>

      <footer className="border-t border-[color:var(--color-border)] px-4 sm:px-5 py-3 flex flex-wrap items-center gap-x-3 sm:gap-x-4 gap-y-1.5 text-[11px] text-[color:var(--color-fg-subtle)]">
        <LegendDot color="var(--color-success)" label="≥ 80%" />
        <LegendDot color="var(--color-warn)" label="50–79%" />
        <LegendDot color="var(--color-danger)" label="< 50%" />
        <span className="sm:ml-auto text-[10px] uppercase tracking-wide">
          {t('calendar.sessionDaysNote')}
        </span>
      </footer>

      <Modal
        open={showModal}
        onClose={closeModal}
        size="lg"
        title={t('calendar.modalTitle', {
          date: selectedDate ? formatDateForDisplay(selectedDate, i18n.language) : '',
        })}
        description={t('calendar.modalDescription')}
      >
        {modalLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        ) : selectedDateData.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm font-medium">{t('calendar.noRecordsTitle')}</p>
            <p className="text-xs text-[color:var(--color-fg-subtle)] mt-1">
              {t('calendar.noRecordsHint')}
            </p>
          </div>
        ) : (
          <ModalBody data={selectedDateData} />
        )}
      </Modal>
    </Card>
  );
}

function DayCell({ date, isValid, rate, today, data, onClick }) {
  if (!date) return <div aria-hidden className="aspect-square" />;

  const tone =
    rate == null
      ? null
      : rate >= 80
        ? 'success'
        : rate >= 50
          ? 'warn'
          : 'danger';
  const accent =
    tone === 'success'
      ? 'var(--color-success)'
      : tone === 'warn'
        ? 'var(--color-warn)'
        : tone === 'danger'
          ? 'var(--color-danger)'
          : 'var(--color-fg-subtle)';

  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={isValid ? { y: -2 } : {}}
      whileTap={isValid ? { scale: 0.97 } : {}}
      disabled={!isValid}
      className={cn(
        'relative aspect-square rounded-lg sm:rounded-xl flex flex-col items-center justify-center gap-0.5 text-[10px] sm:text-[12px] font-medium transition-colors',
        isValid
          ? 'bg-[color:var(--color-bg-2)] hairline hover:border-[color:var(--color-border-strong)] cursor-pointer'
          : 'text-[color:var(--color-fg-subtle)] opacity-45',
        today && 'ring-1 ring-[color:var(--color-accent)]/60',
      )}
    >
      <span className={cn('tabular', today && 'text-[color:var(--color-accent)]')}>
        {date.getDate()}
      </span>
      {tone && data?.total > 0 && (
        <span
          aria-hidden
          className="size-1 sm:size-1.5 rounded-full"
          style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
        />
      )}
      {data?.total > 0 && (
        <span className="absolute bottom-0.5 right-1 sm:bottom-1 sm:right-1.5 text-[8px] sm:text-[9px] tabular text-[color:var(--color-fg-subtle)]">
          {data.present}/{data.total}
        </span>
      )}
    </motion.button>
  );
}

function LegendDot({ color, label }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="size-2 rounded-full"
        style={{ background: color, boxShadow: `0 0 8px ${color}` }}
      />
      <span>{label}</span>
    </div>
  );
}

function ModalBody({ data }) {
  const { t } = useTranslation(['leader', 'common']);
  const present = data.filter((s) => s.status === 'present').length;
  const absJust = data.filter((s) => s.status === 'absent' && s.justification === 'justificada').length;
  const absUnj = data.filter((s) => s.status === 'absent' && s.justification === 'injustificada').length;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 sm:mb-5">
        <SummaryTile label={t('calendar.summary.total')} value={data.length} />
        <SummaryTile label={t('calendar.summary.present')} value={present} tone="success" />
        <SummaryTile label={t('calendar.summary.justified')} value={absJust} tone="warn" />
        <SummaryTile label={t('calendar.summary.unjustified')} value={absUnj} tone="danger" />
      </div>

      <ul className="max-h-[60vh] sm:max-h-[420px] overflow-y-auto space-y-1.5 pr-0 sm:pr-1">
        <AnimatePresence initial={false}>
          {data.map((r, i) => (
            <motion.li
              key={r.student_id || i}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: i * 0.02 }}
              className="flex items-start sm:items-center gap-2.5 sm:gap-3 px-2.5 sm:px-3 py-2.5 rounded-xl bg-[color:var(--color-bg-2)] hairline"
            >
              {r.status === 'present' ? (
                <CheckCircle2 className="size-4 text-[color:var(--color-success)] shrink-0 mt-0.5 sm:mt-0" />
              ) : (
                <XCircle className="size-4 text-[color:var(--color-danger)] shrink-0 mt-0.5 sm:mt-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{r.student_name}</div>
                {r.observation && (
                  <div className="text-[11px] text-[color:var(--color-fg-subtle)] mt-0.5 line-clamp-2 sm:truncate">
                    {r.observation}
                  </div>
                )}
                <div className="flex items-center gap-1.5 flex-wrap mt-1.5 sm:hidden">
                  {r.student_id && <Badge tone="outline">{r.student_id}</Badge>}
                  <Badge tone={r.status === 'present' ? 'success' : 'danger'}>
                    {r.status === 'present' ? t('common:status.present') : t('common:status.absent')}
                  </Badge>
                  {r.status === 'absent' && r.justification && (
                    <Badge tone={r.justification === 'justificada' ? 'warn' : 'danger'}>
                      {r.justification === 'justificada'
                        ? t('calendar.rowBadge.justifiedShort')
                        : t('calendar.rowBadge.unjustifiedShort')}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="hidden sm:flex items-center gap-1.5 shrink-0">
                {r.student_id && <Badge tone="outline">{r.student_id}</Badge>}
                <Badge tone={r.status === 'present' ? 'success' : 'danger'}>
                  {r.status === 'present' ? t('common:status.present') : t('common:status.absent')}
                </Badge>
                {r.status === 'absent' && r.justification && (
                  <Badge tone={r.justification === 'justificada' ? 'warn' : 'danger'}>
                    {r.justification === 'justificada'
                      ? t('calendar.rowBadge.justifiedShort')
                      : t('calendar.rowBadge.unjustifiedShort')}
                  </Badge>
                )}
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </>
  );
}

function SummaryTile({ label, value, tone = 'default' }) {
  const color = {
    default: 'var(--color-fg)',
    success: 'var(--color-success)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  }[tone];
  return (
    <div className="rounded-xl bg-[color:var(--color-bg-2)] hairline px-2.5 sm:px-3 py-2 sm:py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] truncate">
        {label}
      </div>
      <div className="text-lg sm:text-xl font-semibold tabular tracking-tight" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

export default AttendanceCalendar;
