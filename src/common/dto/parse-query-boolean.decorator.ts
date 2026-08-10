import { Transform } from 'class-transformer';

/**
 * `@Type(() => Boolean)` looks like the right tool for a `?flag=false` query
 * param but isn't — class-transformer falls back to JS's `Boolean(value)`,
 * and `Boolean("false")` is `true` (any non-empty string is truthy). Every
 * boolean query filter needs this instead.
 */
export function ParseQueryBoolean(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }): unknown => {
    if (typeof value !== 'string') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  });
}
