/**
 * Universal stub generator for missing exports.
 *
 * The problem: When we stub missing exports as `undefined`, runtime calls fail:
 *   - `withLDConsumer()` → TypeError: undefined is not a function
 *   - `new SomeClass()` → TypeError: SomeClass is not a constructor
 *   - `obj.foo.bar` → TypeError: Cannot read property 'bar' of undefined
 *
 * The solution: A Proxy-based universal stub that handles any operation gracefully.
 * This is 100% generic - no special-casing based on variable names or expected types.
 *
 * Usage in generated stub code:
 *   import { __stub__ } from './__universal-stub__';
 *   export const withLDConsumer = __stub__('withLDConsumer');
 *   export const SomeClass = __stub__('SomeClass');
 */

/**
 * Creates a universal stub that handles any operation without throwing.
 * Returns a Proxy that:
 * - Can be called as a function (returns another stub)
 * - Can be used with `new` (returns another stub)
 * - Can have properties accessed (returns another stub)
 * - Can be assigned to (silently succeeds)
 * - Converts to primitive types safely
 *
 * @param name Optional name for debugging (will appear in console warnings)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createUniversalStub(name?: string): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler: ProxyHandler<any> = {
        // Called as function: stub()
        apply(_target, _thisArg, args) {
            if (process.env.NODE_ENV === 'development' && name) {
                console.warn(
                    `[stub] Called missing export "${name}" as function with ${args.length} args`,
                );
            }
            return createUniversalStub(name ? `${name}()` : undefined);
        },

        // Called with new: new stub()
        construct(_target, args) {
            if (process.env.NODE_ENV === 'development' && name) {
                console.warn(
                    `[stub] Constructed missing export "${name}" with ${args.length} args`,
                );
            }
            return createUniversalStub(name ? `new ${name}()` : undefined);
        },

        // Property access: stub.foo
        get(_target, prop) {
            // Handle special symbols that need specific behavior
            if (prop === Symbol.toPrimitive) {
                return () => '';
            }
            if (prop === Symbol.toStringTag) {
                return name || 'Stub';
            }
            if (prop === Symbol.iterator) {
                // Return an empty iterator for spread/for-of
                return function* () {};
            }

            // Prevent Promise detection (returning undefined for 'then' makes it non-thenable)
            if (prop === 'then') {
                return undefined;
            }

            // Handle common methods that should return appropriate values
            if (prop === 'toString' || prop === 'valueOf') {
                return () => '';
            }
            if (prop === 'toJSON') {
                return () => null;
            }

            // Return stub's name for debugging
            if (prop === '__stubName__') {
                return name;
            }

            // For all other properties, return another stub
            const propName =
                typeof prop === 'string'
                    ? prop
                    : typeof prop === 'symbol'
                      ? prop.toString()
                      : String(prop);
            return createUniversalStub(name ? `${name}.${propName}` : propName);
        },

        // Property assignment: stub.foo = bar
        set() {
            return true;
        },

        // Property check: 'foo' in stub
        has() {
            return true;
        },

        // delete stub.foo
        deleteProperty() {
            return true;
        },

        // Object.keys(stub), etc.
        // Must include 'prototype' because the target is a function with non-configurable prototype
        ownKeys() {
            return ['prototype'];
        },

        // Property descriptor for Object.getOwnPropertyDescriptor
        // Must return a descriptor for 'prototype' to satisfy Proxy invariants
        getOwnPropertyDescriptor(_target, prop) {
            if (prop === 'prototype') {
                return {
                    value: {},
                    writable: true,
                    enumerable: false,
                    configurable: false,
                };
            }
            return undefined;
        },

        // For Object.getPrototypeOf
        getPrototypeOf() {
            return Function.prototype;
        },

        // For Object.isExtensible
        isExtensible() {
            return true;
        },

        // For Object.preventExtensions
        preventExtensions() {
            return false;
        },

        // For Object.setPrototypeOf
        setPrototypeOf() {
            return true;
        },

        // For Object.defineProperty
        defineProperty() {
            return true;
        },
    };

    // Must be a function to support apply/construct traps
    const stub = function () {};

    // Set a name for debugging
    Object.defineProperty(stub, 'name', {
        value: name || 'universalStub',
        writable: false,
    });

    return new Proxy(stub, handler);
}

/**
 * Shorthand for createUniversalStub - use this in generated code
 */
export const __stub__ = createUniversalStub;

/**
 * Default export for convenience
 */
export default createUniversalStub;
