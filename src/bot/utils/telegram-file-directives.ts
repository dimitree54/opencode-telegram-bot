import path from "node:path";

export interface TelegramFileDirective {
  requestedPath: string;
  caption: string;
}

export interface ExtractTelegramFileDirectivesResult {
  cleanedText: string;
  directives: TelegramFileDirective[];
}

const TELEGRAM_FILE_DIRECTIVE_PREFIX = "TELEGRAM_FILE:";

function normalizeCleanedText(lines: string[]): string {
  const joined = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return joined.trim();
}

export function extractTelegramFileDirectives(
  text: string,
): ExtractTelegramFileDirectivesResult {
  const directives: TelegramFileDirective[] = [];
  const preservedLines: string[] = [];
  let inCodeFence = false;

  for (const line of text.split("\n")) {
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith("```")) {
      inCodeFence = !inCodeFence;
      preservedLines.push(line);
      continue;
    }

    if (!inCodeFence && trimmedLine.startsWith(TELEGRAM_FILE_DIRECTIVE_PREFIX)) {
      const payload = trimmedLine.slice(TELEGRAM_FILE_DIRECTIVE_PREFIX.length).trim();
      if (!payload) {
        continue;
      }

      const separatorIndex = payload.indexOf("|");
      const requestedPath =
        separatorIndex >= 0 ? payload.slice(0, separatorIndex).trim() : payload;
      const caption = separatorIndex >= 0 ? payload.slice(separatorIndex + 1).trim() : "";

      if (!requestedPath) {
        continue;
      }

      directives.push({
        requestedPath,
        caption,
      });
      continue;
    }

    preservedLines.push(line);
  }

  return {
    cleanedText: normalizeCleanedText(preservedLines),
    directives,
  };
}

export function resolveTelegramFileDirectivePath(
  baseDir: string,
  requestedPath: string,
): string | null {
  const trimmedBaseDir = baseDir.trim();
  const trimmedRequestedPath = requestedPath.trim();

  if (!trimmedBaseDir || !trimmedRequestedPath) {
    return null;
  }

  const normalizedBaseDir = path.resolve(trimmedBaseDir);
  const absoluteCandidate = path.isAbsolute(trimmedRequestedPath)
    ? path.resolve(trimmedRequestedPath)
    : path.resolve(normalizedBaseDir, trimmedRequestedPath);
  const relativePath = path.relative(normalizedBaseDir, absoluteCandidate);

  if (!relativePath || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))) {
    return absoluteCandidate;
  }

  return null;
}
