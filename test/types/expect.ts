/**
 * Dependency-free type assertions, checked by `bunx tsc --noEmit`.
 * Files in test/types are type-checked but never executed by `bun test`.
 */

/** Exact type equality (distinguishes `any`, `unknown`, optional vs `| undefined`). */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** `type _ = Expect<Equal<A, B>>` fails to compile when the types differ. */
export type Expect<T extends true> = T;

interface Matcher<T> {
  /** Compile error unless `T` is exactly `U`. */
  toEqualTypeOf<U>(...mismatch: Equal<T, U> extends true ? [] : [expected: U, actual: T]): void;
  /** Compile error unless `T` is assignable to `U`. */
  toMatchTypeOf<U>(...mismatch: [T] extends [U] ? [] : [expected: U, actual: T]): void;
}

const matcher: Matcher<any> = { toEqualTypeOf() {}, toMatchTypeOf() {} };

/** `expectTypeOf(value).toEqualTypeOf<Expected>()` or `expectTypeOf<Actual>().toEqualTypeOf<Expected>()`. */
export function expectTypeOf<T>(_value?: T): Matcher<T> {
  return matcher;
}
