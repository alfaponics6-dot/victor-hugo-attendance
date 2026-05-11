import { Code2, Mail } from 'lucide-react';
import { useTranslation } from 'react-i18next';

function Footer() {
  const { t } = useTranslation('common');
  return (
    <footer className="mt-12 border-t border-[color:var(--color-border)] pt-6 pb-4">
      <div className="mx-auto w-full max-w-[1480px] px-4 sm:px-6 lg:px-10 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="space-y-0.5">
          <p className="text-xs text-[color:var(--color-fg-subtle)]">
            © {new Date().getFullYear()} {t('app.university')} · {t('app.tagline')}
          </p>
          <p className="text-[11px] uppercase tracking-[0.16em] text-[color:var(--color-fg-subtle)]">
            {t('app.name')}
          </p>
        </div>
        <div className="flex flex-col items-start md:items-end gap-1 text-xs">
          <div className="flex items-center gap-1.5 text-[color:var(--color-fg-muted)] flex-wrap">
            <Code2 className="size-3.5" />
            <span className="font-medium text-[color:var(--color-fg)]">Carly Chery</span>
            <span className="text-[color:var(--color-fg-subtle)]">· Full Stack Developer</span>
          </div>
          <a
            href="mailto:cchery@earth.ac.cr"
            className="flex items-center gap-1.5 text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-accent)] transition-colors"
          >
            <Mail className="size-3.5" /> cchery@earth.ac.cr
          </a>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
