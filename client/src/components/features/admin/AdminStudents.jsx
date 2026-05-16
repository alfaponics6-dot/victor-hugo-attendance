import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Trash2, Users, Mail, Hash, Filter } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getAllStudentsAdmin, deleteStudentAdmin } from '../../../api/client';
import Card from '../../ui/Card';
import Badge from '../../ui/Badge';
import Button from '../../ui/Button';
import { Input, Select } from '../../ui/Input';
import Skeleton from '../../ui/Skeleton';
import Message from '../../common/Message';
import ConfirmModal from '../../ui/ConfirmModal';
import { getProjectLabel } from '../../../lib/projectI18n';
import { useAuth } from '../../../context/useAuth.js';

function AdminStudents() {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [project, setProject] = useState('all');
  const [busyId, setBusyId] = useState(null);
  const [message, setMessage] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const { t } = useTranslation(['admin', 'common']);
  const { t: tProject } = useTranslation('projects');
  const pname = (s) => getProjectLabel(tProject, s);
  const { leader } = useAuth();
  // Server enforces this via requireCanDeleteStudents middleware; hiding
  // the button is a UX nicety so the user doesn't try and get a 403.
  // Default to true when missing so a slightly-stale profile doesn't hide
  // the action from users who should still have it.
  const canDelete = leader?.canDeleteStudents !== false;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getAllStudentsAdmin();
        if (cancelled) return;
        setStudents(Array.isArray(data) ? data : []);
      } catch (error) {
        console.error('Error loading students:', error);
        if (!cancelled) {
          setMessage({ type: 'error', text: t('students.loadError') });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-clear toasts after a moment so the page stays calm.
  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => setMessage(null), 4000);
    return () => window.clearTimeout(id);
  }, [message]);

  // Stable list of distinct projects for the filter dropdown. Keyed by
  // project_number so the option value stays stable across locales —
  // we used to key by `${number}|${translatedName}`, which broke the
  // filter when the rendered label differed from the DB's canonical
  // Spanish project_name even by a single accent (e.g. "plantulas"
  // in DB vs "plántulas" in the translation), and broke it entirely
  // in non-Spanish locales.
  const projects = useMemo(() => {
    const seen = new Map();
    for (const s of students) {
      const number = String(s.project_number ?? '');
      if (!number || seen.has(number)) continue;
      const name = pname(s) || `${t('common:labels.project')} ${number}`;
      seen.set(number, { number, name });
    }
    return Array.from(seen.values()).sort((a, b) => {
      const an = Number(a.number) || 0;
      const bn = Number(b.number) || 0;
      return an - bn;
    });
  }, [students, t]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return students.filter((s) => {
      if (project !== 'all') {
        if (String(s.project_number ?? '') !== project) return false;
      }
      if (!q) return true;
      return (
        (s.name || '').toLowerCase().includes(q) ||
        (s.student_id || '').toLowerCase().includes(q) ||
        (s.email || '').toLowerCase().includes(q) ||
        (s.project_name || '').toLowerCase().includes(q)
      );
    });
  }, [students, search, project]);

  const handleDelete = (student) => {
    setPendingDelete(student);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const student = pendingDelete;
    setBusyId(student.id);
    try {
      await deleteStudentAdmin(student.id);
      setStudents((prev) => prev.filter((s) => s.id !== student.id));
      setMessage({ type: 'success', text: t('students.deleteSuccess', { name: student.name }) });
    } catch (error) {
      console.error('Error deleting student:', error);
      setMessage({ type: 'error', text: t('students.deleteError') });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {message && (
        <Message
          type={message.type}
          text={message.text}
          onClose={() => setMessage(null)}
        />
      )}

      {/* Toolbar ──────────────────────────────────────────────────────── */}
      <Card className="p-3 sm:p-4">
        <div className="flex flex-col gap-2 sm:gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-[color:var(--color-fg-subtle)] pointer-events-none" />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('students.search')}
              className="pl-9 h-11 sm:h-10"
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <div className="relative flex-1 sm:flex-initial">
              <Filter className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-[color:var(--color-fg-subtle)] pointer-events-none" />
              <Select
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className="pl-9 w-full sm:w-56 h-11 sm:h-10"
              >
                <option value="all">{t('students.filterAll')}</option>
                {projects.map((p) => (
                  <option key={p.number} value={p.number}>
                    {p.number ? `#${p.number} · ` : ''}{p.name}
                  </option>
                ))}
              </Select>
            </div>
            <Badge tone="accent" className="h-9 px-3 text-xs self-start sm:self-auto">
              <Users className="size-3.5" />
              {loading ? '…' : t('students.countBadge', { filtered: filtered.length, total: students.length })}
            </Badge>
          </div>
        </div>
      </Card>

      {/* Mobile card list (phones) ────────────────────────────────────── */}
      <div className="sm:hidden space-y-2">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-4 w-2/3 mb-2" />
              <Skeleton className="h-3 w-1/2 mb-1.5" />
              <Skeleton className="h-3 w-3/5" />
            </Card>
          ))
        ) : filtered.length === 0 ? (
          <Card className="p-8 text-center text-sm text-[color:var(--color-fg-muted)]">
            {students.length === 0 ? t('students.empty') : t('students.noResults')}
          </Card>
        ) : (
          <AnimatePresence initial={false}>
            {filtered.map((s) => (
              <motion.div
                key={s.id}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.18 }}
              >
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="text-sm font-semibold tracking-tight truncate">
                        {s.name}
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-[color:var(--color-fg-muted)] tabular">
                        <Hash className="size-3 shrink-0" />
                        <span className="truncate">{s.student_id || '-'}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-[color:var(--color-fg-muted)]">
                        <Mail className="size-3 shrink-0" />
                        <span className="truncate">{s.email || '-'}</span>
                      </div>
                      {s.project_name ? (
                        <Badge tone="outline" className="font-medium mt-1 max-w-full">
                          <span className="truncate">
                            {s.project_number ? `#${s.project_number} · ` : ''}{pname(s)}
                          </span>
                        </Badge>
                      ) : null}
                    </div>
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={busyId === s.id}
                        onClick={() => handleDelete(s)}
                        aria-label={t('students.deleteAria', { name: s.name })}
                        className="h-11 w-11 p-0 shrink-0 text-[color:var(--color-fg-muted)] hover:!text-[color:var(--color-danger)]"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Desktop / tablet data table ─────────────────────────────────── */}
      <Card className="hidden sm:block p-0 overflow-hidden">
        <div className="max-h-[68vh] overflow-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="sticky top-0 z-10 bg-[color-mix(in_oklch,var(--color-bg-2)_92%,transparent)] backdrop-blur-md">
                <Th>{t('students.columns.name')}</Th>
                <Th><Hash className="inline size-3 -mt-0.5 mr-1" />{t('students.columns.studentId')}</Th>
                <Th><Mail className="inline size-3 -mt-0.5 mr-1" />{t('students.columns.email')}</Th>
                <Th>{t('students.columns.project')}</Th>
                <Th align="right">{t('students.columns.actions')}</Th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 5 }).map((__, j) => (
                      <td key={j} className="px-5 py-4 border-t border-[color:var(--color-border)]">
                        <Skeleton className="h-4 w-3/4" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-16 text-center text-sm text-[color:var(--color-fg-muted)]">
                    {students.length === 0 ? t('students.empty') : t('students.noResults')}
                  </td>
                </tr>
              ) : (
                <AnimatePresence initial={false}>
                  {filtered.map((s) => (
                    <motion.tr
                      key={s.id}
                      layout
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, x: -8 }}
                      transition={{ duration: 0.18 }}
                      className="border-t border-[color:var(--color-border)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
                    >
                      <td className="px-5 py-3.5 font-medium tracking-tight">
                        {s.name}
                      </td>
                      <td className="px-5 py-3.5 tabular text-[color:var(--color-fg-muted)]">
                        {s.student_id || '-'}
                      </td>
                      <td className="px-5 py-3.5 text-[color:var(--color-fg-muted)] max-w-0 lg:max-w-[28ch]">
                        <div className="truncate">{s.email || '-'}</div>
                      </td>
                      <td className="px-5 py-3.5">
                        {s.project_name ? (
                          <Badge tone="outline" className="font-medium">
                            {s.project_number ? `#${s.project_number} · ` : ''}{pname(s)}
                          </Badge>
                        ) : (
                          <span className="text-[color:var(--color-fg-subtle)]">-</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        {canDelete ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busyId === s.id}
                            onClick={() => handleDelete(s)}
                            aria-label={t('students.deleteAria', { name: s.name })}
                            className="text-[color:var(--color-fg-muted)] hover:!text-[color:var(--color-danger)]"
                          >
                            <Trash2 className="size-3.5" />
                            {t('students.actions.delete')}
                          </Button>
                        ) : (
                          <span className="text-[11px] text-[color:var(--color-fg-subtle)]">—</span>
                        )}
                      </td>
                    </motion.tr>
                  ))}
                </AnimatePresence>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <ConfirmModal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title={t('students.actions.delete')}
        description={pendingDelete ? t('students.confirmDelete', { name: pendingDelete.name }) : ''}
        confirmLabel={t('students.actions.delete')}
        tone="danger"
        busy={busyId === pendingDelete?.id}
      />
    </div>
  );
}

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

export default AdminStudents;
