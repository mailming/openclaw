import { describe, expect, it } from "vitest";
import { shouldDisableToolsForAttempt } from "./tool-disable.js";

describe("shouldDisableToolsForAttempt", () => {
  it("returns true when the caller explicitly disables tools", () => {
    expect(
      shouldDisableToolsForAttempt({
        requestedDisableTools: true,
        model: {},
      }),
    ).toBe(true);
  });

  it("returns true when the model marks compat.supportsTools=false", () => {
    expect(
      shouldDisableToolsForAttempt({
        model: { compat: { supportsTools: false } },
      }),
    ).toBe(true);
  });

  it("returns false when tools are allowed and no retry override is active", () => {
    expect(
      shouldDisableToolsForAttempt({
        model: { compat: { supportsTools: true } },
      }),
    ).toBe(false);
  });
});
