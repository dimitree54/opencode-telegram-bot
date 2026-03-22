import type { Context } from "grammy";
import { config } from "../../config.js";
import { processUserPrompt, type ProcessPromptDeps } from "./prompt.js";
import {
  buildTelegramAttachmentPrompt,
  buildTextFilePrompt,
  downloadTelegramFile,
  isLikelyTextFilename,
  isTextMimeType,
  isFileSizeAllowed,
  saveTelegramFileToProject,
  type SavedTelegramFile,
  type SaveTelegramFileOptions,
  toDataUri,
} from "../utils/file-download.js";
import {
  getModelCapabilities,
  supportsAttachment,
  supportsInput,
} from "../../model/capabilities.js";
import { getStoredModel } from "../../model/manager.js";
import { getCurrentProject } from "../../settings/manager.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import type { FilePartInput, Model } from "@opencode-ai/sdk/v2";

export interface DocumentHandlerDeps extends ProcessPromptDeps {
  downloadFile?: (
    api: Context["api"],
    fileId: string,
  ) => Promise<{ buffer: Buffer; filePath: string }>;
  saveFile?: (options: SaveTelegramFileOptions) => Promise<SavedTelegramFile>;
  getProjectRoot?: () => string | undefined;
  getModelCapabilities?: (
    providerId: string,
    modelId: string,
  ) => Promise<Model["capabilities"] | null>;
  getStoredModel?: () => { providerID: string; modelID: string };
  processPrompt?: (
    ctx: Context,
    text: string,
    deps: ProcessPromptDeps,
    fileParts?: FilePartInput[],
  ) => Promise<boolean>;
}

function canAttachDocument(
  capabilities: Model["capabilities"] | null,
  mimeType: string,
): boolean {
  if (!mimeType) {
    return supportsAttachment(capabilities);
  }

  if (mimeType === "application/pdf") {
    return supportsInput(capabilities, "pdf") || supportsAttachment(capabilities);
  }

  if (mimeType.startsWith("image/")) {
    return supportsInput(capabilities, "image") || supportsAttachment(capabilities);
  }

  if (mimeType.startsWith("audio/")) {
    return supportsInput(capabilities, "audio") || supportsAttachment(capabilities);
  }

  if (mimeType.startsWith("video/")) {
    return supportsInput(capabilities, "video") || supportsAttachment(capabilities);
  }

  return supportsAttachment(capabilities);
}

function resolveProjectRoot(getProjectRoot: (() => string | undefined) | undefined): string | undefined {
  return getProjectRoot?.() || getCurrentProject()?.worktree || config.opencode.defaultProjectPath || undefined;
}

function getMessageDate(ctx: Context): Date {
  const timestampSeconds = ctx.message?.date;
  if (typeof timestampSeconds === "number") {
    return new Date(timestampSeconds * 1000);
  }

  return new Date();
}

async function saveDownloadedFile(
  saveFile: (options: SaveTelegramFileOptions) => Promise<SavedTelegramFile>,
  projectRoot: string | undefined,
  buffer: Buffer,
  filename: string,
  mimeType: string,
  createdAt: Date,
): Promise<SavedTelegramFile | undefined> {
  if (!projectRoot) {
    return undefined;
  }

  try {
    return await saveFile({
      projectRoot,
      buffer,
      originalFilename: filename,
      fallbackFilename: filename,
      mimeType,
      createdAt,
    });
  } catch (error) {
    logger.warn(`[Document] Failed to save Telegram file locally: ${filename}`, error);
    return undefined;
  }
}

export async function handleDocumentMessage(
  ctx: Context,
  deps: DocumentHandlerDeps,
): Promise<void> {
  const downloadFile = deps.downloadFile ?? downloadTelegramFile;
  const saveFile = deps.saveFile ?? saveTelegramFileToProject;
  const getCapabilities = deps.getModelCapabilities ?? getModelCapabilities;
  const getStored = deps.getStoredModel ?? getStoredModel;
  const processPrompt = deps.processPrompt ?? processUserPrompt;

  const doc = ctx.message?.document;
  if (!doc) {
    return;
  }

  const caption = ctx.message.caption || "";
  const mimeType = doc.mime_type || "";
  const filename = doc.file_name || "document";
  const projectRoot = resolveProjectRoot(deps.getProjectRoot);
  const createdAt = getMessageDate(ctx);

  try {
    if (isTextMimeType(mimeType) || isLikelyTextFilename(filename)) {
      if (!isFileSizeAllowed(doc.file_size, config.files.maxFileSizeKb)) {
        logger.warn(
          `[Document] Text file too large: ${filename} (${doc.file_size} bytes > ${config.files.maxFileSizeKb}KB)`,
        );
        await ctx.reply(
          t("bot.text_file_too_large", { maxSizeKb: String(config.files.maxFileSizeKb) }),
        );
        return;
      }

      await ctx.reply(t("bot.file_downloading"));
      const downloadedFile = await downloadFile(ctx.api, doc.file_id);
      const savedFile = await saveDownloadedFile(
        saveFile,
        projectRoot,
        downloadedFile.buffer,
        filename,
        mimeType || "text/plain",
        createdAt,
      );

      const textContent = downloadedFile.buffer.toString("utf-8");
      const promptWithFile = buildTextFilePrompt(
        filename,
        textContent,
        caption,
        savedFile?.relativePath,
      );

      logger.info(
        `[Document] Sending text file (${downloadedFile.buffer.length} bytes, ${filename}) as prompt`,
      );

      await processPrompt(ctx, promptWithFile, deps);
      return;
    }

    await ctx.reply(t("bot.file_downloading"));
    const downloadedFile = await downloadFile(ctx.api, doc.file_id);
    const savedFile = await saveDownloadedFile(
      saveFile,
      projectRoot,
      downloadedFile.buffer,
      filename,
      mimeType || "application/octet-stream",
      createdAt,
    );

    const storedModel = getStored();
    const capabilities = await getCapabilities(storedModel.providerID, storedModel.modelID);

    if (!canAttachDocument(capabilities, mimeType)) {
      logger.warn(
        `[Document] Model ${storedModel.providerID}/${storedModel.modelID} doesn't support attachment type ${mimeType || "unknown"}`,
      );
      await ctx.reply(
        mimeType === "application/pdf" ? t("bot.model_no_pdf") : t("bot.model_no_attachment"),
      );

      const fallbackPrompt = caption.trim().length > 0
        ? buildTelegramAttachmentPrompt(caption, savedFile?.relativePath, "")
        : "";
      if (fallbackPrompt.length > 0) {
        await processPrompt(ctx, fallbackPrompt, deps);
      }
      return;
    }

    const filePart: FilePartInput = {
      type: "file",
      mime: mimeType || "application/octet-stream",
      filename: filename,
      url: toDataUri(downloadedFile.buffer, mimeType || "application/octet-stream"),
    };

    logger.info(
      `[Document] Sending attachment (${downloadedFile.buffer.length} bytes, ${filename}, mime=${mimeType || "application/octet-stream"}) with prompt`,
    );

    const promptText = buildTelegramAttachmentPrompt(
      caption,
      savedFile?.relativePath,
      savedFile ? "" : "See attached file.",
    );

    await processPrompt(ctx, promptText, deps, [filePart]);
  } catch (err) {
    logger.error("[Document] Error handling document message:", err);
    await ctx.reply(t("bot.file_download_error"));
  }
}
