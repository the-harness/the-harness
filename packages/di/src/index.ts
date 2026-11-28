export {
  createDescriptor,
  Descriptor,
  isBaseServiceIdentifier,
  type AbstractServiceConstructor,
  type ServiceConstructor,
  type ServiceIdentifier,
} from "./descriptors.ts";
export {
  inject,
  InstantiationService,
  optionalInject,
  type ServiceEntries,
  type ServiceEntry,
} from "./instantiation.ts";
export {
  createRootScope,
  CurrentScope,
  CyclicDependencyError,
  defineSetup,
  replaceService,
  Scope,
  type ScopeOptions,
  useServices,
  useSetup,
} from "./scope.ts";
