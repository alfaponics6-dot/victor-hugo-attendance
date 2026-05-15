import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Button from '../ui/Button';
import { removeConflict } from '../../lib/offlineQueue';

// Fallback resolver used when a queued write that ISN'T attendance/bulk
// hit a conflict — student create/update/delete, etc. We don't yet have
// per-entity resolvers for those, so we just show what the leader tried
// to do and let them discard it. A future phase can swap this for real
// resolvers per endpoint.
export default function GenericConflictResolver({ conflict, onResolved }) {
  const { t } = useTranslation('common');
  const [discarding, setDiscarding] = useState(false);

  // JSON.stringify can throw on circular refs / bigints. IDB's
  // structured-clone normally rejects those before storage, but a
  // DevTools-injected record or a future code path that bypasses
  // structuredClone could land one. Guard so the resolver remains
  // usable (with a degraded preview) rather than crashing into the
  // ErrorBoundary and losing the Discard button.
  let bodyPreview;
  try {
    bodyPreview = JSON.stringify(
      conflict?.body?.body ?? conflict?.body?.fields ?? conflict?.body ?? null,
      null,
      2,
    );
  } catch (e) {
    bodyPreview = `(preview unavailable: ${e.message})`;
  }

  const handleDiscard = async () => {
    setDiscarding(true);
    try {
      await removeConflict(conflict.id);
      onResolved?.();
    } finally {
      setDiscarding(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-[color:var(--color-fg-muted)]">
        {t('offline.conflictResolver.genericIntro')}
      </p>
      <div className="rounded-lg border border-[color:var(--color-border)] p-3 space-y-1.5">
        <div className="text-[11px] uppercase tracking-wide text-[color:var(--color-fg-subtle)]">
          {conflict.method} {conflict.url}
        </div>
        {conflict.serverMessage && (
          <div className="text-sm text-orange-700 dark:text-orange-300">
            {conflict.serverMessage}
          </div>
        )}
        <pre className="text-[11px] bg-[color:var(--color-surface-hover)] rounded p-2 overflow-x-auto max-h-48">
{bodyPreview}
        </pre>
      </div>
      <div className="flex justify-end">
        <Button variant="danger" onClick={handleDiscard} disabled={discarding} loading={discarding}>
          {t('offline.conflictResolver.discard')}
        </Button>
      </div>
    </div>
  );
}
