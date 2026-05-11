import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  // vite.config.js runs in node, not the browser - it has access to `process`.
  {
    files: ['vite.config.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // `^[A-Z_]` covers components and SCREAM_CASE constants. We also need
      // a couple of lowercase namespace imports that ESLint's stock rules
      // can't detect because they're used as `<motion.div>` / `<AnimatePresence>`
      // in JSX rather than as bare identifiers. Without `eslint-plugin-react`
      // installed, the simplest fix is to whitelist them by name.
      'no-unused-vars': ['error', {
        varsIgnorePattern: '^([A-Z_]|motion|AnimatePresence)',
        // Same pattern applies to function-argument destructuring like
        // `({ icon: Icon })` — common when forwarding lucide-react icons.
        argsIgnorePattern: '^[A-Z_]',
      }],
    },
  },
])
