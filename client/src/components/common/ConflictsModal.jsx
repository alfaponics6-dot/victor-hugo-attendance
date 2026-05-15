import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, AlertTriangle } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { listConflicts } from '../../lib/offlineQueue';
import { useAuth } from '../../context/useAuth.js';
import AttendanceConflictResolver from './AttendanceConflictResolver';
import GenericConflictResolver from './GenericConflictResolver';

// Detects which resolver to use based on the queued URL.
function isAttendanceBulk(conflict) {
  return /\/attendance\/bulk(\?|$)/.test(conflict.url || '');
}

function conflictTitle(conflict, t) {
  if (isAttendanceBulk(conflict)) {
    const date = conflict.body?.body?.date || conflict.body?.fields?.date;
    return date
      ? t('offline.conflictsModal.attendanceForDate', { date })
      : t('offline.conflictsModal.attendance');
  }
  return `${conflict.method || 'POST'} ${conflict.url || ''}`;
}

export default function ConflictsModal({ open, onClose }) {
  const { t } = useTranslation('common');
  const { leader } = useAuth();
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);

  const refresh = useCallback(async () => {
    const all = await listConflicts();
    setItems(all);
    // If the currently-selected conflict was resolved, clear selection
    if (selected && !all.find((c) => c.id === selected.id)) {
      setSelected(null);
    }
  }, [selected]);

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  const handleResolved = async () => {
    setSelected(null);
    await refresh();
  };

  const title = selected ? conflictTitle(selected, t) : t('offline.conflictsModal.title');
  const description = selected ? null : t('offline.conflictsModal.description');

  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size="xl">
      {selected ? (
        <div>
          <button
            onClick={() => setSelected(null)}
            className="mb-3 inline-flex items-center gap-1 text-xs text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
          >
            <ChevronLeft className="size-3.5" /> {t('actions.back')}
          </button>
          {isAttendanceBulk(selected) ? (
            <AttendanceConflictResolver
              conflict={selected}
              leader={leader}
              onResolved={handleResolved}
            />
          ) : (
            <GenericConflictResolver
              conflict={selected}
              onResolved={handleResolved}
            />
          )}
        </div>
      ) : (
        <ConflictsList items={items} onSelect={setSelected} t={t} />
      )}
    </Modal>
  );
}

function ConflictsList({ items, onSelect, t }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-[color:var(--color-fg-muted)] text-center py-6">
        {t('offline.conflictsModal.empty')}
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            onClick={() => onSelect(c)}
            className="w-full text-left rounded-lg border border-[color:var(--color-border)] p-3 hover:bg-[color:var(--color-surface-hover)] transition-colors flex items-start gap-3"
          >
            <AlertTriangle className="size-4 text-orange-500 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{conflictTitle(c, t)}</div>
              {c.serverMessage && (
                <div className="text-xs text-[color:var(--color-fg-muted)] line-clamp-2 mt-0.5">
                  {c.serverMessage}
                </div>
              )}
              <div className="text-[11px] text-[color:var(--color-fg-subtle)] mt-1">
                {new Date(c.createdAt).toLocaleString()}
              </div>
            </div>
            <Button variant="secondary" size="sm" tabIndex={-1} aria-hidden="true">
              {t('offline.conflictsModal.review')}
            </Button>
          </button>
        </li>
      ))}
    </ul>
  );
}
