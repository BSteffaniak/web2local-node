import { describe, it, expect } from 'vitest';
import {
    analyzeImportUsage,
    aggregateImportUsage,
    type ImportUsageInfo,
} from '@web2local/analyzer';

describe('analyzeImportUsage', () => {
    describe('member expression detection', () => {
        it('should detect simple member access (Foo.bar)', () => {
            const code = `
                import { Foo } from 'some-package';
                const x = Foo.bar;
            `;
            const result = analyzeImportUsage(code, 'test.ts');

            expect(result).toHaveLength(1);
            expect(result[0].source).toBe('some-package');
            expect(result[0].namedImports).toHaveLength(1);
            expect(result[0].namedImports[0].localName).toBe('Foo');
            expect(result[0].namedImports[0].memberAccesses).toContain('bar');
        });

        it('should detect multiple member accesses from same import', () => {
            const code = `
                import { InventoryTag } from 'sarsaparilla';
                const x = InventoryTag.Camping;
                const y = InventoryTag.DayUse;
                const z = InventoryTag.Permit;
            `;
            const result = analyzeImportUsage(code, 'test.tsx');

            expect(result).toHaveLength(1);
            const namedImport = result[0].namedImports[0];
            expect(namedImport.localName).toBe('InventoryTag');
            expect(namedImport.memberAccesses).toContain('Camping');
            expect(namedImport.memberAccesses).toContain('DayUse');
            expect(namedImport.memberAccesses).toContain('Permit');
        });

        it('should detect member access in function calls', () => {
            const code = `
                import { SecurityHelper } from 'sarsaparilla';
                const token = SecurityHelper.getAuthHeader();
                const loggedIn = SecurityHelper.isLoggedIn();
            `;
            const result = analyzeImportUsage(code, 'test.ts');

            const namedImport = result[0].namedImports[0];
            expect(namedImport.memberAccesses).toContain('getAuthHeader');
            expect(namedImport.memberAccesses).toContain('isLoggedIn');
        });
    });

    describe('JSX member expression detection', () => {
        it('should detect JSX member expression (<Foo.Bar />)', () => {
            const code = `
                import { InventoryTag } from 'sarsaparilla';
                const Component = () => <InventoryTag.Camping />;
            `;
            const result = analyzeImportUsage(code, 'test.tsx');

            const namedImport = result[0].namedImports[0];
            expect(namedImport.jsxMemberAccesses).toContain('Camping');
        });

        it('should detect multiple JSX member expressions', () => {
            const code = `
                import { InventoryTag } from 'sarsaparilla';
                const Component = () => (
                    <div>
                        <InventoryTag.InventoryCamping isSpanItem />
                        <InventoryTag.InventoryDayUse isSpanItem />
                        <InventoryTag.InventoryTicket isSpanItem />
                    </div>
                );
            `;
            const result = analyzeImportUsage(code, 'test.tsx');

            const namedImport = result[0].namedImports[0];
            expect(namedImport.jsxMemberAccesses).toContain('InventoryCamping');
            expect(namedImport.jsxMemberAccesses).toContain('InventoryDayUse');
            expect(namedImport.jsxMemberAccesses).toContain('InventoryTicket');
        });

        it('should detect JSX member expressions with props', () => {
            const code = `
                import { Icon } from 'ui-lib';
                const Component = () => (
                    <Icon.Check size="lg" color="green" />
                );
            `;
            const result = analyzeImportUsage(code, 'test.tsx');

            expect(result[0].namedImports[0].jsxMemberAccesses).toContain(
                'Check',
            );
        });
    });

    describe('direct function call detection', () => {
        it('should detect direct function calls', () => {
            const code = `
                import { useFlags } from 'launchdarkly-react-client-sdk';
                const flags = useFlags();
            `;
            const result = analyzeImportUsage(code, 'test.ts');

            expect(result[0].namedImports[0].isCalledDirectly).toBe(true);
        });

        it('should not flag member method calls as direct calls', () => {
            const code = `
                import { Helper } from 'lib';
                Helper.doSomething();
            `;
            const result = analyzeImportUsage(code, 'test.ts');

            // Helper itself is not called directly, only Helper.doSomething is called
            expect(result[0].namedImports[0].isCalledDirectly).toBe(false);
            expect(result[0].namedImports[0].memberAccesses).toContain(
                'doSomething',
            );
        });
    });

    describe('direct JSX element detection', () => {
        it('should detect direct JSX element usage', () => {
            const code = `
                import { Button } from 'sarsaparilla';
                const Component = () => <Button>Click me</Button>;
            `;
            const result = analyzeImportUsage(code, 'test.tsx');

            expect(result[0].namedImports[0].isUsedAsJsxElement).toBe(true);
        });

        it('should detect self-closing JSX elements', () => {
            const code = `
                import { Divider } from 'ui-lib';
                const Component = () => <Divider />;
            `;
            const result = analyzeImportUsage(code, 'test.tsx');

            expect(result[0].namedImports[0].isUsedAsJsxElement).toBe(true);
        });
    });

    describe('constructor detection', () => {
        it('should detect new expression usage', () => {
            const code = `
                import { MyClass } from 'lib';
                const instance = new MyClass();
            `;
            const result = analyzeImportUsage(code, 'test.ts');

            expect(result[0].namedImports[0].isConstructed).toBe(true);
        });
    });

    describe('default import handling', () => {
        it('should track default import usage', () => {
            const code = `
                import React from 'react';
                const el = React.createElement('div');
            `;
            const result = analyzeImportUsage(code, 'test.tsx');

            expect(result[0].defaultImportName).toBe('React');
            expect(result[0].defaultImportUsage?.memberAccesses).toContain(
                'createElement',
            );
        });

        it('should detect default import used as JSX', () => {
            const code = `
                import Wrapper from './Wrapper';
                const Component = () => <Wrapper>content</Wrapper>;
            `;
            const result = analyzeImportUsage(code, 'test.tsx');

            expect(result[0].defaultImportUsage?.isUsedAsJsxElement).toBe(true);
        });
    });

    describe('namespace import handling', () => {
        it('should track namespace imports', () => {
            const code = `
                import * as Utils from './utils';
                Utils.format();
            `;
            const result = analyzeImportUsage(code, 'test.ts');

            expect(result[0].hasNamespaceImport).toBe(true);
            expect(result[0].namespaceImportName).toBe('Utils');
        });
    });

    describe('multiple imports from same source', () => {
        it('should combine imports from the same source', () => {
            const code = `
                import { Button, Icon } from 'ui-lib';
                const Component = () => (
                    <Button>
                        <Icon.Check />
                    </Button>
                );
            `;
            const result = analyzeImportUsage(code, 'test.tsx');

            expect(result).toHaveLength(1);
            expect(result[0].namedImports).toHaveLength(2);

            const buttonImport = result[0].namedImports.find(
                (n) => n.localName === 'Button',
            );
            const iconImport = result[0].namedImports.find(
                (n) => n.localName === 'Icon',
            );

            expect(buttonImport?.isUsedAsJsxElement).toBe(true);
            expect(iconImport?.jsxMemberAccesses).toContain('Check');
        });
    });
});

describe('aggregateImportUsage', () => {
    it('should aggregate usage across multiple files', () => {
        const usageInfos: ImportUsageInfo[] = [
            {
                source: 'sarsaparilla',
                importingFile: 'file1.tsx',
                namedImports: [
                    {
                        localName: 'InventoryTag',
                        memberAccesses: ['Camping'],
                        jsxMemberAccesses: ['Camping'],
                        isCalledDirectly: false,
                        isUsedAsJsxElement: false,
                        isConstructed: false,
                    },
                ],
                defaultImportName: null,
                defaultImportUsage: null,
                hasNamespaceImport: false,
                namespaceImportName: null,
            },
            {
                source: 'sarsaparilla',
                importingFile: 'file2.tsx',
                namedImports: [
                    {
                        localName: 'InventoryTag',
                        memberAccesses: ['DayUse'],
                        jsxMemberAccesses: ['DayUse', 'Permit'],
                        isCalledDirectly: false,
                        isUsedAsJsxElement: false,
                        isConstructed: false,
                    },
                ],
                defaultImportName: null,
                defaultImportUsage: null,
                hasNamespaceImport: false,
                namespaceImportName: null,
            },
        ];

        const aggregated = aggregateImportUsage(usageInfos, 'sarsaparilla');

        const inventoryTag = aggregated.get('InventoryTag');
        expect(inventoryTag).toBeDefined();
        expect(inventoryTag?.isUsedAsNamespace).toBe(true);
        expect(inventoryTag?.allMemberAccesses).toContain('Camping');
        expect(inventoryTag?.allMemberAccesses).toContain('DayUse');
        expect(inventoryTag?.allJsxMemberAccesses).toContain('Camping');
        expect(inventoryTag?.allJsxMemberAccesses).toContain('DayUse');
        expect(inventoryTag?.allJsxMemberAccesses).toContain('Permit');
        expect(inventoryTag?.usedInFiles).toContain('file1.tsx');
        expect(inventoryTag?.usedInFiles).toContain('file2.tsx');
    });

    it('should filter by package source', () => {
        const usageInfos: ImportUsageInfo[] = [
            {
                source: 'sarsaparilla',
                importingFile: 'file1.tsx',
                namedImports: [
                    {
                        localName: 'Button',
                        memberAccesses: [],
                        jsxMemberAccesses: [],
                        isCalledDirectly: false,
                        isUsedAsJsxElement: true,
                        isConstructed: false,
                    },
                ],
                defaultImportName: null,
                defaultImportUsage: null,
                hasNamespaceImport: false,
                namespaceImportName: null,
            },
            {
                source: 'react',
                importingFile: 'file1.tsx',
                namedImports: [
                    {
                        localName: 'useState',
                        memberAccesses: [],
                        jsxMemberAccesses: [],
                        isCalledDirectly: true,
                        isUsedAsJsxElement: false,
                        isConstructed: false,
                    },
                ],
                defaultImportName: null,
                defaultImportUsage: null,
                hasNamespaceImport: false,
                namespaceImportName: null,
            },
        ];

        const aggregated = aggregateImportUsage(usageInfos, 'sarsaparilla');

        expect(aggregated.has('Button')).toBe(true);
        expect(aggregated.has('useState')).toBe(false); // From react, not sarsaparilla
    });
});
