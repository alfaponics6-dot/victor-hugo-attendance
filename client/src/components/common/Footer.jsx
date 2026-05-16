import { Code2, Mail } from 'lucide-react';
import { useTranslation } from 'react-i18next';

function Footer() {
  const { t } = useTranslation('common');
  return (
    <footer
      className="
        mt-6 sm:mt-8 lg:mt-12
        border-t border-[color:var(--color-border)]
        py-3 sm:py-4
        pb-[max(0.75rem,env(safe-area-inset-bottom))]
      "
    >
      <div
        className="
          mx-auto w-full max-w-[1480px]
          px-4 sm:px-6 lg:px-10
          flex flex-col items-center gap-2 text-center
          sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:text-left
        "
      >
        {/* Left/top block: institution + tagline. Single line on desktop,
            stacked tightly on mobile so the footer height stays low. */}
        <div className="flex flex-col items-center sm:items-start gap-0.5 min-w-0">
          <p className="text-[11px] sm:text-xs text-[color:var(--color-fg-subtle)] leading-tight">
            © {new Date().getFullYear()} {t('app.university')} · {t('app.tagline')}
          </p>
          <p className="text-[10px] uppercase tracking-[0.16em] text-[color:var(--color-fg-subtle)] leading-tight">
            {t('app.name')}
          </p>
        </div>

        {/* Right/bottom block: developer credit + email. Inline on desktop
            (single line, fewer wrapping issues at tablet width); stacked
            with comfortable touch targets on mobile. */}
        <div
          className="
            flex flex-col items-center gap-1
            sm:flex-row sm:items-center sm:gap-2
            text-[11px] sm:text-xs
            text-[color:var(--color-fg-muted)]
          "
        >
          <span className="flex items-center gap-1.5">
            <Code2 className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="font-medium text-[color:var(--color-fg)]">Carly Chery</span>
            <span className="text-[color:var(--color-fg-subtle)]">· Full Stack Developer</span>
          </span>
          <a
            href="mailto:cchery@earth.ac.cr"
            className="flex items-center gap-1.5 text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-accent)] transition-colors"
          >
            <Mail className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="whitespace-nowrap">cchery@earth.ac.cr</span>
          </a>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
