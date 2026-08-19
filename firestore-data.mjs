function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function withoutUndefined(value) {
  if (Array.isArray(value)) {
    return value
      .filter(item => item !== undefined)
      .map(item => withoutUndefined(item));
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, withoutUndefined(item)]),
  );
}

export function undefinedPaths(value, prefix = '') {
  if (value === undefined) return [prefix || '<root>'];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => undefinedPaths(item, `${prefix}[${index}]`));
  }
  if (!isPlainObject(value)) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    undefinedPaths(item, prefix ? `${prefix}.${key}` : key));
}
