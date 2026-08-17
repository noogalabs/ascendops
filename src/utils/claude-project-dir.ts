import { closeSync, existsSync, openSync, readSync, readdirSync } from 'fs';
import { join } from 'path';

const TRANSCRIPT_HEAD_BYTES = 64 * 1024;
const DISCOVERY_MISS_TTL_MS = 5 * 60 * 1000;

type DiscoveryCacheEntry =
  | { path: string; expiresAt?: never }
  | { path: null; expiresAt: number };

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

/**
 * Mirror Claude Code's project-directory slug for ordinary paths.
 *
 * This mapping is deliberately many-to-one: `my_org`, `my-org`, and `my.org`
 * all map to `my-org`. Claude owns that collision behavior; cortextOS mirrors it
 * so it can find Claude's transcripts without applying OS-specific separators.
 */
export function claudeProjectDirName(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function transcriptHeadContainsLaunchDir(transcriptPath: string, launchDirJson: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf-8', 0, bytesRead).includes(launchDirJson);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch { /* best effort */ }
    }
  }
}

/**
 * Resolve Claude's transcript directory by prediction, then discovery on miss.
 *
 * Discovery is the compatibility path for private naming changes such as
 * Claude's long-path truncation. JSON.stringify is load-bearing here: Windows
 * backslashes are escaped in JSONL transcripts and a raw path search misses.
 */
export function resolveClaudeProjectDir(
  launchDir: string,
  homeDir: string,
  log: (message: string) => void,
): string | null {
  const projectsDir = join(homeDir, '.claude', 'projects');
  const predictedName = claudeProjectDirName(launchDir);
  const predictedDir = join(projectsDir, predictedName);
  if (existsSync(predictedDir)) return predictedDir;

  const cacheKey = `${homeDir}|${launchDir}`;
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.path !== null) {
    if (existsSync(cached.path)) return cached.path;
    discoveryCache.delete(cacheKey);
  } else if (cached && cached.expiresAt > Date.now()) {
    return null;
  } else if (cached) {
    discoveryCache.delete(cacheKey);
  }

  const logMiss = (): void => {
    log(
      `claude-projects lookup MISS for ${launchDir} (predicted ${predictedName}, discovery found nothing) - session treated as fresh; --continue context will not be preserved`,
    );
  };
  const cacheMiss = (): null => {
    discoveryCache.set(cacheKey, { path: null, expiresAt: Date.now() + DISCOVERY_MISS_TTL_MS });
    logMiss();
    return null;
  };

  const launchDirJson = JSON.stringify(launchDir);
  try {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === predictedName) continue;
      const candidateDir = join(projectsDir, entry.name);
      let transcriptFiles: string[];
      try {
        transcriptFiles = readdirSync(candidateDir).filter((file) => file.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const transcriptFile of transcriptFiles) {
        if (!transcriptHeadContainsLaunchDir(join(candidateDir, transcriptFile), launchDirJson)) continue;
        discoveryCache.set(cacheKey, { path: candidateDir });
        log(`projects-dir naming drift: predicted ${predictedName}, found ${entry.name}`);
        return candidateDir;
      }
    }
  } catch {
    return cacheMiss();
  }

  return cacheMiss();
}
