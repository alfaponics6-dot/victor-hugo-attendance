import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Discover every namespace JSON under src/locales/<lang>/<ns>.json. Each agent
// (Login, Leader, Admin, Profesor) drops files into their own namespace -
// they show up here automatically with no central registration.
const modules = import.meta.glob('../locales/**/*.json', { eager: true });

const resources = {};
const namespaces = new Set();

for (const [filePath, mod] of Object.entries(modules)) {
  // filePath looks like "../locales/es/login.json"
  const match = filePath.match(/\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!match) continue;
  const [, lng, ns] = match;
  if (!resources[lng]) resources[lng] = {};
  resources[lng][ns] = mod.default || mod;
  namespaces.add(ns);
}

const SUPPORTED = ['es', 'en', 'fr', 'pt'];

export const LANGUAGES = [
  { code: 'es', label: 'Español', short: 'ES', flag: '🇪🇸' },
  { code: 'en', label: 'English', short: 'EN', flag: '🇺🇸' },
  { code: 'fr', label: 'Français', short: 'FR', flag: '🇫🇷' },
  { code: 'pt', label: 'Português', short: 'PT', flag: '🇧🇷' },
];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'es',
    supportedLngs: SUPPORTED,
    ns: [...namespaces],
    defaultNS: 'common',
    fallbackNS: 'common',
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
    },
    returnNull: false,
    returnEmptyString: false,
  });

export default i18n;
