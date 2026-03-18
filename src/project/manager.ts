import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { opencodeClient } from "../opencode/client.js";
import { ProjectInfo } from "../settings/manager.js";
import { getCachedSessionProjects } from "../session/cache-manager.js";
import { logger } from "../utils/logger.js";

interface InternalProject extends ProjectInfo {
  lastUpdated: number;
}

interface ProjectApiShape {
  id: string;
  worktree: string;
  name?: string;
  time?: {
    updated?: number;
  };
}

function toInternalProject(project: ProjectApiShape): InternalProject {
  return {
    id: project.id,
    worktree: project.worktree,
    name: project.name || project.worktree,
    lastUpdated: project.time?.updated ?? 0,
  };
}

async function isLinkedGitWorktree(worktree: string): Promise<boolean> {
  if (worktree === "/") {
    return false;
  }

  const gitPath = path.join(worktree, ".git");

  try {
    const gitStat = await stat(gitPath);

    if (!gitStat.isFile()) {
      return false;
    }

    const gitPointer = (await readFile(gitPath, "utf-8")).trim();
    const match = gitPointer.match(/^gitdir:\s*(.+)$/i);
    if (!match) {
      return false;
    }

    const gitDir = path.resolve(worktree, match[1].trim()).replace(/\\/g, "/").toLowerCase();
    return gitDir.includes("/.git/worktrees/");
  } catch {
    return false;
  }
}

function worktreeKey(worktree: string): string {
  if (process.platform === "win32") {
    return worktree.toLowerCase();
  }

  return worktree;
}

function getConfiguredDefaultProject(): InternalProject | null {
  const worktree = (process.env.OPENCODE_DEFAULT_PROJECT_PATH || "").trim();
  if (!worktree) {
    return null;
  }

  return {
    id: `default:${worktree}`,
    worktree,
    name: (process.env.OPENCODE_DEFAULT_PROJECT_NAME || "").trim() || worktree,
    lastUpdated: Number.MAX_SAFE_INTEGER,
  };
}

export async function getProjects(): Promise<ProjectInfo[]> {
  const { data: projects, error } = await opencodeClient.project.list();

  if (error || !projects) {
    throw error || new Error("No data received from server");
  }

  let currentProject: InternalProject | null = null;

  try {
    const { data } = await opencodeClient.project.current();
    if (data) {
      currentProject = toInternalProject(data as ProjectApiShape);
    }
  } catch (currentProjectError) {
    logger.debug("[ProjectManager] Failed to load current project", currentProjectError);
  }

  const apiProjects: InternalProject[] = projects.map((project) => toInternalProject(project));

  const cachedProjects = await getCachedSessionProjects();
  const mergedByWorktree = new Map<string, InternalProject>();

  for (const apiProject of apiProjects) {
    mergedByWorktree.set(worktreeKey(apiProject.worktree), apiProject);
  }

  if (currentProject) {
    mergedByWorktree.set(worktreeKey(currentProject.worktree), currentProject);
  }

  const configuredDefaultProject = getConfiguredDefaultProject();
  if (configuredDefaultProject) {
    const key = worktreeKey(configuredDefaultProject.worktree);
    if (!mergedByWorktree.has(key)) {
      mergedByWorktree.set(key, configuredDefaultProject);
    }
  }

  for (const cachedProject of cachedProjects) {
    const key = worktreeKey(cachedProject.worktree);
    const existing = mergedByWorktree.get(key);

    if (existing) {
      if ((cachedProject.lastUpdated ?? 0) > existing.lastUpdated) {
        existing.lastUpdated = cachedProject.lastUpdated;
      }
      continue;
    }

    mergedByWorktree.set(key, {
      id: cachedProject.id,
      worktree: cachedProject.worktree,
      name: cachedProject.name,
      lastUpdated: cachedProject.lastUpdated ?? 0,
    });
  }

  const projectList = Array.from(mergedByWorktree.values()).sort(
    (left, right) => right.lastUpdated - left.lastUpdated,
  );

  const linkedWorktreeFlags = await Promise.all(
    projectList.map((project) => isLinkedGitWorktree(project.worktree)),
  );

  const visibleProjects = projectList.filter((_, index) => !linkedWorktreeFlags[index]);
  const hiddenLinkedWorktrees = projectList.length - visibleProjects.length;

  logger.debug(
    `[ProjectManager] Projects resolved: api=${projects.length}, cached=${cachedProjects.length}, current=${currentProject ? 1 : 0}, configuredDefault=${configuredDefaultProject ? 1 : 0}, hiddenLinkedWorktrees=${hiddenLinkedWorktrees}, total=${visibleProjects.length}`,
  );

  return visibleProjects.map(({ id, worktree, name }) => ({ id, worktree, name }));
}

export async function getProjectById(id: string): Promise<ProjectInfo> {
  const projects = await getProjects();
  const project = projects.find((p) => p.id === id);
  if (!project) {
    throw new Error(`Project with id ${id} not found`);
  }
  return project;
}

export async function getProjectByWorktree(worktree: string): Promise<ProjectInfo> {
  const projects = await getProjects();
  const project = projects.find((p) => p.worktree === worktree);
  if (!project) {
    throw new Error(`Project with worktree ${worktree} not found`);
  }
  return project;
}
