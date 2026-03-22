import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTelegramAttachmentPrompt,
  buildTextFilePrompt,
  toDataUri,
  formatFileSize,
  isFileSizeAllowed,
  isLikelyTextFilename,
  isTextMimeType,
  saveTelegramFileToProject,
} from "../../../src/bot/utils/file-download.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempProject(withDocuments: boolean = true): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-telegram-file-"));
  tempDirs.push(projectRoot);

  if (withDocuments) {
    await fs.mkdir(path.join(projectRoot, "documents"), { recursive: true });
  }

  return projectRoot;
}

describe("bot/utils/file-download", () => {
  describe("toDataUri", () => {
    it("converts buffer to base64 data URI with correct MIME type", () => {
      const buffer = Buffer.from("Hello, World!");
      const dataUri = toDataUri(buffer, "text/plain");

      expect(dataUri).toBe("data:text/plain;base64,SGVsbG8sIFdvcmxkIQ==");
    });

    it("handles image MIME types", () => {
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic number
      const dataUri = toDataUri(buffer, "image/png");

      expect(dataUri).toMatch(/^data:image\/png;base64,/);
      expect(dataUri).toBe("data:image/png;base64,iVBORw==");
    });

    it("handles empty buffer", () => {
      const buffer = Buffer.from([]);
      const dataUri = toDataUri(buffer, "application/octet-stream");

      expect(dataUri).toBe("data:application/octet-stream;base64,");
    });
  });

  describe("saveTelegramFileToProject", () => {
    it("stores files under documents/inbox when the project has documents", async () => {
      const projectRoot = await createTempProject();
      const savedFile = await saveTelegramFileToProject({
        projectRoot,
        buffer: Buffer.from("image bytes"),
        originalFilename: "photo from telegram.jpg",
        fallbackFilename: "photo.jpg",
        mimeType: "image/jpeg",
        createdAt: new Date("2026-03-22T19:22:35.000Z"),
      });

      expect(savedFile.relativePath).toMatch(
        /^documents\/inbox\/2026\/03\/22\/20260322T192235Z-[a-f0-9]{8}-photo from telegram\.jpg$/,
      );
      await expect(fs.readFile(savedFile.absolutePath, "utf-8")).resolves.toBe("image bytes");
    });

    it("falls back outside documents when the project has no documents directory", async () => {
      const projectRoot = await createTempProject(false);
      const savedFile = await saveTelegramFileToProject({
        projectRoot,
        buffer: Buffer.from("pdf bytes"),
        originalFilename: "../../report.pdf",
        fallbackFilename: "file.pdf",
        mimeType: "application/pdf",
        createdAt: new Date("2026-03-22T19:22:35.000Z"),
      });

      expect(savedFile.relativePath).toMatch(
        /^\.telegram-files\/incoming\/2026\/03\/22\/20260322T192235Z-[a-f0-9]{8}-report\.pdf$/,
      );
      await expect(fs.readFile(savedFile.absolutePath, "utf-8")).resolves.toBe("pdf bytes");
    });
  });

  describe("attachment prompts", () => {
    it("adds saved path context before the caption", () => {
      expect(buildTelegramAttachmentPrompt("Describe this photo", "documents/inbox/2026/03/22/photo.jpg")).toBe(
        "Telegram file saved locally at `documents/inbox/2026/03/22/photo.jpg`. Use this local path if you need the original file.\n\nDescribe this photo",
      );
    });

    it("uses fallback text when there is no caption", () => {
      expect(buildTelegramAttachmentPrompt("", undefined, "See attached file.")).toBe(
        "See attached file.",
      );
    });

    it("embeds saved path into text file prompts", () => {
      expect(
        buildTextFilePrompt(
          "notes.txt",
          "hello world",
          "Summarize it",
          "documents/inbox/2026/03/22/notes.txt",
        ),
      ).toBe(
        "Telegram file saved locally at `documents/inbox/2026/03/22/notes.txt`. Use this local path if you need the original file.\n\n--- Content of notes.txt ---\nhello world\n--- End of file ---\n\nSummarize it",
      );
    });
  });

  describe("isFileSizeAllowed", () => {
    it("returns true when file size is within limit", () => {
      expect(isFileSizeAllowed(100 * 1024, 200)).toBe(true); // 100KB < 200KB
      expect(isFileSizeAllowed(1024, 1)).toBe(true); // exactly at limit
    });

    it("returns false when file size exceeds limit", () => {
      expect(isFileSizeAllowed(300 * 1024, 200)).toBe(false); // 300KB > 200KB
      expect(isFileSizeAllowed(1025, 1)).toBe(false); // just over limit
    });

    it("returns true when file size is undefined (unknown)", () => {
      expect(isFileSizeAllowed(undefined, 100)).toBe(true);
    });
  });

  describe("formatFileSize", () => {
    it("formats bytes correctly", () => {
      expect(formatFileSize(0)).toBe("0B");
      expect(formatFileSize(500)).toBe("500B");
      expect(formatFileSize(1023)).toBe("1023B");
    });

    it("formats kilobytes correctly", () => {
      expect(formatFileSize(1024)).toBe("1.0KB");
      expect(formatFileSize(1536)).toBe("1.5KB");
      expect(formatFileSize(10240)).toBe("10.0KB");
    });

    it("formats megabytes correctly", () => {
      expect(formatFileSize(1024 * 1024)).toBe("1.0MB");
      expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5MB");
      expect(formatFileSize(10 * 1024 * 1024)).toBe("10.0MB");
    });
  });

  describe("isTextMimeType", () => {
    it("returns true for text/* MIME types", () => {
      expect(isTextMimeType("text/plain")).toBe(true);
      expect(isTextMimeType("text/markdown")).toBe(true);
      expect(isTextMimeType("text/html")).toBe(true);
      expect(isTextMimeType("text/css")).toBe(true);
      expect(isTextMimeType("text/javascript")).toBe(true);
      expect(isTextMimeType("text/x-python")).toBe(true);
      expect(isTextMimeType("text/csv")).toBe(true);
    });

    it("returns true for whitelisted application/* types", () => {
      expect(isTextMimeType("application/json")).toBe(true);
      expect(isTextMimeType("application/xml")).toBe(true);
      expect(isTextMimeType("application/javascript")).toBe(true);
      expect(isTextMimeType("application/x-yaml")).toBe(true);
      expect(isTextMimeType("application/sql")).toBe(true);
    });

    it("returns false for other application/* types", () => {
      expect(isTextMimeType("application/pdf")).toBe(false);
      expect(isTextMimeType("application/zip")).toBe(false);
      expect(isTextMimeType("application/octet-stream")).toBe(false);
      expect(isTextMimeType("application/msword")).toBe(false);
    });

    it("returns false for image/* types", () => {
      expect(isTextMimeType("image/png")).toBe(false);
      expect(isTextMimeType("image/jpeg")).toBe(false);
      expect(isTextMimeType("image/gif")).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isTextMimeType(undefined)).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isTextMimeType("")).toBe(false);
    });
  });

  describe("isLikelyTextFilename", () => {
    it("returns true for common text file extensions and names", () => {
      expect(isLikelyTextFilename("script.ts")).toBe(true);
      expect(isLikelyTextFilename("notes.md")).toBe(true);
      expect(isLikelyTextFilename("config.yaml")).toBe(true);
      expect(isLikelyTextFilename("Dockerfile")).toBe(true);
      expect(isLikelyTextFilename(".gitignore")).toBe(true);
    });

    it("returns false for likely binary filenames", () => {
      expect(isLikelyTextFilename("archive.zip")).toBe(false);
      expect(isLikelyTextFilename("photo.png")).toBe(false);
      expect(isLikelyTextFilename(undefined)).toBe(false);
    });
  });
});
