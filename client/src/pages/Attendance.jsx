import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  CheckCircle2,
  XCircle,
  Save,
  Calendar,
  ClipboardCheck,
  Download,
  Paperclip,
  FileText,
  Image as ImageIcon,
  X,
  Search,
  Info,
  Lock,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/useAuth.js';
import {
  getCurrentRotationStudents,
  markAttendance,
  markBulkAttendance,
  getAttendanceByProjectAndDate,
  getAttachmentUrl,
} from '../api/client';
import Loading from '../components/common/Loading';
import Message from '../components/common/Message';
import { STATUS, JUSTIFICATION } from '../lib/constants';
import RotationCalendar from '../components/features/attendance/RotationCalendar';
import { SectionTitle } from '../components/ui/AppShell';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import { Input } from '../components/ui/Input';
import { getTodayDate, getCurrentTime } from '../utils/dateUtils';
import { cn } from '../lib/cn';

function Attendance() {
  const { t } = useTranslation(['leader', 'common']);
  const { leader } = useAuth();
  const [students, setStudents] = useState([]);
  const [attendance, setAttendance] = useState({});
  const [selectedDate, setSelectedDate] = useState(getTodayDate());
  const [currentRotation, setCurrentRotation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [attachments, setAttachments] = useState({});
  const [attendanceAlreadySaved, setAttendanceAlreadySaved] = useState(false);
  const [search, setSearch] = useState('');
  const fileInputRefs = useRef({});

  useEffect(() => {
    if (leader) {
      fetchStudents();
      fetchAttendance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leader, selectedDate]);

  useEffect(() => {
    if (message.text) {
      const timer = setTimeout(() => setMessage({ type: '', text: '' }), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const fetchStudents = async () => {
    setLoading(true);
    try {
      const data = await getCurrentRotationStudents(leader.projectId);
      setStudents(data.students);
      setCurrentRotation(data.rotationNumber);
    } catch {
      setStudents([]);
      setCurrentRotation(null);
    } finally {
      setLoading(false);
    }
  };

  const fetchAttendance = async () => {
    try {
      const data = await getAttendanceByProjectAndDate(leader.projectId, selectedDate);
      const map = {};
      data.forEach((r) => {
        map[r.student_id] = {
          status: r.status,
          justification: r.justification || null,
          observation: r.observation || '',
          attachmentFileName: r.attachment_file_name,
          attachmentFilePath: r.attachment_file_path,
        };
      });
      setAttendance(map);
      setAttendanceAlreadySaved(data.length > 0);
    } catch (err) {
      console.error('Error fetching attendance:', err);
      showMessage('error', t('attendance.messages.loadPrevError'));
    }
  };

  const showMessage = (type, text) => setMessage({ type, text });

  const handleAttendanceChange = (studentId, status) => {
    setAttendance((prev) => ({
      ...prev,
      [studentId]: {
        ...prev[studentId],
        status,
        justification:
          status === STATUS.ABSENT ? prev[studentId]?.justification || JUSTIFICATION.UNJUSTIFIED : null,
        observation: prev[studentId]?.observation || '',
      },
    }));
  };

  const handleJustificationChange = (studentId, justification) => {
    setAttendance((prev) => ({
      ...prev,
      [studentId]: { ...prev[studentId], justification },
    }));
  };

  const handleObservationChange = (studentId, observation) => {
    setAttendance((prev) => ({
      ...prev,
      [studentId]: { ...prev[studentId], observation },
    }));
  };

  const handleFileSelect = (studentId, event) => {
    const file = event.target.files[0];
    if (!file) return;
    const allowedTypes = ['image/png', 'image/jpg', 'image/jpeg', 'application/pdf'];
    const allowedExtensions = ['.png', '.jpg', '.jpeg', '.pdf'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!allowedTypes.includes(file.type) || !allowedExtensions.includes(ext)) {
      showMessage('error', t('common:errors.fileType'));
      event.target.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showMessage('error', t('common:errors.fileSize'));
      event.target.value = '';
      return;
    }
    setAttachments((prev) => ({ ...prev, [studentId]: file }));
  };

  const handleRemoveFile = (studentId) => {
    setAttachments((prev) => {
      const next = { ...prev };
      delete next[studentId];
      return next;
    });
    if (fileInputRefs.current[studentId]) fileInputRefs.current[studentId].value = '';
  };

  const handleDownloadAttachment = (studentId) => {
    const url = getAttachmentUrl(studentId, selectedDate);
    window.open(url, '_blank');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (Object.keys(attendance).length === 0) {
      showMessage('error', t('attendance.messages.selectOne'));
      return;
    }

    setSaving(true);
    const currentTime = getCurrentTime();

    try {
      const studentsWithAttachments = Object.keys(attachments).filter((id) => attachments[id]);

      if (studentsWithAttachments.length === 0) {
        const records = Object.entries(attendance).map(([studentId, data]) => ({
          studentId: parseInt(studentId),
          status: data.status,
          justification: data.justification,
          observation: data.observation,
        }));

        await markBulkAttendance(leader.projectId, leader.id, selectedDate, currentTime, records);
        showMessage('success', t('attendance.messages.savedSuccess', { date: selectedDate }));
      } else {
        const noAttachmentRecords = Object.entries(attendance)
          .filter(([studentId]) => !attachments[studentId])
          .map(([studentId, data]) => ({
            studentId: parseInt(studentId),
            status: data.status,
            justification: data.justification,
            observation: data.observation,
          }));

        if (noAttachmentRecords.length > 0) {
          await markBulkAttendance(
            leader.projectId,
            leader.id,
            selectedDate,
            currentTime,
            noAttachmentRecords,
          );
        }

        const attachmentEntries = Object.entries(attendance).filter(
          ([studentId]) => attachments[studentId],
        );
        const failures = [];
        let savedCount = noAttachmentRecords.length;

        for (const [studentId, data] of attachmentEntries) {
          try {
            await markAttendance({
              studentId: parseInt(studentId),
              date: selectedDate,
              time: currentTime,
              status: data.status,
              justification: data.justification,
              observation: data.observation,
              attachment: attachments[studentId] || null,
            });
            savedCount++;
          } catch (e) {
            const studentName = students.find((s) => s.id === parseInt(studentId))?.name || studentId;
            failures.push({ studentName, error: e.response?.data?.message || e.message });
          }
        }

        if (failures.length === 0) {
          showMessage('success', t('attendance.messages.savedSuccess', { date: selectedDate }));
        } else {
          const failureNames = failures.map((f) => f.studentName).join(', ');
          showMessage(
            'error',
            t('attendance.messages.partialSave', {
              saved: savedCount,
              total: Object.keys(attendance).length,
              names: failureNames,
            }),
          );
        }
      }

      setAttachments({});
      Object.keys(fileInputRefs.current).forEach((k) => {
        if (fileInputRefs.current[k]) fileInputRefs.current[k].value = '';
      });
      await fetchAttendance();
    } catch (err) {
      if (err.response?.status === 409) {
        showMessage('error', t('attendance.messages.alreadySaved'));
        setAttendanceAlreadySaved(true);
      } else {
        showMessage('error', err.response?.data?.error || t('attendance.messages.saveError'));
      }
      console.error('Error saving attendance:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleQuickMarkAll = (status) => {
    const next = {};
    students.forEach((s) => {
      next[s.id] = {
        status,
        justification: status === STATUS.ABSENT ? JUSTIFICATION.UNJUSTIFIED : null,
        observation: attendance[s.id]?.observation || '',
      };
    });
    setAttendance(next);
  };

  const exportToCSV = () => {
    if (students.length === 0) return;
    const headers = [
      t('attendance.csv.headers.name'),
      t('attendance.csv.headers.studentId'),
      t('attendance.csv.headers.email'),
      t('attendance.csv.headers.status'),
      t('attendance.csv.headers.justification'),
      t('attendance.csv.headers.observation'),
      t('attendance.csv.headers.attachment'),
      t('attendance.csv.headers.date'),
      t('attendance.csv.headers.project'),
      t('attendance.csv.headers.leader'),
    ];
    const rows = students.map((s) => {
      const a = attendance[s.id];
      const status = a?.status;
      return [
        s.name,
        s.student_id || 'N/A',
        s.email || t('attendance.csv.noEmail'),
        status === 'present'
          ? t('common:status.present')
          : status === 'absent'
            ? t('common:status.absent')
            : t('attendance.csv.unmarked'),
        status === 'absent' && a?.justification
          ? a.justification === 'justificada'
            ? t('common:status.justified')
            : t('common:status.unjustified')
          : '-',
        a?.observation || '-',
        a?.attachmentFileName || '-',
        selectedDate,
        leader.projectName,
        leader.name,
      ];
    });
    const csv = [headers.join(','), ...rows.map((r) => r.map((c) => `"${c}"`).join(','))].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${t('attendance.csv.filenamePrefix')}_${leader.projectName}_${selectedDate}.csv`;
    link.click();
  };

  // Counts
  const counts = useMemo(() => {
    const present = Object.values(attendance).filter((a) => a?.status === 'present').length;
    const absJust = Object.values(attendance).filter(
      (a) => a?.status === 'absent' && a?.justification === 'justificada',
    ).length;
    const absUnj = Object.values(attendance).filter(
      (a) => a?.status === 'absent' && a?.justification === 'injustificada',
    ).length;
    const marked = Object.keys(attendance).length;
    return {
      present,
      absJust,
      absUnj,
      absent: absJust + absUnj,
      marked,
      total: students.length,
      remaining: students.length - marked,
    };
  }, [attendance, students]);

  // Filter
  const filteredStudents = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return students;
    return students.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.student_id && s.student_id.toLowerCase().includes(q)) ||
        (s.email && s.email.toLowerCase().includes(q)),
    );
  }, [students, search]);

  return (
    <div className="space-y-5 sm:space-y-6 pb-28 sm:pb-24">
      <RotationCalendar />

      <header className="flex flex-col gap-3 sm:gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <SectionTitle>{t('attendance.sectionTitle')}</SectionTitle>
          <h2 className="text-lg sm:text-xl font-semibold tracking-tight flex items-center gap-2 flex-wrap">
            <ClipboardCheck className="size-5 text-[color:var(--color-accent)] shrink-0" />
            <span>{t('attendance.heading')}</span>
            {currentRotation && (
              <Badge tone="accent">
                {t('attendance.rotation', { number: currentRotation })}
              </Badge>
            )}
          </h2>
        </div>

        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
          <div className="inline-flex items-center gap-2 px-3 h-11 sm:h-10 rounded-xl bg-[color:var(--color-bg-2)] hairline w-full sm:w-auto">
            <Calendar className="size-4 text-[color:var(--color-fg-muted)] shrink-0" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              max={getTodayDate()}
              className="bg-transparent outline-none text-sm font-medium tabular tracking-tight text-[color:var(--color-fg)] w-full sm:w-auto"
            />
          </div>
          <Button
            variant="outline"
            onClick={exportToCSV}
            disabled={students.length === 0}
            className="h-11 sm:h-10 w-full sm:w-auto"
          >
            <Download className="size-4" />
            {t('common:actions.exportCsv')}
          </Button>
        </div>
      </header>

      <Message
        type={message.type}
        text={message.text}
        onClose={() => setMessage({ type: '', text: '' })}
      />

      {attendanceAlreadySaved && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="surface rounded-xl px-4 py-3 flex items-center gap-3 border-l-4 border-l-[color:var(--color-accent)]/60"
        >
          <Lock className="size-4 text-[color:var(--color-accent)]" />
          <div className="text-sm">
            <span className="font-medium">{t('attendance.lockedTitle')}</span>{' '}
            <span className="text-[color:var(--color-fg-muted)]">
              {t('attendance.lockedSubtitle')}
            </span>
          </div>
        </motion.div>
      )}

      {loading ? (
        <Loading message={t('attendance.loading')} />
      ) : students.length === 0 ? (
        <Card className="text-center py-12">
          <p className="text-base font-medium">
            {currentRotation === null
              ? t('attendance.noRotation')
              : t('attendance.noStudents')}
          </p>
          <p className="text-sm text-[color:var(--color-fg-muted)] mt-2 max-w-md mx-auto">
            {currentRotation === null
              ? t('attendance.noRotationHint')
              : t('attendance.addStudentsHint')}
          </p>
        </Card>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Live count chips */}
          <div className="flex flex-wrap gap-2">
            <CountChip label={t('attendance.counts.marked')} value={`${counts.marked}/${counts.total}`} />
            <CountChip label={t('attendance.counts.present')} value={counts.present} tone="success" />
            <CountChip label={t('attendance.counts.justified')} value={counts.absJust} tone="warn" />
            <CountChip label={t('attendance.counts.unjustified')} value={counts.absUnj} tone="danger" />
            <CountChip label={t('attendance.counts.unmarked')} value={counts.remaining} tone="default" />
          </div>

          {/* Top toolbar */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--color-fg-subtle)] pointer-events-none" />
              <Input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('attendance.searchPlaceholder')}
                className="pl-9 h-11 sm:h-10"
              />
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleQuickMarkAll('present')}
                disabled={attendanceAlreadySaved}
                className="text-[color:var(--color-success)] h-10 sm:h-8"
              >
                <CheckCircle2 className="size-4" />
                <span className="sm:hidden">{t('attendance.quickMark.allPresentShort')}</span>
                <span className="hidden sm:inline">{t('attendance.quickMark.allPresent')}</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleQuickMarkAll('absent')}
                disabled={attendanceAlreadySaved}
                className="text-[color:var(--color-danger)] h-10 sm:h-8"
              >
                <XCircle className="size-4" />
                <span className="sm:hidden">{t('attendance.quickMark.allAbsentShort')}</span>
                <span className="hidden sm:inline">{t('attendance.quickMark.allAbsent')}</span>
              </Button>
            </div>
          </div>

          {/* Student list */}
          <Card className="p-0 overflow-hidden">
            <ul className="divide-y divide-[color:var(--color-border)]">
              <AnimatePresence initial={false}>
                {filteredStudents.map((student, i) => (
                  <StudentRow
                    key={student.id}
                    index={i}
                    student={student}
                    attendance={attendance[student.id]}
                    attachment={attachments[student.id]}
                    locked={attendanceAlreadySaved}
                    onStatusChange={handleAttendanceChange}
                    onJustificationChange={handleJustificationChange}
                    onObservationChange={handleObservationChange}
                    onFileSelect={handleFileSelect}
                    onRemoveFile={handleRemoveFile}
                    onDownloadAttachment={handleDownloadAttachment}
                    registerFileInput={(el) => (fileInputRefs.current[student.id] = el)}
                  />
                ))}
              </AnimatePresence>
            </ul>
            {filteredStudents.length === 0 && (
              <div className="py-10 text-center text-sm text-[color:var(--color-fg-muted)]">
                {t('attendance.noSearchResults', { query: search })}
              </div>
            )}
          </Card>

          {/* Floating sticky bottom bar */}
          <div
            className="fixed inset-x-0 bottom-0 sm:bottom-4 z-30 px-3 sm:px-4 pointer-events-none"
            style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.75rem)' }}
          >
            <motion.div
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
              className="mx-auto max-w-[1100px] surface rounded-xl sm:rounded-2xl px-3 sm:px-4 py-2.5 sm:py-3 flex items-center gap-2 sm:gap-3 glow pointer-events-auto"
            >
              <div className="flex items-center gap-2 sm:gap-3 text-sm flex-1 min-w-0">
                <span className="inline-flex items-center justify-center size-8 rounded-lg bg-[color-mix(in_oklch,var(--color-accent)_18%,transparent)] text-[color:var(--color-accent)] shrink-0">
                  <Info className="size-4" />
                </span>
                <span className="tabular text-[color:var(--color-fg-muted)] truncate text-xs sm:text-sm">
                  <span className="font-semibold text-[color:var(--color-fg)]">
                    {counts.marked}
                  </span>
                  /{counts.total} <span className="hidden sm:inline">{t('attendance.counts.markedShort')}</span>
                  <span className="sm:hidden"> {t('attendance.counts.markedTiny')}</span> ·{' '}
                  <span className="text-[color:var(--color-success)]">{counts.present}</span> {t('attendance.counts.presentShort')} ·{' '}
                  <span className="text-[color:var(--color-danger)]">{counts.absent}</span> {t('attendance.counts.absentShort')}
                </span>
              </div>
              <Button
                type="submit"
                loading={saving}
                disabled={saving || attendanceAlreadySaved || counts.marked === 0}
                className="shrink-0"
              >
                {!saving && <Save className="size-4" />}
                <span className="hidden sm:inline">
                  {saving
                    ? t('attendance.save.saving')
                    : attendanceAlreadySaved
                      ? t('attendance.save.saved')
                      : t('attendance.save.submit')}
                </span>
                <span className="sm:hidden">
                  {saving
                    ? t('attendance.save.savingShort')
                    : attendanceAlreadySaved
                      ? t('attendance.save.savedShort')
                      : t('attendance.save.submitShort')}
                </span>
              </Button>
            </motion.div>
          </div>
        </form>
      )}
    </div>
  );
}

function CountChip({ label, value, tone = 'default' }) {
  const color = {
    default: 'var(--color-fg)',
    success: 'var(--color-success)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  }[tone];
  const dotBg = {
    default: 'var(--color-fg-subtle)',
    success: 'var(--color-success)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  }[tone];
  return (
    <div className="inline-flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 h-8 sm:h-9 rounded-xl bg-[color:var(--color-bg-2)] hairline">
      <span
        className="size-1.5 rounded-full shrink-0"
        style={{ background: dotBg, boxShadow: `0 0 8px ${dotBg}` }}
      />
      <span className="text-[10px] sm:text-[11px] uppercase tracking-[0.1em] sm:tracking-[0.12em] text-[color:var(--color-fg-subtle)]">
        {label}
      </span>
      <span className="text-xs sm:text-sm font-semibold tabular tracking-tight" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

function StatusToggle({ value, onChange, locked, groupId }) {
  const { t } = useTranslation(['leader', 'common']);
  return (
    <div
      role="radiogroup"
      className={cn(
        'relative inline-flex items-center p-0.5 rounded-xl bg-[color:var(--color-bg-2)] hairline shrink-0 w-full sm:w-auto',
        locked && 'opacity-60 pointer-events-none',
      )}
    >
      {[
        { v: 'present', label: t('common:status.present'), tone: 'success' },
        { v: 'absent', label: t('common:status.absent'), tone: 'danger' },
      ].map((opt) => {
        const active = value === opt.v;
        const accent =
          opt.tone === 'success' ? 'var(--color-success)' : 'var(--color-danger)';
        return (
          <button
            key={opt.v}
            role="radio"
            aria-checked={active}
            type="button"
            onClick={() => onChange(opt.v)}
            disabled={locked}
            className={cn(
              'relative inline-flex items-center justify-center h-9 sm:h-8 px-3 sm:px-3.5 rounded-[10px] text-xs font-medium tracking-tight transition-colors duration-150 flex-1 sm:flex-initial',
              active ? 'text-[oklch(0.18_0.02_260)]' : 'text-[color:var(--color-fg-muted)]',
            )}
          >
            {active && (
              <motion.span
                layoutId={`status-pill-${groupId}`}
                className="absolute inset-0 rounded-[10px]"
                style={{ background: accent }}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              />
            )}
            <span className="relative">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function StudentRow({
  index,
  student,
  attendance,
  attachment,
  locked,
  onStatusChange,
  onJustificationChange,
  onObservationChange,
  onFileSelect,
  onRemoveFile,
  onDownloadAttachment,
  registerFileInput,
}) {
  const { t } = useTranslation(['leader', 'common']);
  const inputRef = useRef(null);
  const setRef = useCallback(
    (el) => {
      inputRef.current = el;
      registerFileInput?.(el);
    },
    [registerFileInput],
  );
  const status = attendance?.status;
  const isAbsent = status === 'absent';
  const initials = student.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase();

  const statusColor =
    status === 'present'
      ? 'var(--color-success)'
      : status === 'absent'
        ? 'var(--color-danger)'
        : 'var(--color-fg-subtle)';

  return (
    <motion.li
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.015, 0.4) }}
      className="px-3 sm:px-5 py-3 sm:py-4 hover:bg-[color-mix(in_oklch,var(--color-surface-hover)_50%,transparent)] transition-colors"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-5">
        {/* Identity */}
        <div className="flex items-center gap-3 lg:flex-1 min-w-0">
          <div className="relative shrink-0">
            <span className="size-10 grid place-items-center rounded-full bg-[color:var(--color-bg-3)] hairline text-sm font-semibold tracking-tight text-[color:var(--color-fg-muted)]">
              {initials || '·'}
            </span>
            <span
              aria-hidden
              className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-[color:var(--color-bg)]"
              style={{ background: statusColor }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium tracking-tight truncate">{student.name}</div>
            <div className="text-[11px] text-[color:var(--color-fg-subtle)] flex items-center gap-1.5 sm:gap-2 flex-wrap">
              {student.student_id && (
                <span className="tabular">{t('attendance.row.studentId', { id: student.student_id })}</span>
              )}
              {student.email && (
                <>
                  <span className="size-0.5 rounded-full bg-current opacity-50 hidden sm:inline-block" />
                  <span className="truncate hidden sm:inline">{student.email}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Status toggle */}
        <StatusToggle
          value={status}
          groupId={student.id}
          onChange={(v) => onStatusChange(student.id, v)}
          locked={locked}
        />
      </div>

      {/* Reveal: justification + observation + attachment */}
      <AnimatePresence initial={false}>
        {isAbsent && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-3 sm:mt-4 grid grid-cols-1 lg:grid-cols-[auto_1fr_auto] gap-2.5 sm:gap-3 lg:items-start lg:pl-[3.25rem]">
              {/* Justification radios */}
              <div className="flex gap-1.5 p-0.5 rounded-xl bg-[color:var(--color-bg-2)] hairline w-full sm:w-auto">
                {[
                  { v: 'injustificada', label: t('common:status.unjustified'), tone: 'danger' },
                  { v: 'justificada', label: t('common:status.justified'), tone: 'warn' },
                ].map((opt) => {
                  const active = attendance?.justification === opt.v;
                  const color = opt.tone === 'warn' ? 'var(--color-warn)' : 'var(--color-danger)';
                  return (
                    <button
                      key={opt.v}
                      type="button"
                      onClick={() => onJustificationChange(student.id, opt.v)}
                      disabled={locked}
                      className={cn(
                        'h-8 sm:h-7 px-2.5 rounded-[10px] text-[11px] font-medium tracking-tight transition-colors flex-1 sm:flex-initial',
                        active
                          ? 'text-[oklch(0.18_0.02_260)]'
                          : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]',
                      )}
                      style={active ? { background: color } : undefined}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              {/* Observation */}
              <textarea
                placeholder={t('attendance.row.observationPlaceholder')}
                value={attendance?.observation || ''}
                onChange={(e) => onObservationChange(student.id, e.target.value)}
                rows={2}
                maxLength={500}
                disabled={locked}
                className="min-h-[44px] w-full px-3 py-2 rounded-xl bg-[color:var(--color-bg-2)] hairline text-sm leading-relaxed placeholder:text-[color:var(--color-fg-subtle)] focus:outline-none focus:border-[color:var(--color-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-accent)_18%,transparent)] resize-y"
              />

              {/* Attachment */}
              <div className="flex flex-col gap-2 w-full lg:w-auto lg:shrink-0 lg:min-w-[180px]">
                <input
                  type="file"
                  ref={setRef}
                  className="hidden"
                  accept=".png,.jpg,.jpeg,.pdf"
                  onChange={(e) => onFileSelect(student.id, e)}
                />

                {attachment ? (
                  <FileChip
                    name={attachment.name}
                    onRemove={() => onRemoveFile(student.id)}
                    accent="var(--color-accent)"
                  />
                ) : attendance?.attachmentFileName ? (
                  <FileChip
                    name={attendance.attachmentFileName}
                    onView={() => onDownloadAttachment(student.id)}
                    accent="var(--color-success)"
                  />
                ) : null}

                <button
                  type="button"
                  disabled={locked}
                  onClick={() => inputRef.current?.click()}
                  className={cn(
                    'inline-flex items-center justify-center gap-2 h-10 sm:h-9 px-3 rounded-xl hairline text-xs font-medium tracking-tight bg-[color:var(--color-bg-2)] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:border-[color:var(--color-border-strong)] transition-colors',
                    locked && 'opacity-50 pointer-events-none',
                  )}
                >
                  <Paperclip className="size-3.5" />
                  {attachment || attendance?.attachmentFileName
                    ? t('attendance.row.changeAttachment')
                    : t('attendance.row.addAttachment')}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function FileChip({ name, onRemove, onView, accent }) {
  const { t } = useTranslation(['leader', 'common']);
  const isPdf = name.toLowerCase().endsWith('.pdf');
  const Icon = isPdf ? FileText : ImageIcon;
  return (
    <div className="inline-flex items-center gap-2 h-9 pl-2 pr-1 rounded-xl bg-[color:var(--color-bg-2)] hairline max-w-full">
      <Icon className="size-3.5 shrink-0" style={{ color: accent }} />
      <span className="text-xs tracking-tight truncate min-w-0 flex-1 max-w-[160px] sm:max-w-[120px]">{name}</span>
      {onView && (
        <button
          type="button"
          onClick={onView}
          className="text-[10px] uppercase tracking-wide text-[color:var(--color-accent)] hover:underline ml-auto px-1.5 shrink-0"
        >
          {t('attendance.row.viewFile')}
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('attendance.row.removeFile')}
          className="size-6 grid place-items-center rounded-md text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-danger)] hover:bg-[color:var(--color-surface-hover)] ml-auto shrink-0"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

export default Attendance;
