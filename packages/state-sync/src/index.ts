import { arrayEndpoint } from "./primitives/array.ts";
import { recordEndpoint } from "./primitives/record.ts";
import { valueEndpoint } from "./primitives/value.ts";

export const stateSync = {
  array: arrayEndpoint,
  value: valueEndpoint,
  record: recordEndpoint,
};

export {
  connectStreamEndpoint,
  defineStateSyncContract,
  type StateSyncClient,
  type StateSyncClientPaths,
  type StateSyncClientTarget,
  type StateSyncContract,
  type StateSyncEndpoint,
  type StateSyncEndpointOptions,
  type StateSyncEndpoints,
  type StateSyncHost,
  type StateSyncStreamMessage,
} from "./contract.ts";
export {
  StateSyncServerService,
  type StateSyncContext,
  type StateSyncHostFor,
  type StateSyncHosts,
} from "./server.ts";
export { StateSyncClientService } from "./service.ts";
export {
  defaultDeserialize,
  defaultSerialize,
  isWireEqual,
  resolveValueCodec,
  type ResolvedValueCodec,
  type SyncedCodecOptions,
} from "./primitives/codec.ts";
export {
  applyArrayOps,
  diffArray,
  type ArrayOp,
  type SyncedArrayCodecOptions,
} from "./primitives/arrayDiff.ts";
export {
  arrayEndpoint,
  SyncedArrayClient,
  SyncedArrayHost,
  type ArrayPatch,
  type ArrayPatchSender,
  type ArraySnapshot,
  type ArraySyncFrame,
  type ArraySyncListener,
  type ReadonlySyncedArrayClient,
  type StateSyncArrayEndpoint,
  type StateSyncArrayEndpointOptions,
} from "./primitives/array.ts";
export {
  recordEndpoint,
  SyncedRecordClient,
  SyncedRecordHost,
  type ReadonlySyncedRecordClient,
  type RecordPatch,
  type RecordPatchSender,
  type RecordSnapshot,
  type RecordSyncFrame,
  type RecordSyncListener,
  type StateSyncRecordEndpoint,
  type SyncedRecordClientOptions,
} from "./primitives/record.ts";
export {
  valueEndpoint,
  SyncedValueClient,
  SyncedValueHost,
  type ReadonlySyncedValueClient,
  type StateSyncValueEndpoint,
  type SyncedValueClientOptions,
  type ValuePatch,
  type ValuePatchSender,
  type ValueSnapshot,
  type ValueSyncFrame,
  type ValueSyncListener,
} from "./primitives/value.ts";
