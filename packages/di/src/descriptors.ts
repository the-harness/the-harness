import { canonicalClass, latestClass } from "@harness/hot";

export type AbstractServiceConstructor<T = unknown> = abstract new (...args: any[]) => T;
export type ServiceConstructor<T = unknown> = new (...args: any[]) => T;
export type ServiceIdentifier<T = unknown> = AbstractServiceConstructor<T>;

export class Descriptor<T> {
  readonly ctor: ServiceConstructor<T>;
  readonly staticArguments: readonly unknown[];

  constructor(ctor: ServiceConstructor<T>, staticArguments: readonly unknown[] = []) {
    this.ctor = ctor;
    this.staticArguments = staticArguments;
  }
}

export function createDescriptor<Ctor extends ServiceConstructor<any>>(
  ctor: Ctor,
  ...staticArguments: ConstructorParameters<Ctor>
): Descriptor<InstanceType<Ctor>> {
  return new Descriptor(ctor, staticArguments);
}

export function isBaseServiceIdentifier(id: unknown): id is ServiceIdentifier<unknown> {
  return typeof id === "function" && Object.getPrototypeOf(id) === Function.prototype;
}

export function assertBaseServiceIdentifier(
  id: unknown,
  action: string,
): asserts id is ServiceIdentifier<unknown> {
  if (typeof id !== "function") {
    throw new TypeError(`${action}: service identifier must be a class constructor`);
  }
  if (!isBaseServiceIdentifier(id)) {
    const base = resolveBaseServiceIdentifier(id as AbstractServiceConstructor<unknown>);
    throw new Error(
      `${action}: derived class '${id.name || "<anonymous>"}' cannot be used as a service identifier; use base service class '${base.name || "<anonymous>"}' instead`,
    );
  }
}

export function toServiceIdentifier<T>(
  id: AbstractServiceConstructor<T>,
  action: string,
): ServiceIdentifier<T> {
  assertBaseServiceIdentifier(id, action);
  return canonicalClass(id);
}

export function resolveBaseServiceIdentifier<T>(
  ctor: AbstractServiceConstructor<T>,
): ServiceIdentifier<T> {
  let current: Function = ctor;
  while (true) {
    const proto = Object.getPrototypeOf(current);
    if (typeof proto !== "function" || proto === Function.prototype) {
      return canonicalClass(current) as unknown as ServiceIdentifier<T>;
    }
    current = proto;
  }
}

export function assertValidImplementation(
  id: ServiceIdentifier<unknown>,
  ctor: ServiceConstructor<unknown>,
): void {
  if (typeof ctor !== "function") {
    throw new TypeError(
      `service implementation for '${id.name || "<anonymous>"}' must be a class constructor`,
    );
  }
  if (!extendsServiceIdentifier(ctor, id)) {
    throw new TypeError(
      `class '${ctor.name || "<anonymous>"}' does not extend base service '${id.name || "<anonymous>"}'`,
    );
  }
}

function extendsServiceIdentifier(ctor: Function, id: ServiceIdentifier<unknown>): boolean {
  const canonicalId = canonicalClass(id);
  for (let current: unknown = ctor; typeof current === "function"; ) {
    if (current === Function.prototype) return false;
    if (canonicalClass(current) === canonicalId) return true;
    current = Object.getPrototypeOf(current);
  }
  return false;
}

export function toDescriptor<T>(
  ctorOrDescriptor: ServiceConstructor<T> | Descriptor<T>,
): Descriptor<T> {
  if (ctorOrDescriptor instanceof Descriptor) {
    return ctorOrDescriptor;
  }
  if (typeof ctorOrDescriptor === "function") {
    return new Descriptor(ctorOrDescriptor);
  }
  throw new TypeError("service registration must be a constructor or Descriptor");
}

export function isSameDescriptor(a: Descriptor<unknown>, b: Descriptor<unknown>): boolean {
  if (a === b) return true;
  if (latestClass(a.ctor) !== latestClass(b.ctor)) return false;
  if (a.staticArguments.length !== b.staticArguments.length) return false;
  return a.staticArguments.every((arg, index) => isSameData(arg, b.staticArguments[index], []));
}

/** @internal Plain data compares by value; anything else (instances, functions) by identity. */
export function isSamePlainData(a: unknown, b: unknown): boolean {
  return isSameData(a, b, []);
}

// Static arguments are usually rebuilt on every call site evaluation, so plain data compares by
// value; anything else (instances, functions) must stay identical.
function isSameData(a: unknown, b: unknown, stack: unknown[]): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (stack.includes(a)) return false;
  const kind = (value: object) =>
    Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
      ? "array"
      : isPlainObject(value)
        ? "object"
        : undefined;
  if (kind(a) === undefined || kind(a) !== kind(b)) return false;
  // Every own key, including holes, symbols and non-enumerable ones, must be an equal data property.
  const keys = Reflect.ownKeys(a);
  if (keys.length !== Reflect.ownKeys(b).length) return false;
  stack.push(a);
  const same = keys.every((key) => {
    const left = Object.getOwnPropertyDescriptor(a, key)!;
    const right = Object.getOwnPropertyDescriptor(b, key);
    return (
      right !== undefined &&
      "value" in left &&
      "value" in right &&
      left.enumerable === right.enumerable &&
      left.writable === right.writable &&
      isSameData(left.value, right.value, stack)
    );
  });
  stack.pop();
  return same;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
