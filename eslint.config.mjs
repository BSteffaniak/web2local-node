import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';
import globals from 'globals';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all,
});

const tsFiles = ['**/*.ts', '**/*.tsx'];
const jsFiles = ['**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs'];

export default [
    {
        ignores: [
            'dist/',
            'node_modules/',
            'output/',
            'debug-output/',
            'test-output/',
        ],
    },
    ...compat.extends(
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
    ),
    {
        plugins: {
            '@typescript-eslint': typescriptEslint,
        },
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: 'module',

            parserOptions: {
                project: ['./tsconfig.eslint.json'],
            },
        },
        rules: {
            'import/prefer-default-export': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'default',
                    format: ['camelCase'],
                    leadingUnderscore: 'allow',
                    trailingUnderscore: 'forbid',
                },
                {
                    selector: 'variable',
                    format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
                    leadingUnderscore: 'allow',
                    trailingUnderscore: 'forbid',
                },
                {
                    selector: 'typeLike',
                    format: ['PascalCase'],
                },
            ],
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/no-namespace': 'off',
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'TSEnumDeclaration',
                    message:
                        'Use const objects with `as const` instead of enums. See: https://www.typescriptlang.org/docs/handbook/enums.html#objects-vs-enums',
                },
            ],
        },
        files: [...tsFiles],
    },
    {
        files: [...jsFiles, ...tsFiles],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            '@typescript-eslint/naming-convention': [
                'error',
                {
                    selector: 'objectLiteralProperty',
                    format: null,

                    custom: {
                        regex: '.+',
                        match: true,
                    },
                },
            ],
        },
    },
];
