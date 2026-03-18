import { describe, expect, it } from "vitest";
import {
  extractTelegramFileDirectives,
  resolveTelegramFileDirectivePath,
} from "../../../src/bot/utils/telegram-file-directives.js";

describe("bot/utils/telegram-file-directives", () => {
  it("extracts directives and removes them from visible text", () => {
    const result = extractTelegramFileDirectives(
      [
        "Done.",
        "TELEGRAM_FILE: notes/out.txt | Generated notes",
        "",
        "TELEGRAM_FILE: logs/run.log",
      ].join("\n"),
    );

    expect(result.cleanedText).toBe("Done.");
    expect(result.directives).toEqual([
      { requestedPath: "notes/out.txt", caption: "Generated notes" },
      { requestedPath: "logs/run.log", caption: "" },
    ]);
  });

  it("keeps directive-like lines inside code fences", () => {
    const result = extractTelegramFileDirectives([
      "```text",
      "TELEGRAM_FILE: keep/me.txt",
      "```",
    ].join("\n"));

    expect(result.directives).toEqual([]);
    expect(result.cleanedText).toContain("TELEGRAM_FILE: keep/me.txt");
  });

  it("resolves only paths inside the current project", () => {
    expect(resolveTelegramFileDirectivePath("/workspace/openclaw", "notes/out.txt")).toBe(
      "/workspace/openclaw/notes/out.txt",
    );
    expect(resolveTelegramFileDirectivePath("/workspace/openclaw", "../secret.txt")).toBeNull();
  });
});
