import { homedir } from 'node:os';
import { readManifestFile, resolveManifestPath } from '../core/config.js';
import { buildSessionSpecs, parseDeskManifest } from '../core/manifest.js';
import { listTmuxSessions } from '../core/runner.js';
import { buildDeskViewModel } from '../ui/model.js';
import type { DeskGroupSeed, DeskProjectSeed, DeskViewModel } from '../ui/model.js';
import type { DeskManifest } from '../core/types.js';

export interface BuildDeskSnapshotOptions {
  homeDir?: string;
  manifestPath?: string;
  namespace?: string;
}

export interface DeskSnapshot {
  configPath: string;
  view: DeskViewModel;
  generatedAt: string;
}

export function buildDeskSnapshot(options: BuildDeskSnapshotOptions = {}): DeskSnapshot {
  const manifestPath = resolveManifestPath(options.manifestPath);
  const manifest = readManifestFile(manifestPath);
  const sessions = buildSessionSpecs(manifest, {
    homeDir: options.homeDir ?? homedir(),
    namespace: options.namespace
  });

  return {
    configPath: manifestPath,
    view: buildDeskViewModel(sessions, listTmuxSessions(), buildGroupSeeds(manifest), buildProjectSeeds(manifest)),
    generatedAt: new Date().toISOString()
  };
}

export function buildDeskSnapshotFromManifest(
  source: string,
  runningTmuxSessions: Set<string>,
  options: BuildDeskSnapshotOptions = {}
): DeskSnapshot {
  const manifestPath = resolveManifestPath(options.manifestPath);
  const manifest = parseDeskManifest(source);
  const sessions = buildSessionSpecs(manifest, {
    homeDir: options.homeDir ?? homedir(),
    namespace: options.namespace
  });

  return {
    configPath: manifestPath,
    view: buildDeskViewModel(sessions, runningTmuxSessions, buildGroupSeeds(manifest), buildProjectSeeds(manifest)),
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
