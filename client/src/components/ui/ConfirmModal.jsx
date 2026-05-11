import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import Button from './Button';

// Themed replacement for window.confirm. Modal-style dialog with i18n labels.
// Pass `tone="danger"` for destructive operations so the primary action gets
// the red treatment, matching the visual weight of the action.
function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  busy = false,
}) {
  const { t } = useTranslation('common');
  const confirmText = confirmLabel || t('actions.confirm');
  const cancelText = cancelLabel || t('actions.cancel');

  const handleConfirm = async () => {
    await onConfirm?.();
    onClose?.();
  };

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      {description && (
        <p className="text-sm text-[color:var(--color-fg-muted)]">{description}</p>
      )}
      <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {cancelText}
        </Button>
        <Button
          variant={tone === 'danger' ? 'danger' : 'primary'}
          onClick={handleConfirm}
          loading={busy}
        >
          {confirmText}
        </Button>
      </div>
    </Modal>
  );
}

export default ConfirmModal;
