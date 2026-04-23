import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// jsdom doesn't implement crypto.randomUUID in older envs; shim if missing.
if (typeof globalThis.crypto === "undefined") {
  (globalThis as unknown as { crypto: Crypto }).crypto = {} as Crypto;
}
if (typeof globalThis.crypto.randomUUID !== "function") {
  let counter = 0;
  (globalThis.crypto as unknown as { randomUUID: () => string }).randomUUID = () => {
    counter += 1;
    return `test-uuid-${counter}`;
  };
}
