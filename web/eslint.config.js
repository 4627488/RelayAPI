import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Data-loading effects synchronize state from external browser/network systems.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['src/components/app-providers.tsx', 'src/components/page-kit.tsx'],
    rules: {
      // These modules export a provider/kit plus the hook that reads its context.
      'react-refresh/only-export-components': 'off',
    },
  },
])
