import { describe, test, expect } from 'vitest';
import { createUniversalStub, __stub__ } from '@web2local/stubs';

describe('createUniversalStub', () => {
    test('can be called as a function', () => {
        const stub = createUniversalStub('myFunc');
        // Should not throw
        expect(() => stub()).not.toThrow();
        expect(() => stub('arg1', 'arg2')).not.toThrow();
    });

    test('can be used with new (constructor)', () => {
        const Stub = createUniversalStub('MyClass');
        // Should not throw
        expect(() => new Stub()).not.toThrow();
        expect(() => new Stub('arg')).not.toThrow();
    });

    test('can chain function calls (HOC pattern)', () => {
        const withSomething = createUniversalStub('withSomething');
        // Common HOC pattern: withSomething(options)(Component)
        expect(() => withSomething()()).not.toThrow();
        expect(() =>
            withSomething({ option: true })('Component'),
        ).not.toThrow();
    });

    test('can access properties deeply', () => {
        const stub = createUniversalStub('obj');
        // Should not throw
        expect(() => stub.foo).not.toThrow();
        expect(() => stub.foo.bar).not.toThrow();
        expect(() => stub.foo.bar.baz.qux).not.toThrow();
    });

    test('can call methods on properties', () => {
        const stub = createUniversalStub('obj');
        // Should not throw
        expect(() => stub.method()).not.toThrow();
        expect(() => stub.deep.nested.method('arg')).not.toThrow();
    });

    test('can assign properties', () => {
        const stub = createUniversalStub('obj');
        // Should not throw
        expect(() => {
            stub.foo = 'bar';
        }).not.toThrow();
        expect(() => {
            stub.deep.nested.value = 123;
        }).not.toThrow();
    });

    test('converts to primitive types', () => {
        const stub = createUniversalStub('value');
        // String conversion should return empty string
        expect(String(stub)).toBe('');
        // Number conversion returns NaN (empty string coerced to number)
        expect(Number(stub)).toBe(0);
    });

    test('is not a Promise (then returns undefined)', () => {
        const stub = createUniversalStub('notAPromise');
        // Should return undefined for 'then' to prevent Promise detection
        expect(stub.then).toBeUndefined();
    });

    test('can be spread (returns empty array)', () => {
        const stub = createUniversalStub('spreadable');
        // Should not throw when spread
        expect(() => [...stub]).not.toThrow();
        expect([...stub]).toEqual([]);
    });

    test('reports presence of any property', () => {
        const stub = createUniversalStub('obj');
        expect('foo' in stub).toBe(true);
        expect('anyProperty' in stub).toBe(true);
    });

    test('has correct __stubName__ for debugging', () => {
        const stub = createUniversalStub('myName');
        expect(stub.__stubName__).toBe('myName');
    });

    test('chain names are tracked for debugging', () => {
        const stub = createUniversalStub('base');
        expect(stub.child.__stubName__).toBe('base.child');
        expect(stub().__stubName__).toBe('base()');
    });

    test('toJSON returns null (safe for JSON.stringify)', () => {
        const stub = createUniversalStub('obj');
        expect(stub.toJSON()).toBe(null);
        expect(() => JSON.stringify(stub)).not.toThrow();
    });

    test('__stub__ is the same as createUniversalStub', () => {
        expect(__stub__).toBe(createUniversalStub);
    });
});
