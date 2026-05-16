import { useRef, useState } from 'react';
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
  // Local in-flight guard. Even when the parent doesn't pass `busy`, we
  // still want to block double-clicks on `onConfirm`. Without this, a fast
  // double-tap on a destructive action would call the handler twice before
  // the parent had a chance to flip its own `busy` flag.
  const [internalBusy, setInternalBusy] = useState(false);
  const inFlightRef = useRef(false);
  const isBusy = busy || internalBusy;

  const handleConfirm = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setInternalBusy(true);
    try {
      await onConfirm?.();
      onClose?.();
    } catch (err) {
      // Surface the error to the console — keep the modal open so the user
      // can retry or cancel. Closing on failure was hiding errors silently.
      if (import.meta.env.DEV) console.error('ConfirmModal onConfirm failed:', err);
    } finally {
      inFlightRef.current = false;
      setInternalBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={isBusy ? undefined : onClose} title={title} size="sm">
      {description && (
        <p className="text-sm text-[color:var(--color-fg-muted)]">{description}</p>
      )}
      <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={isBusy}>
          {cancelText}
        </Button>
        <Button
          // Auto-focus the primary action so Enter confirms — matches the
          // platform `confirm()` behaviour our users expect.
          autoFocus
          variant={tone === 'danger' ? 'danger' : 'primary'}
          onClick={handleConfirm}
          loading={isBusy}
          disabled={isBusy}
        >
          {confirmText}
        </Button>
      </div>
    </Modal>
  );
}

export default ConfirmModal;
