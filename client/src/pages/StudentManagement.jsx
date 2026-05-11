import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  UserPlus,
  Pencil,
  Trash2,
  Users,
  History,
  Search,
  Mail,
  IdCard,
  Sparkles,
} from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { useAuth } from '../context/useAuth.js';
import {
  addStudent,
  updateStudent,
  deleteStudent,
  getCurrentRotationStudents,
  getStudentsByRotation,
  getAvailableRotations,
} from '../api/client';
import Loading from '../components/common/Loading';
import Message from '../components/common/Message';
import AttendanceHistoryModal from '../components/features/attendance/AttendanceHistoryModal';
import { SectionTitle } from '../components/ui/AppShell';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Modal from '../components/ui/Modal';
import Badge from '../components/ui/Badge';
import { Input, Label, Select } from '../components/ui/Input';

function StudentManagement() {
  const { t } = useTranslation(['leader', 'common']);
  const { leader } = useAuth();
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingStudent, setEditingStudent] = useState(null);
  const [formData, setFormData] = useState({ name: '', studentId: '', email: '' });
  const [message, setMessage] = useState({ type: '', text: '' });
  const [currentRotation, setCurrentRotation] = useState(null);
  const [selectedRotation, setSelectedRotation] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [availableRotations, setAvailableRotations] = useState([]);

  useEffect(() => {
    if (leader) {
      fetchAvailableRotations();
      fetchStudents();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leader]);

  useEffect(() => {
    if (message.text) {
      const t = setTimeout(() => setMessage({ type: '', text: '' }), 3000);
      return () => clearTimeout(t);
    }
  }, [message]);

  const fetchAvailableRotations = async () => {
    try {
      const data = await getAvailableRotations(leader.projectId);
      setAvailableRotations(data.rotationNumbers || []);
    } catch (err) {
      console.error('Error fetching available rotations:', err);
      setAvailableRotations([1, 2, 3, 4, 5, 6, 7]);
    }
  };

  const fetchStudents = async (rotationNumber = null) => {
    setLoading(true);
    try {
      if (rotationNumber) {
        const data = await getStudentsByRotation(leader.projectId, rotationNumber);
        setStudents(data);
      } else {
        try {
          const data = await getCurrentRotationStudents(leader.projectId);
          setStudents(data.students);
          setCurrentRotation(data.rotationNumber);
          setSelectedRotation(data.rotationNumber);
        } catch {
          const data = await getStudentsByRotation(leader.projectId, 1);
          setStudents(data);
          setSelectedRotation(1);
          setCurrentRotation(null);
        }
      }
    } catch (err) {
      showMessage('error', t('students.messages.loadError'));
      console.error('Error fetching students:', err);
    } finally {
      setLoading(false);
    }
  };

  const showMessage = (type, text) => setMessage({ type, text });

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      showMessage('error', t('students.messages.nameRequired'));
      return;
    }
    setLoading(true);
    try {
      if (editingStudent) {
        await updateStudent(editingStudent.id, {
          name: formData.name,
          student_id: formData.studentId,
          email: formData.email,
        });
        showMessage('success', t('students.messages.updated'));
      } else {
        await addStudent(leader.projectId, formData);
        showMessage('success', t('students.messages.added'));
      }
      setFormData({ name: '', studentId: '', email: '' });
      setShowForm(false);
      setEditingStudent(null);
      await fetchStudents(selectedRotation);
    } catch (err) {
      const msg =
        err.response?.data?.error ||
        (editingStudent ? t('students.messages.updateError') : t('students.messages.addError'));
      showMessage('error', msg);
      console.error('Error saving student:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (student) => {
    setEditingStudent(student);
    setFormData({
      name: student.name,
      studentId: student.student_id || '',
      email: student.email || '',
    });
    setShowForm(true);
  };

  const handleDelete = async (student) => {
    if (!confirm(t('students.confirmDelete', { name: student.name }))) return;
    setLoading(true);
    try {
      await deleteStudent(student.id);
      showMessage('success', t('students.messages.deleted'));
      await fetchStudents(selectedRotation);
    } catch (err) {
      const msg = err.response?.data?.error || t('students.messages.deleteError');
      showMessage('error', msg);
      console.error('Error deleting student:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setFormData({ name: '', studentId: '', email: '' });
    setShowForm(false);
    setEditingStudent(null);
  };

  const handleRotationChange = (e) => {
    const rotation = parseInt(e.target.value);
    setSelectedRotation(rotation);
    fetchStudents(rotation);
  };

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return students;
    return students.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.student_id && s.student_id.toLowerCase().includes(q)) ||
        (s.email && s.email.toLowerCase().includes(q)),
    );
  }, [students, searchTerm]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <header className="flex flex-col gap-3 sm:gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <SectionTitle>{t('students.sectionTitle')}</SectionTitle>
          <h2 className="text-lg sm:text-xl font-semibold tracking-tight flex items-center gap-2">
            <Users className="size-5 text-[color:var(--color-accent)] shrink-0" />
            {t('students.heading')}
          </h2>
          <p className="text-xs text-[color:var(--color-fg-subtle)] mt-1 tabular flex items-center gap-2 flex-wrap">
            <span>
              <Trans
                i18nKey="students.showing"
                ns="leader"
                values={{ shown: filtered.length, total: students.length }}
                components={{
                  1: <span className="text-[color:var(--color-fg)] font-medium" />,
                  2: <span className="text-[color:var(--color-fg)] font-medium" />,
                }}
              />
            </span>
            {selectedRotation === currentRotation && currentRotation && (
              <Badge tone="accent" className="!h-5">
                <span className="size-1 rounded-full bg-current animate-pulse-soft" />
                {t('students.currentRotationBadge')}
              </Badge>
            )}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
          <div className="inline-flex items-center gap-2 px-3 h-11 sm:h-10 rounded-xl bg-[color:var(--color-bg-2)] hairline self-start sm:self-auto">
            <Sparkles className="size-3.5 text-[color:var(--color-fg-subtle)] shrink-0" />
            <Label className="!mb-0 text-[11px]">{t('students.rotationLabel')}</Label>
            <Select
              id="rotation"
              value={selectedRotation || ''}
              onChange={handleRotationChange}
              disabled={loading}
              className="!h-8 !bg-transparent !border-0 !shadow-none !pl-1 !pr-7 !w-auto text-sm font-medium tabular focus:!shadow-none"
            >
              {availableRotations.length > 0 ? (
                availableRotations.map((num) => (
                  <option key={num} value={num}>
                    {num === currentRotation
                      ? t('students.rotationOptionCurrent', { n: num })
                      : t('students.rotationOption', { n: num })}
                  </option>
                ))
              ) : (
                <option value="">{t('students.noRotations')}</option>
              )}
            </Select>
          </div>

          <Button onClick={() => setShowForm(true)} className="h-11 sm:h-10 w-full sm:w-auto">
            <UserPlus className="size-4" />
            {t('students.addStudent')}
          </Button>
        </div>
      </header>

      <Message
        type={message.type}
        text={message.text}
        onClose={() => setMessage({ type: '', text: '' })}
      />

      {/* Search */}
      <div className="relative w-full sm:max-w-md">
        <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--color-fg-subtle)] pointer-events-none" />
        <Input
          type="text"
          placeholder={t('students.searchPlaceholder')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-9 h-11 sm:h-10"
        />
      </div>

      {loading && students.length === 0 ? (
        <Loading message={t('students.loading')} />
      ) : students.length === 0 ? (
        <Card className="text-center py-14">
          <p className="text-base font-medium">{t('students.emptyTitle')}</p>
          <p className="text-sm text-[color:var(--color-fg-muted)] mt-2">
            {t('students.emptyHint')}
          </p>
          <Button className="mt-5 mx-auto" onClick={() => setShowForm(true)}>
            <UserPlus className="size-4" />
            {t('students.addStudent')}
          </Button>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="text-center py-10">
          <p className="text-sm text-[color:var(--color-fg-muted)]">
            <Trans
              i18nKey="students.noSearchResults"
              ns="leader"
              values={{ query: searchTerm }}
              components={{ 1: <span className="text-[color:var(--color-fg)] font-medium" /> }}
            />
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          <AnimatePresence initial={false}>
            {filtered.map((student, i) => (
              <StudentCard
                key={student.id}
                index={i}
                student={student}
                onEdit={() => handleEdit(student)}
                onDelete={() => handleDelete(student)}
                onShowHistory={() => setSelectedStudent(student)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* Modal: add / edit student */}
      <Modal
        open={showForm}
        onClose={handleCancel}
        title={editingStudent ? t('students.modal.editTitle') : t('students.modal.addTitle')}
        description={
          editingStudent
            ? t('students.modal.editDescription')
            : t('students.modal.addDescription')
        }
      >
        <form onSubmit={handleSubmit} className="space-y-3 sm:space-y-4">
          <div>
            <Label htmlFor="name">{t('students.modal.nameRequired')}</Label>
            <Input
              id="name"
              name="name"
              value={formData.name}
              onChange={handleInputChange}
              required
              autoFocus
              className="h-11 sm:h-10"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="studentId">{t('students.modal.studentId')}</Label>
              <Input
                id="studentId"
                name="studentId"
                value={formData.studentId}
                onChange={handleInputChange}
                className="h-11 sm:h-10"
              />
            </div>
            <div>
              <Label htmlFor="email">{t('students.modal.email')}</Label>
              <Input
                id="email"
                type="email"
                name="email"
                value={formData.email}
                onChange={handleInputChange}
                className="h-11 sm:h-10"
              />
            </div>
          </div>
          <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center sm:justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={handleCancel} disabled={loading} className="h-11 sm:h-10">
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" loading={loading} className="h-11 sm:h-10">
              {editingStudent ? t('students.modal.update') : t('students.modal.add')}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Attendance history modal */}
      {selectedStudent && (
        <AttendanceHistoryModal
          student={selectedStudent}
          onClose={() => setSelectedStudent(null)}
        />
      )}
    </div>
  );
}

function StudentCard({ student, index, onEdit, onDelete, onShowHistory }) {
  const { t } = useTranslation(['leader', 'common']);
  const initials = student.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase();

  // Pseudorandom hue from name for avatar accent (deterministic).
  const hue = useMemo(() => {
    let h = 0;
    for (let i = 0; i < student.name.length; i++) h = (h * 31 + student.name.charCodeAt(i)) % 360;
    return h;
  }, [student.name]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.025, 0.4) }}
      className="group"
    >
      <Card hover className="p-4 h-full flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="size-11 grid place-items-center rounded-xl text-sm font-semibold tracking-tight shrink-0 hairline"
            style={{
              background: `linear-gradient(135deg, oklch(0.42 0.10 ${hue}), oklch(0.32 0.08 ${hue}))`,
              color: 'oklch(0.96 0.02 ' + hue + ')',
            }}
          >
            {initials || '·'}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold tracking-tight truncate">{student.name}</div>
            {student.student_id ? (
              <div className="inline-flex items-center gap-1 text-[11px] text-[color:var(--color-fg-subtle)] mt-0.5">
                <IdCard className="size-3" />
                <span className="tabular">{student.student_id}</span>
              </div>
            ) : (
              <div className="text-[11px] text-[color:var(--color-fg-subtle)] mt-0.5 italic">
                {t('students.card.noStudentId')}
              </div>
            )}
          </div>
        </div>

        <div className="text-[12px] text-[color:var(--color-fg-muted)] flex items-center gap-1.5 min-h-[18px] truncate">
          <Mail className="size-3 shrink-0 text-[color:var(--color-fg-subtle)]" />
          <span className="truncate">{student.email || t('students.card.noEmail')}</span>
        </div>

        <div className="flex items-center gap-1.5 mt-auto pt-2 border-t border-[color:var(--color-border)]">
          <button
            type="button"
            onClick={onShowHistory}
            className="inline-flex items-center gap-1.5 h-9 sm:h-8 px-2.5 rounded-lg text-xs font-medium tracking-tight text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-accent)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
            title={t('students.card.viewHistory')}
          >
            <History className="size-3.5" />
            {t('students.card.history')}
          </button>
          <span className="ml-auto flex items-center gap-1 opacity-80 sm:opacity-60 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={onEdit}
              aria-label={t('students.card.edit')}
              className="size-9 sm:size-8 grid place-items-center rounded-lg text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-accent)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label={t('students.card.delete')}
              className="size-9 sm:size-8 grid place-items-center rounded-lg text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-danger)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
            >
              <Trash2 className="size-3.5" />
            </button>
          </span>
        </div>
      </Card>
    </motion.div>
  );
}

export default StudentManagement;
