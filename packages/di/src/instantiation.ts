import {
  assertBaseServiceIdentifier,
  assertValidImplementation,
  Descriptor,
  resolveBaseServiceIdentifier,
  toDescriptor,
  toServiceIdentifier,
  type AbstractServiceConstructor,
  type ServiceConstructor,
  type ServiceIdentifier,
} from "./descriptors.ts";

export type ServiceEntry =
  | ServiceConstructor<any>
  | Descriptor<any>
  | readonly [ServiceIdentifier<any>, ServiceConstructor<any> | Descriptor<any>];

export type ServiceEntries = ReadonlyArray<ServiceEntry>;

export interface InjectionContext {
  get<T>(id: ServiceIdentifier<T>): T;
  // Contexts built outside Scope may omit this; optionalInject() then probes get() instead.
  getOptional?<T>(id: ServiceIdentifier<T>): T | undefined;
}

const injectionStack: InjectionContext[] = [];

export function runInInjectionContext<T>(context: InjectionContext, fn: () => T): T {
  injectionStack.push(context);
  try {
    return fn();
  } finally {
    injectionStack.pop();
  }
}

export function inject<T>(id: AbstractServiceConstructor<T>): T {
  assertBaseServiceIdentifier(id, "inject()");
  const current = injectionStack[injectionStack.length - 1];
  if (current === undefined) {
    throw new Error(
      `inject(${id.name || "<anonymous>"}) can only be called synchronously inside a service constructor, createInstance(), or scope.run()`,
    );
  }
  return current.get(id);
}

export function optionalInject<T>(id: AbstractServiceConstructor<T>): T | undefined {
  assertBaseServiceIdentifier(id, "optionalInject()");
  const current = injectionStack[injectionStack.length - 1];
  if (current === undefined) {
    throw new Error(
      `optionalInject(${id.name || "<anonymous>"}) can only be called synchronously inside a service constructor, createInstance(), or scope.run()`,
    );
  }
  if (current.getOptional !== undefined) return current.getOptional(id);
  try {
    return current.get(id);
  } catch {
    return undefined;
  }
}

export function normalizeServiceEntry(
  entry: ServiceEntry,
): readonly [ServiceIdentifier<unknown>, Descriptor<unknown>] {
  if (Array.isArray(entry)) {
    const id = toServiceIdentifier(entry[0], "service registration");
    const descriptor = toDescriptor(entry[1]);
    assertValidImplementation(id, descriptor.ctor);
    return [id, descriptor];
  }
  const descriptor = toDescriptor(entry as ServiceConstructor<unknown> | Descriptor<unknown>);
  const id = resolveBaseServiceIdentifier(descriptor.ctor);
  assertValidImplementation(id, descriptor.ctor);
  return [id, descriptor];
}

export abstract class InstantiationService {
  abstract createInstance<T>(descriptor: Descriptor<T>): T;
  abstract createInstance<Ctor extends ServiceConstructor<any>>(
    ctor: Ctor,
    ...args: ConstructorParameters<Ctor>
  ): InstanceType<Ctor>;
}
