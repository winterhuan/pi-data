import { describe, expect, it } from "vitest";
import { parsePiCliVersionOutput } from "./diagnostics.ts";

describe("diagnostics", () => {
  it("detects Pi CLI version when pi writes --version to stderr", () => {
    expect(parsePiCliVersionOutput("", "0.78.1\n")).toBe("0.78.1");
  });

  it("detects Pi CLI version when pi writes --version to stdout", () => {
    expect(parsePiCliVersionOutput("pi 0.78.1\n", "")).toBe("0.78.1");
  });
});
