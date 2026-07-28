import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import { isPiDesktopDistribution } from "@t3tools/shared/desktopDistribution";

const electronSafeStorageErrorFields = {
  cause: Schema.Defect(),
};

export class ElectronSafeStorageAvailabilityError extends Schema.TaggedErrorClass<ElectronSafeStorageAvailabilityError>()(
  "ElectronSafeStorageAvailabilityError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to check encryption availability.";
  }
}

export class ElectronSafeStorageEncryptError extends Schema.TaggedErrorClass<ElectronSafeStorageEncryptError>()(
  "ElectronSafeStorageEncryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to encrypt a string.";
  }
}

export class ElectronSafeStorageDecryptError extends Schema.TaggedErrorClass<ElectronSafeStorageDecryptError>()(
  "ElectronSafeStorageDecryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to decrypt a string.";
  }
}

export const ElectronSafeStorageError = Schema.Union([
  ElectronSafeStorageAvailabilityError,
  ElectronSafeStorageEncryptError,
  ElectronSafeStorageDecryptError,
]);
export type ElectronSafeStorageError = typeof ElectronSafeStorageError.Type;
export const isElectronSafeStorageError = Schema.is(ElectronSafeStorageError);

export class ElectronSafeStorage extends Context.Service<
  ElectronSafeStorage,
  {
    readonly isEncryptionAvailable: Effect.Effect<boolean, ElectronSafeStorageAvailabilityError>;
    readonly encryptString: (
      value: string,
    ) => Effect.Effect<Uint8Array, ElectronSafeStorageEncryptError>;
    readonly decryptString: (
      value: Uint8Array,
    ) => Effect.Effect<string, ElectronSafeStorageDecryptError>;
  }
>()("@t3tools/desktop/electron/ElectronSafeStorage") {}

export function makeElectronSafeStorage(input: {
  readonly enabled: boolean;
  readonly safeStorage: Pick<
    Electron.SafeStorage,
    "isEncryptionAvailable" | "encryptString" | "decryptString"
  >;
}): ElectronSafeStorage["Service"] {
  const disabledCause = new Error("Safe storage is disabled for this desktop distribution.");

  return ElectronSafeStorage.of({
    isEncryptionAvailable: input.enabled
      ? Effect.try({
          try: () => input.safeStorage.isEncryptionAvailable(),
          catch: (cause) => new ElectronSafeStorageAvailabilityError({ cause }),
        })
      : Effect.succeed(false),
    encryptString: (value) =>
      input.enabled
        ? Effect.try({
            try: () => input.safeStorage.encryptString(value),
            catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
          })
        : Effect.fail(new ElectronSafeStorageEncryptError({ cause: disabledCause })),
    decryptString: (value) =>
      input.enabled
        ? Effect.try({
            try: () => input.safeStorage.decryptString(Buffer.from(value)),
            catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
          })
        : Effect.fail(new ElectronSafeStorageDecryptError({ cause: disabledCause })),
  });
}

const safeStorageEnabled = !isPiDesktopDistribution({
  isPackaged: Electron.app.isPackaged,
  packageName: Electron.app.name,
});

export const make = makeElectronSafeStorage({
  enabled: safeStorageEnabled,
  safeStorage: Electron.safeStorage,
});

export const layer = Layer.succeed(ElectronSafeStorage, make);
