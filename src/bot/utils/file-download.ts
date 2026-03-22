import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Api } from "grammy";
import { config } from "../../config.js";
import { logger } from "../../utils/logger.js";

const TELEGRAM_FILE_URL_BASE = "https://api.telegram.org/file/bot";
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB Telegram limit
const TELEGRAM_DOCUMENTS_STORAGE_DIR = path.join("documents", "inbox");
const TELEGRAM_FALLBACK_STORAGE_DIR = path.join(".telegram-files", "incoming");

export interface DownloadedFile {
  buffer: Buffer;
  filePath: string;
  mimeType?: string;
}

export interface SavedTelegramFile {
  absolutePath: string;
  relativePath: string;
  filename: string;
}

export interface SaveTelegramFileOptions {
  projectRoot: string;
  buffer: Buffer;
  originalFilename?: string;
  fallbackFilename: string;
  mimeType?: string;
  createdAt?: Date;
}

function formatTimestampPrefix(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function buildDateSubdirectory(date: Date): string {
  return path.join(
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  );
}

function sanitizeFilename(filename: string): string {
  const basename = path.basename(filename).normalize("NFKC");
  const sanitized = basename
    .replace(/[\\/]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/g, "");

  return sanitized || "telegram-file";
}

function inferFileExtension(
  originalFilename: string | undefined,
  fallbackFilename: string,
  mimeType: string | undefined,
): string {
  const originalExtension = originalFilename ? path.extname(originalFilename) : "";
  if (originalExtension) {
    return originalExtension;
  }

  const fallbackExtension = path.extname(fallbackFilename);
  if (fallbackExtension) {
    return fallbackExtension;
  }

  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    default:
      return "";
  }
}

function buildStoredFilename(
  originalFilename: string | undefined,
  fallbackFilename: string,
  mimeType: string | undefined,
): string {
  const sanitized = sanitizeFilename(originalFilename || fallbackFilename);
  if (path.extname(sanitized)) {
    return sanitized;
  }

  return `${sanitized}${inferFileExtension(originalFilename, fallbackFilename, mimeType)}`;
}

async function hasDocumentsDirectory(projectRoot: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path.join(projectRoot, "documents"));
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export async function saveTelegramFileToProject({
  projectRoot,
  buffer,
  originalFilename,
  fallbackFilename,
  mimeType,
  createdAt = new Date(),
}: SaveTelegramFileOptions): Promise<SavedTelegramFile> {
  const storageRoot = await hasDocumentsDirectory(projectRoot)
    ? path.join(projectRoot, TELEGRAM_DOCUMENTS_STORAGE_DIR)
    : path.join(projectRoot, TELEGRAM_FALLBACK_STORAGE_DIR);
  const targetDir = path.join(storageRoot, buildDateSubdirectory(createdAt));
  const storedFilename = buildStoredFilename(originalFilename, fallbackFilename, mimeType);
  const uniqueFilename = `${formatTimestampPrefix(createdAt)}-${randomUUID().slice(0, 8)}-${storedFilename}`;
  const absolutePath = path.join(targetDir, uniqueFilename);

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(absolutePath, buffer);

  const relativePath = path.relative(projectRoot, absolutePath).split(path.sep).join("/");
  logger.info(`[FileDownload] Saved Telegram file locally: ${relativePath}`);

  return {
    absolutePath,
    relativePath,
    filename: uniqueFilename,
  };
}

export function buildTelegramAttachmentPrompt(
  caption: string,
  savedRelativePath?: string,
  fallbackInstruction: string = "See attached file.",
): string {
  const sections: string[] = [];

  if (savedRelativePath) {
    sections.push(
      `Telegram file saved locally at \`${savedRelativePath}\`. Use this local path if you need the original file.`,
    );
  }

  const trimmedCaption = caption.trim();
  if (trimmedCaption) {
    sections.push(trimmedCaption);
  } else if (fallbackInstruction) {
    sections.push(fallbackInstruction);
  }

  return sections.join("\n\n");
}

export function buildTextFilePrompt(
  filename: string,
  content: string,
  caption: string,
  savedRelativePath?: string,
): string {
  const sections: string[] = [];

  if (savedRelativePath) {
    sections.push(
      `Telegram file saved locally at \`${savedRelativePath}\`. Use this local path if you need the original file.`,
    );
  }

  sections.push(`--- Content of ${filename} ---\n${content}\n--- End of file ---`);

  const trimmedCaption = caption.trim();
  if (trimmedCaption) {
    sections.push(trimmedCaption);
  }

  return sections.join("\n\n");
}

/**
 * Download a photo from Telegram servers
 * @param api Grammy API instance
 * @param fileId Telegram file_id
 * @returns Downloaded photo buffer and path
 */
export async function downloadTelegramFile(api: Api, fileId: string): Promise<DownloadedFile> {
  logger.debug(`[FileDownload] Getting file info for fileId=${fileId}`);

  const file = await api.getFile(fileId);

  if (!file.file_path) {
    throw new Error("File path not available from Telegram");
  }

  if (file.file_size && file.file_size > MAX_FILE_SIZE_BYTES) {
    const sizeMb = (file.file_size / (1024 * 1024)).toFixed(2);
    throw new Error(`File too large: ${sizeMb}MB (max 20MB)`);
  }

  const fileUrl = `${TELEGRAM_FILE_URL_BASE}${config.telegram.token}/${file.file_path}`;
  logger.debug(`[FileDownload] Downloading from ${fileUrl.replace(config.telegram.token, "***")}`);

  const fetchOptions: RequestInit & { agent?: unknown } = {};

  // Use proxy if configured
  if (config.telegram.proxyUrl) {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    fetchOptions.agent = new HttpsProxyAgent(config.telegram.proxyUrl);
  }

  const response = await fetch(fileUrl, fetchOptions);

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  logger.debug(`[FileDownload] Downloaded ${buffer.length} bytes`);

  return {
    buffer,
    filePath: file.file_path,
  };
}

/**
 * Convert buffer to base64 data URI
 * @param buffer File buffer
 * @param mimeType MIME type (e.g., "image/jpeg")
 * @returns Data URI string
 */
export function toDataUri(buffer: Buffer, mimeType: string): string {
  const base64 = buffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Check if photo size is within limits
 * @param fileSize Photo size in bytes
 * @param maxSizeKb Maximum size in KB (from config)
 * @returns true if within limit
 */
export function isFileSizeAllowed(fileSize: number | undefined, maxSizeKb: number): boolean {
  if (!fileSize) {
    return true; // Unknown size, allow (will be checked on download)
  }

  const maxBytes = maxSizeKb * 1024;
  return fileSize <= maxBytes;
}

/**
 * Get human-readable photo size
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const APPLICATION_TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/sql",
]);

const TEXT_FILE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cfg",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".less",
  ".log",
  ".lua",
  ".md",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svg",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false;
  }

  if (mimeType.startsWith("text/")) {
    return true;
  }

  return APPLICATION_TEXT_MIME_TYPES.has(mimeType);
}

export function isLikelyTextFilename(filename: string | undefined): boolean {
  if (!filename) {
    return false;
  }

  const normalized = filename.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (["dockerfile", ".gitignore", ".npmrc", ".prettierrc", ".eslintrc"].includes(normalized)) {
    return true;
  }

  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex < 0) {
    return false;
  }

  return TEXT_FILE_EXTENSIONS.has(normalized.slice(extensionIndex));
}
