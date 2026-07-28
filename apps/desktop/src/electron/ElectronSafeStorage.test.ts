import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    name: "t3code",
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(() => Buffer.from("encrypted")),
    decryptString: vi.fn(() => "decrypted"),
  },
}));

import { makeElectronSafeStorage } from "./ElectronSafeStorage.ts";

describe("ElectronSafeStorage", () => {
  it.effect("does not call Electron safeStorage when disabled", () =>
    Effect.gen(function* () {
      const safeStorage = {
        isEncryptionAvailable: vi.fn(() => true),
        encryptString: vi.fn(() => Buffer.from("encrypted")),
        decryptString: vi.fn(() => "decrypted"),
      };
      const service = makeElectronSafeStorage({ enabled: false, safeStorage });

      assert.isFalse(yield* service.isEncryptionAvailable);
      yield* service.encryptString("secret").pipe(Effect.flip);
      yield* service.decryptString(Buffer.from("encrypted")).pipe(Effect.flip);

      assert.isFalse(safeStorage.isEncryptionAvailable.mock.calls.length > 0);
      assert.isFalse(safeStorage.encryptString.mock.calls.length > 0);
      assert.isFalse(safeStorage.decryptString.mock.calls.length > 0);
    }),
  );
});
