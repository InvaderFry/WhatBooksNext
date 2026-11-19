// Which version of the app is running, for Diagnostics and its report.
//
// The version number is `version` in package.json (raised with each merged change). The commit
// and its date come from build-info.txt: .gitattributes marks it `export-subst`, so GitHub's
// "Download ZIP" (a `git archive`) writes the commit's hash and date into it. A git checkout keeps
// the placeholder, so the commit is read from git instead. Neither available: unknown.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface AppVersion {
  version: string | null;
  commit: string | null;
  /** When that commit was made (ISO 8601): the date of this version. */
  commitDate: string | null;
  /** zip: from a downloaded ZIP; git: a git checkout; unknown: neither said. */
  source: 'zip' | 'git' | 'unknown';
}

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** Reads "<40-hex hash> <ISO date>" as GitHub writes it; the unexpanded placeholder gives null. */
export function parseBuildInfo(text: string): { commit: string; commitDate: string } | null {
  const m = /^([0-9a-f]{40})\s+(\d{4}-\d\d-\d\dT\S+)\s*$/.exec(text.trim());
  const [, commit, commitDate] = m ?? [];
  if (!commit || !commitDate || Number.isNaN(Date.parse(commitDate))) return null;
  return { commit, commitDate };
}

function readVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function fromGit(root: string): { commit: string; commitDate: string } | null {
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%H %cI'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      windowsHide: true,
    });
    return parseBuildInfo(out);
  } catch {
    return null;
  }
}

let cached: AppVersion | undefined;

export function appVersion(root = ROOT): AppVersion {
  if (cached && root === ROOT) return cached;
  let info: { commit: string; commitDate: string } | null = null;
  let source: AppVersion['source'] = 'unknown';
  try {
    info = parseBuildInfo(fs.readFileSync(path.join(root, 'server/src/build-info.txt'), 'utf8'));
    if (info) source = 'zip';
  } catch {
    /* missing: try git */
  }
  if (!info) {
    info = fromGit(root);
    if (info) source = 'git';
  }
  const result: AppVersion = {
    version: readVersion(root),
    commit: info?.commit ?? null,
    commitDate: info?.commitDate ?? null,
    source,
  };
  if (root === ROOT) cached = result;
  return result;
}
