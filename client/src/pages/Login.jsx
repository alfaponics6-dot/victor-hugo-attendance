import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronDown,
  Lock,
  KeyRound,
  ArrowRight,
  Loader2,
  AlertCircle,
  RefreshCw,
  Sparkles,
  ShieldCheck,
  Activity,
} from 'lucide-react';
import { useAuth } from '../context/useAuth.js';
import { getLeaders, login } from '../api/client';
import Footer from '../components/common/Footer';
import LanguageSwitcher from '../components/ui/LanguageSwitcher';
import ThemeToggle from '../components/ui/ThemeToggle';
import { useTheme } from '../lib/useTheme';
import { cn } from '../lib/cn';
import { getProjectLabel } from '../lib/projectI18n';

/* ---------- small presentational atoms ---------------------------------- */

const FieldLabel = ({ htmlFor, children }) => (
  <label
    htmlFor={htmlFor}
    className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-[color:var(--color-fg-subtle)]"
  >
    {children}
  </label>
);

/* A faint, animated sparkline — decorative only.
   Hidden on phones (the hero panel itself is hidden < lg:); rendering this
   on small screens would just be confusing fake data. Fills its container
   exactly via `inset-0`; the previous bottom-10/h-28 combo left a ~40px
   strip of empty surface below the curve. */
const HeroSparkline = () => {
  const points = useMemo(() => {
    const seed = [0.42, 0.55, 0.48, 0.62, 0.58, 0.71, 0.66, 0.78, 0.72, 0.88, 0.83, 0.95];
    return seed.map((y, i) => `${(i / (seed.length - 1)) * 100},${(1 - y) * 100}`).join(' ');
  }, []);
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="absolute inset-0 w-full h-full opacity-60"
      aria-hidden
    >
      <defs>
        <linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.45" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sparkLine" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="var(--color-accent)" />
          <stop offset="100%" stopColor="var(--color-accent-2)" />
        </linearGradient>
      </defs>
      <motion.polyline
        points={points}
        fill="none"
        stroke="url(#sparkLine)"
        strokeWidth="0.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 1.8, ease: [0.25, 1, 0.5, 1], delay: 0.4 }}
        vectorEffect="non-scaling-stroke"
      />
      <motion.polygon
        points={`0,100 ${points} 100,100`}
        fill="url(#sparkFill)"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.2, delay: 1.4 }}
      />
    </svg>
  );
};

/* ---------- the page --------------------------------------------------- */

function Login() {
  const { t } = useTranslation(['login', 'common']);
  // Separate `t` scoped to the `projects` namespace so the helper resolves
  // p1/p5/... straight against the locale file.
  const { t: tProject } = useTranslation('projects');
  const [leaders, setLeaders] = useState([]);
  const [selectedLeaderId, setSelectedLeaderId] = useState('');
  const [password, setPassword] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [credentialMode, setCredentialMode] = useState('none'); // 'none' | 'password' | 'accessCode'
  const [loading, setLoading] = useState(false);
  const [loadingLeaders, setLoadingLeaders] = useState(true);
  const [error, setError] = useState('');
  const { loginLeader } = useAuth();
  const navigate = useNavigate();
  const { isDark } = useTheme();

  useEffect(() => {
    fetchLeadersWithRetry();
  }, []);

  // Make the body transparent on the login page only. index.css paints an
  // opaque gradient on the body that sits above our fixed -z-10 bg div, so
  // without this the photo is invisible. Restore on unmount so other pages
  // keep their nice dark theme gradient.
  useEffect(() => {
    const body = document.body;
    const prev = body.style.cssText;
    body.style.background = 'transparent';
    return () => { body.style.cssText = prev; };
  }, []);

  const fetchLeadersWithRetry = async (retries = 3, delay = 1000) => {
    setLoadingLeaders(true);
    setError('');

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const data = await getLeaders();
        setLeaders(data);
        setLoadingLeaders(false);
        return;
      } catch (err) {
        console.error(`Error fetching leaders (attempt ${attempt}/${retries}):`, err);

        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          setError(t('errors.leadersLoadFailed'));
          setLoadingLeaders(false);
        }
      }
    }
  };

  const handleLeaderSelect = (e) => {
    const leaderId = e.target.value;
    setSelectedLeaderId(leaderId);

    if (leaderId) {
      const leader = leaders.find((l) => l.id === parseInt(leaderId));
      if (leader?.role === 'admin' || leader?.role === 'profesor') {
        setCredentialMode('password');
      } else {
        setCredentialMode('accessCode');
      }
    } else {
      setCredentialMode('none');
    }
    setPassword('');
    setAccessCode('');
    setError('');
  };

  const handleLogin = async (e) => {
    e.preventDefault();

    if (!selectedLeaderId) {
      setError(t('errors.selectName'));
      return;
    }

    if (credentialMode === 'password' && !password) {
      setError(t('errors.needPassword'));
      return;
    }
    if (credentialMode === 'accessCode' && !accessCode) {
      setError(t('errors.needAccessCode'));
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await login(selectedLeaderId, { password, accessCode });
      loginLeader(response.leader);

      if (response.leader.role === 'admin') {
        navigate('/admin');
      } else if (response.leader.role === 'profesor') {
        navigate('/profesor');
      } else {
        navigate('/dashboard');
      }
    } catch (err) {
      const serverError = err.response?.data?.error;
      if (serverError === 'Invalid password') {
        setError(t('errors.wrongPassword'));
      } else if (serverError === 'Invalid access code') {
        setError(t('errors.wrongAccessCode'));
      } else {
        setError(t('errors.loginFailed'));
      }
      console.error('Login error:', err);
    } finally {
      setLoading(false);
    }
  };

  const selectedLeader = useMemo(
    () => leaders.find((l) => l.id === parseInt(selectedLeaderId)),
    [leaders, selectedLeaderId]
  );

  /* shared field motion config */
  const fieldVariants = {
    hidden: { opacity: 0, y: 8 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <div className="relative min-h-screen flex flex-col overflow-x-hidden">
      {/* Background image — only in dark mode. The photo is a moody sunset
          shot that clashes with the light theme's bright/clean palette.
          When isDark is false, we fall through to the html element's light
          --color-bg painting (handled by the body-transparent useEffect). */}
      {isDark && (
        <>
          <div
            aria-hidden
            className="pointer-events-none fixed inset-0 -z-10 bg-cover bg-center"
            style={{
              backgroundImage: "url('/login-bg.jpg')",
              filter: 'blur(3px) brightness(0.85) saturate(1.1)',
              transform: 'scale(1.04)',
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none fixed inset-0 -z-10 bg-gradient-to-b from-black/15 via-black/20 to-black/30"
          />
        </>
      )}

      {/* faint global grid pattern — still works on top of the photo,
          just with a quieter opacity since the bg already provides texture. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.05] sm:opacity-[0.07] lg:opacity-[0.10]"
        style={{
          backgroundImage:
            'linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage:
            'radial-gradient(ellipse 80% 60% at 50% 40%, black 30%, transparent 80%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 80% 60% at 50% 40%, black 30%, transparent 80%)',
        }}
      />

      {/* Top-right language switcher - Login has no header bar, so it floats. */}
      <div className="absolute top-4 right-4 sm:top-6 sm:right-6 z-20 flex items-center gap-2">
        <ThemeToggle />
        <LanguageSwitcher />
      </div>

      {/* pt-20 on phones leaves room for the absolute LanguageSwitcher
          (top-4 + ~44 px button = ~64 px reserved) so the login card top
          never tucks under it. From sm: onward there's enough viewport
          height that items-center keeps a natural gap. */}
      <main className="relative flex-1 flex items-center justify-center px-4 pt-20 pb-8 sm:px-6 sm:py-12 lg:px-10">
        <div className="w-full max-w-[1200px] grid grid-cols-1 lg:grid-cols-[1.05fr_1fr] gap-10 lg:gap-16 items-center">

          {/* ===================== HERO COLUMN ===================== */}
          <motion.section
            initial="hidden"
            animate="visible"
            variants={{
              hidden: { opacity: 0 },
              visible: { opacity: 1, transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
            }}
            className="relative hidden lg:flex flex-col gap-6 overflow-hidden"
          >
            {/* Decorative accent orbs were here on the plain dark background;
                with the bg photo behind everything they just covered up the
                image. The photo carries the visual atmosphere now. */}

            <div className="relative z-10 space-y-6">
              <motion.h1
                variants={fieldVariants}
                className="text-5xl xl:text-6xl font-semibold leading-[1.05] tracking-tight text-balance"
              >
                {t('hero.titleLead')}{' '}
                <span className="gradient-text">{t('hero.titleAccent')}</span>
                <br />
                <span className="text-[color:var(--color-fg-muted)] font-light">
                  {t('hero.titleSubheading')}
                </span>
              </motion.h1>

              <motion.p
                variants={fieldVariants}
                className="max-w-[460px] text-base leading-relaxed text-[color:var(--color-fg-muted)]"
              >
                {t('hero.subtitle')}
              </motion.p>

              <motion.div
                variants={fieldVariants}
                className="flex flex-wrap gap-3 pt-2"
              >
                {[
                  { Icon: Activity, key: 'realtime' },
                  { Icon: ShieldCheck, key: 'secure' },
                  { Icon: Sparkles, key: 'data' },
                ].map((chip) => (
                  <span
                    key={chip.key}
                    className="inline-flex items-center gap-1.5 rounded-lg surface-flat px-2.5 py-1.5 text-xs text-[color:var(--color-fg-muted)]"
                  >
                    <chip.Icon className="size-3.5 text-[color:var(--color-accent)]" />
                    {t(`hero.features.${chip.key}`)}
                  </span>
                ))}
              </motion.div>
            </div>

            {/* Decorative stats panel — desktop only.
                On phones the hero column already takes the whole screen and
                fake "live" numbers feel out of place. We keep it on lg+ as
                marketing-flavoured chrome; the numbers are clearly stylised
                so anyone evaluating them as truth would see the inconsistency
                immediately (the dashboards have the real charts). */}
            {/* Sparkline lives as a flush sub-region of the hero column —
                no `surface` wrapper because that made it read as a separate
                floating card overlapping the parent. Just a top divider +
                inline numbers + edge-to-edge SVG below. */}
            <motion.div
              variants={fieldVariants}
              className="hidden lg:block relative z-10 pt-6 max-w-md border-t border-[color:var(--color-border)]"
              aria-hidden="true"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-[color:var(--color-fg-subtle)]">
                    {t('hero.statLabel')}
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-2xl font-semibold tabular tracking-tight">
                      94.2<span className="text-[color:var(--color-fg-subtle)] text-base">%</span>
                    </span>
                    <span className="text-[11px] font-medium tabular text-[color:var(--color-success)]">
                      ▲ 2.4
                    </span>
                  </div>
                </div>
                <div className="text-[10px] font-medium tabular text-[color:var(--color-fg-subtle)] shrink-0">
                  {t('hero.statCaption')}
                </div>
              </div>
              <div className="relative h-16">
                <HeroSparkline />
              </div>
            </motion.div>
          </motion.section>

          {/* ===================== LOGIN CARD COLUMN ===================== */}
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.25, 1, 0.5, 1] }}
            className="relative w-full max-w-md sm:max-w-[460px] mx-auto"
          >
            {/* Pulsing accent border behind the card */}
            <motion.div
              aria-hidden
              className="absolute -inset-px rounded-[24px] sm:rounded-[28px] opacity-60 blur-md pointer-events-none"
              animate={{ opacity: [0.35, 0.7, 0.35] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
              style={{
                background:
                  'linear-gradient(135deg, color-mix(in oklch, var(--color-accent) 40%, transparent), color-mix(in oklch, var(--color-accent-2) 40%, transparent))',
              }}
            />

            {/* Inline `background` overrides the `surface` utility's 88 %
                opacity. ~62 % lets the bg photo show through more clearly
                while keeping form text readable against the bigger
                backdrop-blur. */}
            <div
              className="relative surface rounded-2xl sm:rounded-3xl p-6 sm:p-8 lg:p-10"
              style={{ background: 'color-mix(in oklch, var(--color-surface) 62%, transparent)' }}
            >
              {/* Logo + heading */}
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.1 }}
                className="flex flex-col items-center text-center mb-6 sm:mb-8"
              >
                <div className="relative mb-4 sm:mb-5">
                  <div
                    aria-hidden
                    className="absolute inset-0 -m-2 rounded-full blur-xl opacity-50"
                    style={{
                      background:
                        'radial-gradient(circle, color-mix(in oklch, var(--color-accent) 40%, transparent), transparent 70%)',
                    }}
                  />
                  <img
                    src="/Logo-Universidad-EARTH_academico-300x257.png"
                    alt="Universidad EARTH"
                    className="themed-logo relative size-10 sm:size-12 object-contain"
                  />
                </div>
                <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-balance">
                  {t('welcomeBack')}
                </h2>
                <p className="mt-1.5 text-[13px] sm:text-sm text-[color:var(--color-fg-muted)]">
                  {t('subtitle')}
                </p>
              </motion.div>

              <form onSubmit={handleLogin} autoComplete="off" className="space-y-4 sm:space-y-5">
                {/* ----------- Leader select ----------- */}
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.45, delay: 0.18 }}
                >
                  <FieldLabel htmlFor="leader-select">{t('fields.identity')}</FieldLabel>
                  <div className="relative group">
                    <select
                      id="leader-select"
                      value={selectedLeaderId}
                      onChange={handleLeaderSelect}
                      disabled={loading || loadingLeaders}
                      className={cn(
                        'peer w-full h-12 sm:h-12 pl-4 pr-10 rounded-xl text-sm appearance-none cursor-pointer',
                        'bg-[color:var(--color-bg-2)] border border-[color:var(--color-border)]',
                        'text-[color:var(--color-fg)]',
                        'transition-[border-color,box-shadow,background] duration-150 ease-out',
                        'hover:border-[color:var(--color-border-strong)]',
                        'focus:outline-none focus:border-[color:var(--color-accent)]',
                        'focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-accent)_18%,transparent)]',
                        'disabled:opacity-60 disabled:cursor-not-allowed'
                      )}
                    >
                      {loadingLeaders ? (
                        <option>{t('fields.loadingLeaders')}</option>
                      ) : (
                        <>
                          <option value="">{t('fields.selectLeader')}</option>
                          {leaders.map((leader) => (
                            <option key={leader.id} value={leader.id}>
                              {leader.name}
                              {' - '}
                              {leader.role === 'admin'
                                ? t('optionRole.admin')
                                : leader.role === 'profesor'
                                ? t('optionRole.profesor')
                                : getProjectLabel(tProject, leader)}
                            </option>
                          ))}
                        </>
                      )}
                    </select>
                    <div className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 flex items-center gap-1 text-[color:var(--color-fg-subtle)] peer-focus:text-[color:var(--color-accent)] transition-colors">
                      {loadingLeaders ? (
                        <Loader2 className="size-4 animate-spin-slow" />
                      ) : (
                        <ChevronDown className="size-4" />
                      )}
                    </div>
                  </div>
                  {/* Tiny role hint */}
                  <AnimatePresence mode="wait">
                    {selectedLeader && (
                      <motion.div
                        key={selectedLeader.id}
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.2 }}
                        className="mt-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-[color:var(--color-fg-subtle)]"
                      >
                        <span className="size-1 rounded-full bg-[color:var(--color-accent)] shrink-0" />
                        <span className="truncate">
                          {selectedLeader.role === 'admin'
                            ? t('roleHint.admin')
                            : selectedLeader.role === 'profesor'
                            ? t('roleHint.profesor')
                            : t('roleHint.leader', {
                                project:
                                  getProjectLabel(tProject, selectedLeader) ||
                                  t('roleHint.leaderFallback'),
                              })}
                        </span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>

                {/* ----------- Credential field (animated swap) ----------- */}
                <AnimatePresence mode="wait" initial={false}>
                  {credentialMode !== 'none' && (
                    <motion.div
                      key={credentialMode}
                      initial={{ opacity: 0, y: 6, height: 0 }}
                      animate={{ opacity: 1, y: 0, height: 'auto' }}
                      exit={{ opacity: 0, y: -6, height: 0 }}
                      transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="pt-0.5">
                        <FieldLabel
                          htmlFor={
                            credentialMode === 'password'
                              ? 'password-input'
                              : 'access-code-input'
                          }
                        >
                          {credentialMode === 'password' ? t('fields.password') : t('fields.accessCode')}
                        </FieldLabel>
                        <div className="relative">
                          <div className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[color:var(--color-fg-subtle)]">
                            {credentialMode === 'password' ? (
                              <Lock className="size-4" />
                            ) : (
                              <KeyRound className="size-4" />
                            )}
                          </div>
                          <input
                            type="password"
                            id={
                              credentialMode === 'password'
                                ? 'password-input'
                                : 'access-code-input'
                            }
                            name={
                              credentialMode === 'password'
                                ? 'password-login'
                                : 'access-code-login'
                            }
                            value={credentialMode === 'password' ? password : accessCode}
                            onChange={(e) =>
                              credentialMode === 'password'
                                ? setPassword(e.target.value)
                                : setAccessCode(e.target.value)
                            }
                            placeholder={
                              credentialMode === 'password'
                                ? t('fields.passwordPlaceholder')
                                : t('fields.accessCodePlaceholder')
                            }
                            disabled={loading}
                            autoComplete="off"
                            autoFocus
                            className={cn(
                              'w-full h-12 pl-10 pr-3 rounded-xl text-[16px] sm:text-sm font-mono tracking-wider',
                              'bg-[color:var(--color-bg-2)] border border-[color:var(--color-border)]',
                              'placeholder:text-[color:var(--color-fg-subtle)] placeholder:font-sans placeholder:tracking-normal placeholder:text-sm',
                              'transition-[border-color,box-shadow,background] duration-150 ease-out',
                              'hover:border-[color:var(--color-border-strong)]',
                              'focus:outline-none focus:border-[color:var(--color-accent)]',
                              'focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-accent)_18%,transparent)]',
                              'disabled:opacity-60 disabled:cursor-not-allowed'
                            )}
                          />
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* ----------- Error pill ----------- */}
                <AnimatePresence>
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, y: -4, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.98 }}
                      transition={{ duration: 0.22 }}
                      className={cn(
                        'flex items-start gap-2.5 rounded-xl px-3 sm:px-3.5 py-2.5 text-[13px] sm:text-sm',
                        'border border-[color-mix(in_oklch,var(--color-danger)_45%,transparent)]',
                        'bg-[color-mix(in_oklch,var(--color-danger)_15%,transparent)]',
                        'text-[color-mix(in_oklch,var(--color-danger)_85%,white_15%)]',
                        'backdrop-blur-md'
                      )}
                    >
                      <AlertCircle className="size-4 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0 break-words">{error}</div>
                      {leaders.length === 0 && (
                        <button
                          type="button"
                          onClick={() => fetchLeadersWithRetry()}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-[color:var(--color-fg)] hover:bg-[color-mix(in_oklch,white_10%,transparent)] transition-colors shrink-0"
                        >
                          <RefreshCw className="size-3" />
                          {t('common:actions.retry')}
                        </button>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* ----------- Submit ----------- */}
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.32 }}
                  className="pt-1"
                >
                  <button
                    type="submit"
                    disabled={loading || loadingLeaders}
                    className={cn(
                      'group relative w-full h-12 rounded-xl overflow-hidden',
                      'inline-flex items-center justify-center gap-2',
                      'font-medium tracking-tight text-[oklch(0.18_0.02_260)]',
                      'transition-[transform,box-shadow,filter] duration-150 ease-out',
                      'active:scale-[0.99]',
                      'disabled:opacity-60 disabled:pointer-events-none',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]',
                      'shadow-[0_1px_0_oklch(100%_0_0/.18)_inset,0_10px_30px_-10px_color-mix(in_oklch,var(--color-accent)_60%,transparent)]'
                    )}
                    style={{
                      background:
                        'linear-gradient(135deg, var(--color-accent), color-mix(in oklch, var(--color-accent) 60%, var(--color-accent-2)))',
                    }}
                  >
                    {/* shimmer */}
                    <span
                      aria-hidden
                      className="absolute inset-0 -translate-x-full group-hover:translate-x-full transition-transform duration-700 ease-out pointer-events-none"
                      style={{
                        background:
                          'linear-gradient(90deg, transparent, color-mix(in oklch, white 35%, transparent), transparent)',
                      }}
                    />
                    {loading ? (
                      <>
                        <Loader2 className="size-4 animate-spin-slow" />
                        <span>{t('footer.loadingSession')}</span>
                      </>
                    ) : (
                      <>
                        <span>{t('common:actions.continue')}</span>
                        <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                      </>
                    )}
                  </button>
                </motion.div>

                {/* ----------- Subtle helper text ----------- */}
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5, delay: 0.45 }}
                  className="flex items-center justify-center gap-1.5 text-[11px] text-[color:var(--color-fg-subtle)] pt-1 text-center"
                >
                  <ShieldCheck className="size-3 shrink-0" />
                  <span>{t('footer.encrypted')}</span>
                </motion.p>
              </form>
            </div>
          </motion.section>
        </div>
      </main>

      <div className="mt-6 sm:mt-8">
        <Footer />
      </div>
    </div>
  );
}

export default Login;
