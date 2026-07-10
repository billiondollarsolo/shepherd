/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: {
    node: true,
    browser: true,
    es2022: true,
  },
  ignorePatterns: [
    'dist',
    // Generated TS declaration output (apps/web emits `.d.ts` here via tsc -b);
    // never lint generated code (e.g. TanStack Router's types emit bare `{}`).
    'dist-types',
    'build',
    'node_modules',
    'coverage',
    '*.config.ts',
    '*.config.js',
    '*.config.cjs',
    'playwright-report',
    'test-results',
    // Sibling experiment dirs that are NOT part of the pnpm workspace (apps/* +
    // packages/*). The CI lint gate (T13) covers the workspace; these are linted
    // by their own tooling if at all.
    'orca',
    'codex',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'error',
    'no-console': 'off',
    // This is a terminal cockpit: parsing/emitting raw VT escape & control
    // sequences (\x1b, \x00…) in regexes is intentional, not a bug.
    'no-control-regex': 'off',
    // React hooks: both rules guard real production bugs. Intentional partial
    // dependencies must be documented with a narrow inline disable.
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'error',
  },
  overrides: [
    {
      files: ['**/*.test.ts', '**/*.test.tsx'],
      env: { node: true },
      // Test fixtures define throwaway inline components/effects that don't follow
      // the component-naming convention — the hooks rules are for production code.
      rules: {
        'react-hooks/rules-of-hooks': 'off',
        'react-hooks/exhaustive-deps': 'off',
      },
    },
  ],
};
