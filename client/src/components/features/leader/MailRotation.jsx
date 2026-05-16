import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, Users, Calendar, Send, AlertCircle, AtSign } from 'lucide-react';
import {
  getRotationsSchedule,
  getStudentsByRotation,
  getMyCollaborators,
} from '../../../api/client';
import { useAuth } from '../../../context/useAuth.js';
import Card from '../../ui/Card';
import Badge from '../../ui/Badge';
import Button from '../../ui/Button';
import { Select } from '../../ui/Input';
import Skeleton from '../../ui/Skeleton';
import { formatDateForDisplay } from '../../../utils/dateUtils';

// Always-included Cc address(es). Configurable via VITE_COORDINATION_CC so
// a new term can rotate the address without a code change. Accepts a
// comma-separated list ("a@earth.ac.cr,b@earth.ac.cr") so coordination can
// CC more than one inbox without touching code. Falls back to the known
// Forestry Scenario coordination inbox.
const COORDINATION_CC_LIST = (import.meta.env?.VITE_COORDINATION_CC || 'forestryscenary@earth.ac.cr')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Kept for backwards-compat in the UI label below — show the first address
// (which is the historical single-inbox value in production today).
const COORDINATION_CC_DISPLAY = COORDINATION_CC_LIST[0] || '';

// Build a mailto URL. RFC 6068 says addresses go in the To position (URL path),
// other recipients/subject go as query params. Multi-address values are
// comma-separated. We encodeURIComponent each address so accented characters
// or odd chars don't break the URL — most mail apps accept either form, but
// some Outlook/Android handlers are picky.
//
// We trim and drop falsy entries first so a stray space in the env-configured
// CC (e.g. "a@b.com, c@d.com") doesn't survive into the mailto and stop
// Outlook from auto-resolving the second address.
function buildMailto({ to, cc, subject }) {
  const clean = (arr) =>
    (arr || [])
      .map((a) => (typeof a === 'string' ? a.trim() : ''))
      .filter(Boolean);
  const enc = (arr) => clean(arr).map((a) => encodeURIComponent(a)).join(',');
  const params = [];
  const encodedCc = enc(cc);
  if (encodedCc) params.push(`cc=${encodedCc}`);
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
  return `mailto:${enc(to)}${params.length ? '?' + params.join('&') : ''}`;
}

function MailRotation() {
  // Keys live under `leader.json`'s `mail` section, so we stay on the
  // `leader` namespace and reach them as `mail.X` (no `mail:` prefix).
  const { t, i18n } = useTranslation(['leader', 'common']);
  const { leader } = useAuth();

  const [rotations, setRotations] = useState([]);
  const [currentRotation, setCurrentRotation] = useState(null);
  const [collaborators, setCollaborators] = useState([]);
  const [selectedRotation, setSelectedRotation] = useState('');
  const [students, setStudents] = useState([]);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [loadingStudents, setLoadingStudents] = useState(false);
  const [error, setError] = useState(null);

  // 1. On mount: pull the global rotation schedule (7 windows + current
  //    rotation pointer) and the requesting leader's same-project teammates.
  useEffect(() => {
    if (!leader?.projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const [schedule, collab] = await Promise.all([
          getRotationsSchedule(),
          getMyCollaborators().catch(() => []),
        ]);
        if (cancelled) return;
        const rows = Array.isArray(schedule?.rotations) ? schedule.rotations : [];
        setRotations(rows);
        setCurrentRotation(schedule?.currentRotation ?? null);
        setCollaborators(Array.isArray(collab) ? collab : []);
        const initial = schedule?.currentRotation ?? rows[0]?.rotation_number ?? '';
        setSelectedRotation(initial ? String(initial) : '');
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Failed to load rotations');
      } finally {
        if (!cancelled) setLoadingMeta(false);
      }
    })();
    return () => { cancelled = true; };
  }, [leader?.projectId]);

  // 2. Whenever the user picks a different rotation, fetch its students.
  useEffect(() => {
    if (!leader?.projectId || !selectedRotation) {
      setStudents([]);
      return;
    }
    let cancelled = false;
    setLoadingStudents(true);
    (async () => {
      try {
        const rows = await getStudentsByRotation(leader.projectId, selectedRotation);
        if (!cancelled) setStudents(Array.isArray(rows) ? rows : []);
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Failed to load students');
      } finally {
        if (!cancelled) setLoadingStudents(false);
      }
    })();
    return () => { cancelled = true; };
  }, [leader?.projectId, selectedRotation]);

  const rotationMeta = useMemo(
    () => rotations.find((r) => String(r.rotation_number) === selectedRotation),
    [rotations, selectedRotation]
  );

  const studentEmails = useMemo(
    () => students.map((s) => s.email).filter(Boolean),
    [students]
  );
  const missingCount = students.length - studentEmails.length;

  const collabEmails = useMemo(
    () => collaborators.map((c) => c.email).filter(Boolean),
    [collaborators]
  );
  const ccList = useMemo(
    () => [...COORDINATION_CC_LIST, ...collabEmails],
    [collabEmails]
  );

  const projectLabel = leader?.projectName || '';
  const subject = t('mail.subjectDefault', {
    project: projectLabel,
    n: selectedRotation,
  });

  const mailtoHref = useMemo(() => {
    if (studentEmails.length === 0) return '';
    return buildMailto({ to: studentEmails, cc: ccList, subject });
  }, [studentEmails, ccList, subject]);

  const handleOpen = () => {
    if (!mailtoHref) return;
    // window.location.href works in every browser; window.open with mailto
    // sometimes leaves a blank tab open on Chrome desktop.
    window.location.href = mailtoHref;
  };

  if (loadingMeta) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-6 text-sm text-[color:var(--color-danger)]">
        <AlertCircle className="inline size-4 mr-2 -mt-0.5" />
        {error}
      </Card>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <header className="space-y-1">
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-[color:var(--color-fg-subtle)] inline-flex items-center gap-2">
          <Mail className="size-3.5 text-[color:var(--color-accent)]" />
          {t('mail.sectionTitle')}
        </div>
        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight">
          {t('mail.heading')}
        </h2>
        <p className="text-sm text-[color:var(--color-fg-muted)] max-w-2xl">
          {t('mail.subtitle')}
        </p>
      </header>

      <Card className="p-4 sm:p-5 space-y-4">
        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] inline-flex items-center gap-1.5 mb-2">
            <Calendar className="size-3.5" />
            {t('mail.rotationLabel')}
          </span>
          <Select
            value={selectedRotation}
            onChange={(e) => setSelectedRotation(e.target.value)}
            className="w-full sm:w-72"
          >
            {rotations.map((r) => {
              const n = r.rotation_number;
              const isCurrent = n === currentRotation;
              return (
                <option key={n} value={n}>
                  {isCurrent
                    ? t('mail.rotationOptionCurrent', { n })
                    : t('mail.rotationOption', { n })}
                </option>
              );
            })}
          </Select>
        </label>

        {rotationMeta && (
          <div className="text-xs text-[color:var(--color-fg-muted)] inline-flex items-center gap-1.5">
            <Calendar className="size-3.5" />
            {t('mail.rotationDates', {
              from: formatDateForDisplay(rotationMeta.start_date, i18n.language),
              to: formatDateForDisplay(rotationMeta.end_date, i18n.language),
            })}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        {/* To column ───────────────────────────────────────────────── */}
        <Card className="p-4 sm:p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] inline-flex items-center gap-1.5">
              <Users className="size-3.5" />
              {t('mail.toLabel', { count: studentEmails.length })}
            </span>
          </div>
          {loadingStudents ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-4 w-3/4" />
              ))}
            </div>
          ) : students.length === 0 ? (
            <p className="text-sm text-[color:var(--color-fg-muted)]">
              {t('mail.noStudents')}
            </p>
          ) : studentEmails.length === 0 ? (
            <p className="text-sm text-[color:var(--color-fg-muted)]">
              {t('mail.noEmails')}
            </p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {students.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <span className="truncate">{s.name}</span>
                  {s.email ? (
                    <span className="text-[11px] text-[color:var(--color-fg-subtle)] truncate">
                      {s.email}
                    </span>
                  ) : (
                    <Badge tone="warn" className="text-[10px]">
                      {t('common:labels.noData')}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
          {missingCount > 0 && (
            <div className="mt-3 text-[11px] text-[color:var(--color-warn)] inline-flex items-start gap-1.5">
              <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
              {t('mail.missingEmailWarning', { count: missingCount })}
            </div>
          )}
        </Card>

        {/* Cc column ───────────────────────────────────────────────── */}
        <Card className="p-4 sm:p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] inline-flex items-center gap-1.5">
              <Mail className="size-3.5" />
              {t('mail.ccLabel', { count: ccList.length })}
            </span>
          </div>
          <div className="space-y-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-fg-subtle)] mb-1">
                {t('mail.ccAlways')}
              </div>
              <div className="text-sm font-mono tabular">{COORDINATION_CC_DISPLAY}</div>
            </div>
            {collaborators.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-fg-subtle)] mb-1">
                  {t('mail.ccCollaborators')}
                </div>
                <ul className="space-y-1 text-sm">
                  {collaborators.map((c) => (
                    <li key={c.id} className="flex items-center gap-2">
                      <span className="truncate">{c.name}</span>
                      <span className="text-[11px] text-[color:var(--color-fg-subtle)] font-mono tabular truncate">
                        {c.email}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card className="p-4 sm:p-5 space-y-4">
        {/* From — informational only. mailto cannot enforce a sender, so we
            just remind the leader to confirm their mail app is on the right
            account. */}
        <div>
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] mb-2 inline-flex items-center gap-1.5">
            <AtSign className="size-3.5" />
            {t('mail.fromLabel')}
          </span>
          {leader?.email ? (
            <>
              <div className="text-sm font-mono tabular text-[color:var(--color-fg)]">
                {leader.email}
              </div>
              <p className="text-[11px] text-[color:var(--color-fg-muted)] mt-1">
                {t('mail.fromHint', { email: leader.email })}
              </p>
            </>
          ) : (
            <div className="text-[11px] text-[color:var(--color-warn)] inline-flex items-start gap-1.5">
              <AlertCircle className="size-3.5 mt-0.5 shrink-0" />
              {t('mail.fromMissing')}
            </div>
          )}
        </div>

        <div>
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)] mb-2 block">
            {t('mail.subjectLabel')}
          </span>
          <div className="text-sm font-medium text-[color:var(--color-fg)]">
            {subject}
          </div>
        </div>
        <Button
          variant="primary"
          onClick={handleOpen}
          disabled={!mailtoHref}
          className="w-full sm:w-auto"
        >
          <Send className="size-4" />
          {t('mail.sendButton')}
        </Button>
      </Card>
    </div>
  );
}

export default MailRotation;
