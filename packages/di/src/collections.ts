export function getOrCreate<K, V>(
  map: { get(key: K): V | undefined; set(key: K, value: V): unknown },
  key: K,
  create: () => V,
): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}
