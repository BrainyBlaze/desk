import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAtchSocketRoot } from '../shared/atchPaths.js';
import { readManifestFile, resolveManifestPath } from '../core/config.js';
import { buildSessionSpecs, parseDeskManifest } from '../core/manifest.js';
import {
  readClaudeContinuityStatus,
  type ClaudeContinuityStatus
} from './claudeContinuityStatus.js';

import { buildDeskViewModel } from '../ui/model.js';
import type { DeskGroupSeed, DeskProjectSeed, DeskViewModel } from '../ui/model.js';
import type { DeskManifest, SessionSpec } from '../core/types.js';

/** The running set, keyed by durable sessionId (atch socket probe). */
function runningSessionsFor(sessions: readonly SessionSpec[]): Set<string> {
  const socketRoot = resolveAtchSocketRoot();
  const running = new Set<string>();
  for (const session of sessions) {
    if (existsSync(join(socketRoot, `${session.sessionId}.sock`))) {
      running.add(session.sessionId);
    }
  }
  return running;
}

export interface BuildDeskSnapshotOptions {
  homeDir?: string;
  manifestPath?: string;
}

export interface DeskSnapshot {
  configPath: string;
  view: DeskViewModel;
  continuity: ClaudeContinuityStatus;
  generatedAt: string;
}

export function buildDeskSnapshot(options: BuildDeskSnapshotOptions = {}): DeskSnapshot {
  const manifestPath = resolveManifestPath(options.manifestPath);
  const manifest = readManifestFile(manifestPath);
  const homeDir = options.homeDir ?? homedir();
  const sessions = buildSessionSpecs(manifest, {
    homeDir
  });
  const runningSessions = runningSessionsFor(sessions);

  return {
    configPath: manifestPath,
    view: buildDeskViewModel(sessions, runningSessions, buildGroupSeeds(manifest), buildProjectSeeds(manifest)),
    continuity: readClaudeContinuityStatus(sessions, {
      homeDir,
      runningSessions
    }),
    generatedAt: new Date().toISOString()
  };
}

export function buildDeskSnapshotFromManifest(
  source: string,
  runningSessions: Set<string>,
  options: BuildDeskSnapshotOptions = {}
): DeskSnapshot {
  const manifestPath = resolveManifestPath(options.manifestPath);
  const manifest = parseDeskManifest(source);
  const homeDir = options.homeDir ?? homedir();
  const sessions = buildSessionSpecs(manifest, {
    homeDir
  });

  return {
    configPath: manifestPath,
    view: buildDeskViewModel(sessions, runningSessions, buildGroupSeeds(manifest), buildProjectSeeds(manifest)),
    continuity: readClaudeContinuityStatus(sessions, {
      homeDir,
      runningSessions
    }),
    generatedAt: new Date().toISOString()
  };
}

function buildGroupSeeds(manifest: DeskManifest): DeskGroupSeed[] {
  return [
    ...manifest.groups
      .filter((group) => group.sessions.length === 0)
      .map((group) => ({
        id: group.id,
        label: group.label,
        layout: group.layout,
        order: group.order
      })),
    ...(manifest.projects ?? []).flatMap((project) =>
      project.groups.map((group) => ({
        id: group.id,
        label: group.label,
        projectId: project.id,
        projectLabel: project.label,
        projectCwd: project.cwd,
        layout: group.layout,
        order: group.order,
        projectOrder: project.order
      }))
    )
  ];
}

function buildProjectSeeds(manifest: DeskManifest): DeskProjectSeed[] {
  return (manifest.projects ?? []).map((project) => ({
    id: project.id,
    label: project.label,
    cwd: project.cwd,
    order: project.order
  }));
}
