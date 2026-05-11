import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { CalendarRange, ChevronRight, Sparkles } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { getRotationsSchedule } from '../../../api/client';
import Card from '../../ui/Card';
import Badge from '../../ui/Badge';
import Skeleton from '../../ui/Skeleton';
import { cn } from '../../../lib/cn';

/**
 * Horizontal timeline of rotations. The active rotation glows; upcoming ones
 * fade. A "next change in N days" pill surfaces the most actionable info.
 */
function RotationCalendar() {
  const { t, i18n } = useTranslation(['leader', 'common']);
  const [rotations, setRotations] = useState([]);
  const [currentRotation, setCurrentRotation] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchRotations();
  }, []);

  const fetchRotations = async () => {
    try {
      const data = await getRotationsSchedule();
      setRotations(data.rotations);
      setCurrentRotation(data.currentRotation);
    } catch (error) {
      console.error('Error fetching rotations:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (s) => {
    const d = new Date(s + 'T00:00:00');
    return d.toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' });
  };

  const getRotationStatus = (rotation) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(rotation.start_date + 'T00:00:00');
    const end = new Date(rotation.end_date + 'T00:00:00');
    if (today < start) return 'upcoming';
    if (today > end) return 'completed';
    return 'active';
  };

  const getDaysUntilNext = () => {
    if (!rotations.length) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (const r of rotations) {
      const start = new Date(r.start_date + 'T00:00:00');
      if (start > today) {
        const diff = Math.ceil((start - today) / (1000 * 60 * 60 * 24));
        return { rotation: r.rotation_number, days: diff };
      }
    }
    return null;
  };

  if (loading) {
    return (
      <Card className="p-4 sm:p-5">
        <Skeleton className="h-4 w-48 mb-4" />
        <div className="flex gap-2 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-32 shrink-0 rounded-xl" />
          ))}
        </div>
      </Card>
    );
  }

  const nextRotation = getDaysUntilNext();

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start sm:items-center justify-between gap-3 mb-3 sm:mb-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="size-8 grid place-items-center rounded-xl bg-[color-mix(in_oklch,var(--color-accent-2)_18%,transparent)] text-[color:var(--color-accent-2)] shrink-0">
            <CalendarRange className="size-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight truncate">{t('rotation.title')}</h3>
            <p className="text-[11px] text-[color:var(--color-fg-subtle)]">
              {t('rotation.subtitle')}
            </p>
          </div>
        </div>
        {nextRotation && (
          <div className="inline-flex items-center gap-2 px-3 h-8 rounded-xl bg-[color-mix(in_oklch,var(--color-accent)_12%,transparent)] hairline max-w-full">
            <Sparkles className="size-3.5 text-[color:var(--color-accent)] shrink-0" />
            <span className="text-[12px] tracking-tight truncate">
              <Trans
                i18nKey="rotation.nextChange"
                ns="leader"
                values={{ rotation: nextRotation.rotation, days: nextRotation.days }}
                count={nextRotation.days}
                components={{
                  1: <span className="font-semibold tabular text-[color:var(--color-fg)]" />,
                  2: <span className="font-semibold tabular text-[color:var(--color-accent)]" />,
                }}
              />
            </span>
          </div>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 sm:-mx-1 sm:px-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden [-webkit-overflow-scrolling:touch]">
        {rotations.map((r, i) => {
          const status = getRotationStatus(r);
          const isActive = r.rotation_number === currentRotation;
          return (
            <motion.div
              key={r.rotation_number}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.04 }}
              className={cn(
                'relative shrink-0 min-w-[148px] rounded-xl px-3.5 py-3 transition-colors',
                isActive
                  ? 'bg-[color-mix(in_oklch,var(--color-accent)_14%,transparent)] hairline-strong'
                  : status === 'completed'
                    ? 'bg-[color:var(--color-bg-2)] hairline opacity-55'
                    : 'bg-[color:var(--color-bg-2)] hairline',
              )}
            >
              {isActive && (
                <span
                  aria-hidden
                  className="absolute -top-px left-3 right-3 h-px"
                  style={{
                    background:
                      'linear-gradient(90deg, transparent, var(--color-accent), transparent)',
                  }}
                />
              )}
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-base font-semibold tabular tracking-tight">
                  {t('rotation.rotationLabel', { n: r.rotation_number })}
                </span>
                {isActive ? (
                  <Badge tone="accent" className="!h-5">
                    <span className="size-1 rounded-full bg-current animate-pulse-soft" />
                    {t('rotation.currentBadge')}
                  </Badge>
                ) : status === 'completed' ? (
                  <Badge tone="default" className="!h-5">{t('rotation.completedBadge')}</Badge>
                ) : (
                  <Badge tone="outline" className="!h-5">{t('rotation.upcomingBadge')}</Badge>
                )}
              </div>
              <div className="flex items-center gap-1 text-[11px] tabular text-[color:var(--color-fg-muted)]">
                <span>{formatDate(r.start_date)}</span>
                <ChevronRight className="size-3 text-[color:var(--color-fg-subtle)]" />
                <span>{formatDate(r.end_date)}</span>
              </div>
              {r.rotation_number >= 6 && (
                <div className="mt-1.5 text-[10px] tracking-wide uppercase text-[color:var(--color-fg-subtle)]">
                  {t('rotation.fourSessions')}
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </Card>
  );
}

export default RotationCalendar;
