/**
 * ECMA-426 Source Map Specification Conformance Tests
 *
 * This test suite runs against the official tc39/source-map-tests test vectors
 * to ensure 100% compliance with the ECMA-426 Source Map specification.
 *
 * @see https://tc39.es/ecma426/
 * @see https://github.com/tc39/source-map-tests
 *
 * The test suite requires the tc39/source-map-tests git submodule to be initialized:
 *   git submodule update --init --recursive
 *
 * If the submodule is not present, tests will be skipped with a helpful message.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSourceMap } from '../src/parser.js';

// ============================================================================
// TYPES FOR TC39 SPEC TEST FORMAT
// ============================================================================

interface SpecTestAction {
    actionType: string;
    generatedLine?: number;
    generatedColumn?: number;
    originalSource?: string | null;
    originalLine?: number | null;
    originalColumn?: number | null;
    originalName?: string | null;
    present?: string[];
    absent?: string[];
}

interface SpecTest {
    name: string;
    description: string;
    baseFile: string;
    sourceMapFile: string;
    sourceMapIsValid: boolean;
    testActions?: SpecTestAction[];
}

interface SpecTestSuite {
    tests: SpecTest[];
}

// ============================================================================
// PATHS
// ============================================================================

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SUBMODULE_PATH = path.join(REPO_ROOT, 'vendor/source-map-tests');
const SPEC_TESTS_JSON = path.join(SUBMODULE_PATH, 'source-map-spec-tests.json');
const RESOURCES_PATH = path.join(SUBMODULE_PATH, 'resources');

// ============================================================================
// SUBMODULE CHECK
// ============================================================================

function isSubmoduleInitialized(): boolean {
    try {
        return fs.existsSync(SPEC_TESTS_JSON) && fs.existsSync(RESOURCES_PATH);
    } catch {
        return false;
    }
}

function loadSpecTests(): SpecTestSuite | null {
    if (!isSubmoduleInitialized()) {
        return null;
    }
    try {
        const content = fs.readFileSync(SPEC_TESTS_JSON, 'utf-8');
        return JSON.parse(content) as SpecTestSuite;
    } catch {
        return null;
    }
}

function loadSourceMap(filename: string): unknown | null {
    try {
        const filePath = path.join(RESOURCES_PATH, filename);
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

// ============================================================================
// TEST CATEGORIES
// These help organize tests and identify which spec areas need work
// ============================================================================

type TestCategory =
    | 'version'
    | 'sources'
    | 'sourcesContent'
    | 'mappings'
    | 'names'
    | 'file'
    | 'sourceRoot'
    | 'ignoreList'
    | 'indexMap'
    | 'other';

function categorizeTest(name: string): TestCategory {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('version')) return 'version';
    if (
        lowerName.includes('sourcescontent') ||
        lowerName.includes('sources-content')
    )
        return 'sourcesContent';
    if (lowerName.startsWith('sources') || lowerName.includes('sources'))
        return 'sources';
    if (lowerName.startsWith('mapping') || lowerName.includes('mapping'))
        return 'mappings';
    if (lowerName.startsWith('names') || lowerName.includes('name'))
        return 'names';
    if (lowerName.startsWith('file')) return 'file';
    if (lowerName.includes('sourceroot') || lowerName.includes('source-root'))
        return 'sourceRoot';
    if (lowerName.includes('ignorelist') || lowerName.includes('ignore-list'))
        return 'ignoreList';
    if (lowerName.includes('indexmap') || lowerName.includes('index-map'))
        return 'indexMap';
    return 'other';
}

// ============================================================================
// KNOWN LIMITATIONS
// Tests that our current implementation doesn't handle yet
// ============================================================================

/**
 * Known limitations of our current parser:
 *
 * All ECMA-426 spec tests are now implemented! This set is empty.
 */
const KNOWN_LIMITATIONS: Set<string> = new Set([
    // All spec tests implemented!
]);

// ============================================================================
// TEST SUITE
// ============================================================================

describe('ECMA-426 Source Map Specification Conformance', () => {
    let specTests: SpecTestSuite | null = null;

    beforeAll(() => {
        specTests = loadSpecTests();
    });

    it('should have tc39/source-map-tests submodule initialized', () => {
        if (!isSubmoduleInitialized()) {
            console.warn(
                '\n' +
                    '='.repeat(70) +
                    '\n' +
                    'ECMA-426 SPEC TESTS SKIPPED\n' +
                    '='.repeat(70) +
                    '\n\n' +
                    'The tc39/source-map-tests git submodule is not initialized.\n' +
                    'To run spec conformance tests, initialize the submodule:\n\n' +
                    '  git submodule update --init --recursive\n\n' +
                    'Or clone with submodules:\n\n' +
                    '  git clone --recurse-submodules <repo-url>\n\n' +
                    '='.repeat(70) +
                    '\n',
            );
            // Skip rather than fail - this allows CI to pass without submodule
            // when running basic tests
            expect(true).toBe(true);
            return;
        }
        expect(specTests).not.toBeNull();
        expect(specTests!.tests.length).toBeGreaterThan(0);
    });

    describe('Validation Tests', () => {
        // Group tests by category for better organization
        const testsByCategory = new Map<TestCategory, SpecTest[]>();

        beforeAll(() => {
            if (!specTests) return;

            for (const test of specTests.tests) {
                const category = categorizeTest(test.name);
                if (!testsByCategory.has(category)) {
                    testsByCategory.set(category, []);
                }
                testsByCategory.get(category)!.push(test);
            }
        });

        it.skipIf(!isSubmoduleInitialized())(
            'should load all spec test fixtures',
            () => {
                if (!specTests) return;

                let loadedCount = 0;
                let failedCount = 0;

                for (const test of specTests.tests) {
                    const sourceMap = loadSourceMap(test.sourceMapFile);
                    if (sourceMap !== null) {
                        loadedCount++;
                    } else {
                        failedCount++;
                        console.warn(`Failed to load: ${test.sourceMapFile}`);
                    }
                }

                expect(failedCount).toBe(0);
                expect(loadedCount).toBe(specTests.tests.length);
            },
        );

        // Run each spec test
        describe.skipIf(!isSubmoduleInitialized())('Individual Tests', () => {
            // This will be populated after beforeAll runs
            const runTests = () => {
                const tests = loadSpecTests();
                if (!tests) return [];
                return tests.tests;
            };

            // Use a factory function to generate tests
            const allTests = runTests();

            for (const test of allTests) {
                const isKnownLimitation = KNOWN_LIMITATIONS.has(test.name);
                const testFn = isKnownLimitation ? it.skip : it;

                testFn(`${test.name}: ${test.description}`, () => {
                    const sourceMap = loadSourceMap(test.sourceMapFile);
                    expect(sourceMap).not.toBeNull();

                    const result = validateSourceMap(sourceMap);

                    if (test.sourceMapIsValid) {
                        expect(
                            result.valid,
                            `Expected valid source map but got errors: ${result.errors.map((e) => e.message).join(', ')}`,
                        ).toBe(true);
                    } else {
                        expect(
                            result.valid,
                            `Expected invalid source map but validation passed`,
                        ).toBe(false);
                    }
                });
            }
        });
    });

    // Summary of test coverage
    describe.skipIf(!isSubmoduleInitialized())('Coverage Summary', () => {
        it('should report spec test coverage', () => {
            if (!specTests) return;

            const total = specTests.tests.length;
            const knownLimitations = specTests.tests.filter((t) =>
                KNOWN_LIMITATIONS.has(t.name),
            ).length;
            const implemented = total - knownLimitations;

            console.log('\n' + '='.repeat(70));
            console.log('ECMA-426 Spec Test Coverage');
            console.log('='.repeat(70));
            console.log(`Total spec tests:     ${total}`);
            console.log(
                `Implemented:          ${implemented} (${((implemented / total) * 100).toFixed(1)}%)`,
            );
            console.log(`Known limitations:    ${knownLimitations}`);
            console.log('='.repeat(70) + '\n');

            // Count by category
            const categoryCounts = new Map<
                TestCategory,
                { total: number; implemented: number }
            >();
            for (const test of specTests.tests) {
                const category = categorizeTest(test.name);
                if (!categoryCounts.has(category)) {
                    categoryCounts.set(category, { total: 0, implemented: 0 });
                }
                const counts = categoryCounts.get(category)!;
                counts.total++;
                if (!KNOWN_LIMITATIONS.has(test.name)) {
                    counts.implemented++;
                }
            }

            console.log('Coverage by category:');
            for (const [category, counts] of categoryCounts) {
                const pct = ((counts.implemented / counts.total) * 100).toFixed(
                    0,
                );
                console.log(
                    `  ${category.padEnd(15)} ${counts.implemented}/${counts.total} (${pct}%)`,
                );
            }
            console.log('');

            // This test always passes - it's just for reporting
            expect(true).toBe(true);
        });
    });
});
