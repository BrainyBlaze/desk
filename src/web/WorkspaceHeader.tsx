import { memo, useEffect, useState } from 'react';
import { useBleeps } from '@arwes/react';
import {
  Bell,
  Menu,
  RefreshCw,
  Settings as SettingsIcon,
  Skull,
  TerminalSquare,
  Volume2,
  VolumeX,
  Zap
} from 'lucide-react';
import { Cmd, Pill, TextReveal } from './arwes/primitives.js';
import type { DeskBleepName } from './arwes/bleeps.js';
import { CommandButton, HeaderClock, TelemetryCell } from './headerPrimitives.js';
import { useNarrowViewport } from './sidebarPanel.js';
import {
  formatBytes,
  formatGpuDetail,
  formatGpuValue,
  formatLoad,
  formatPercent,
  formatRate,
  formatStorage,
  formatUptime,
  telemetryPlaceholder,
  telemetryTileText,
  type SparkSample
} from './systemFormat.js';
import type { DeskSnapshot, SystemSnapshot } from './types.js';

function WorkspaceHeaderImpl({
  snapshot,
  systemSnapshot,
  systemError,
  telemetryHistory,
  busy,
  muted,
  unreadEvents,
  onToggleMuted,
  onToggleNotifications,
  onOpenSettings,
  onKillAll,
  onRefresh,
  onUp,
  onOpenConfig
}: {
  snapshot: DeskSnapshot | null;
  systemSnapshot: SystemSnapshot | null;
  systemError: string | null;
  telemetryHistory: { cpu: SparkSample[]; ram: SparkSample[]; gpu: SparkSample[]; net: SparkSample[]; disk: SparkSample[] };
  busy: boolean;
  muted: boolean;
  unreadEvents: number;
  onToggleMuted: () => void;
  onToggleNotifications: () => void;
  onOpenSettings: () => void;
  onKillAll: () => void;
  onRefresh: () => Promise<void>;
  onUp: () => Promise<void>;
  onOpenConfig: () => void;
}): JSX.Element {
  const totals = snapshot?.view.totals;
  const nvidia = systemSnapshot?.gpu.nvidia;
  const intel = systemSnapshot?.gpu.intel;
  // The pulse is failing whenever an error is set — whether it never delivered
  // a first snapshot or died after one. A stale snapshot must still read as a
  // warning, not as calm live numbers.
  const pulseDown = Boolean(systemError);
  const placeholder = telemetryPlaceholder(systemError);
  const warnTone = pulseDown ? ('warn' as const) : undefined;
  const tileText = (measured: string | false | null | undefined, unmeasured: string): string =>
    telemetryTileText(measured, unmeasured, Boolean(systemSnapshot), placeholder);
  const bleeps = useBleeps<DeskBleepName>();
  const narrowViewport = useNarrowViewport();
  // Phone band: the toolbar collapses into a burger; this owns that menu.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!narrowViewport) {
      setMenuOpen(false);
    }
  }, [narrowViewport]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setMenuOpen(false);
      }
    };
    // Capture phase: the menu owns Escape ahead of subsystem handlers
    // (thread panel close, etc.) while it is open.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menuOpen]);
  const missing = totals?.missing ?? 0;
  // One cell per adapter that actually exists; a permanently "N/A" adapter
  // wasted a whole slot. When nothing is available a single N/A cell keeps the
  // reason visible — but on darwin nvidia-smi is structurally absent, so that
  // fallback is pure noise and the row shows no GPU cell at all (Linux keeps
  // it, where N/A diagnoses a missing driver). An Apple GPU reader will fill
  // the slot honestly in a later phase.
  const gpuEntries = [
    { label: 'NVIDIA', gpu: nvidia, spark: telemetryHistory.gpu },
    { label: 'INTEL', gpu: intel, spark: undefined }
  ];
  const availableGpus = gpuEntries.filter((entry) => entry.gpu?.available);
  const gpuFallback = systemSnapshot?.platform === 'darwin' ? [] : [gpuEntries[0]];
  // With a snapshot present (even a stale one under warn) the real adapter
  // cells stay, so a failing pulse does not throw away GPU numbers its sibling
  // tiles still show; only a first load with no snapshot collapses to one
  // placeholder cell.
  const gpuCells = systemSnapshot
    ? (availableGpus.length > 0 ? availableGpus : gpuFallback).map((entry) => ({
        label: entry.label,
        value: formatGpuValue(entry.gpu),
        sub: formatGpuDetail(entry.gpu),
        tone: warnTone ?? ((entry.gpu?.available ? 'ok' : 'muted') as 'ok' | 'muted'),
        title:
          entry.gpu?.available && entry.spark
            ? `${entry.gpu.name ?? 'GPU'} | sparkline: last 2 min, 0–100%`
            : entry.gpu?.name,
        spark: entry.gpu?.available ? entry.spark : undefined
      }))
    : [{ label: 'GPU', value: placeholder, sub: '', tone: warnTone, title: undefined, spark: undefined }];
  return (
    <header className="workspaceTopbar">
      <div className="topbarPrimary">
        <div className="brand">
          <TerminalSquare size={14} />
          <TextReveal as="strong" manager="decipher">Desk</TextReveal>
          {snapshot?.configPath ? (
            <button
              type="button"
              className="brandPath"
              title={`${snapshot.configPath} — open in editor`}
              onClick={() => {
                bleeps.click?.play();
                onOpenConfig();
              }}
            >
              {snapshot.configPath}
            </button>
          ) : (
            <span>loading config</span>
          )}
        </div>
        <div className="projectStats" aria-label="Project stats">
          <Pill title="Projects"><b>P</b> {totals?.projects ?? 0}</Pill>
          <Pill title="Groups"><b>G</b> {totals?.groups ?? 0}</Pill>
          <Pill title="Configured agent sessions"><b>A</b> {totals?.sessions ?? 0}</Pill>
          <Pill tone="ok" title="Agents with a live session"><b>RUN</b> {totals?.running ?? 0}</Pill>
          <Pill
            tone={totals?.missing ? 'warn' : 'ok'}
            pulse={Boolean(totals?.missing)}
            title={totals?.missing ? 'Configured sessions without a live session - click to boot them (Up)' : 'Configured sessions without a live session'}
            onClick={totals?.missing && !busy ? () => void onUp() : undefined}
          >
            <b>MISS</b> {totals?.missing ?? 0}
          </Pill>
        </div>
        <HeaderClock />
        <div className="toolbar">
          <span className="toolbarGroup cmdMobileHidden">
            <CommandButton
              icon={<RefreshCw size={13} className={busy ? 'spinSlow' : undefined} />}
              label="Refresh"
              title="Re-reads fleet state; 2-second pulse keeps liveness, attention, and telemetry current in background (paused when tab is hidden)"
              onClick={onRefresh}
              disabled={busy}
            />
            <CommandButton
              icon={<Zap size={13} />}
              label="Up"
              title="Starts all missing sessions from manifest without touching running ones"
              onClick={() => {
                bleeps.deploy?.play();
                void onUp();
              }}
              disabled={busy}
            />
          </span>
          <span className="toolbarGroup cmdMobileHidden">
            <Cmd icon={<Skull size={13} />} label="KILL" title="Emergency stop: kills all Claude Code and Codex CLI processes on host. Confirms with alarm first. Last resort only." tone="danger" onClick={onKillAll} />
          </span>
          <span className="toolbarGroup">
            <span className="cmdSlot cmdMobileHidden">
              <Cmd
                icon={muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                label={muted ? 'Muted' : 'Sound'}
                pressed={muted}
                onClick={onToggleMuted}
              />
            </span>
            <span className="notifButtonWrap">
              <CommandButton icon={<Bell size={13} />} label="Events" onClick={onToggleNotifications} />
              {unreadEvents > 0 ? (
                <span className="notifLamp withCount" aria-label={`${unreadEvents} unread notifications`}>
                  {unreadEvents > 99 ? '99+' : unreadEvents}
                </span>
              ) : null}
            </span>
            <span className="cmdSlot cmdMobileHidden">
              <CommandButton icon={<SettingsIcon size={13} />} label="Settings" onClick={onOpenSettings} />
            </span>
            <span className="cmdSlot cmdMobileOnly">
              <Cmd
                icon={<Menu size={13} />}
                label="Menu"
                pressed={menuOpen}
                expanded={menuOpen}
                controls="desk-header-menu"
                onClick={() => setMenuOpen((open) => !open)}
              />
            </span>
          </span>
        </div>
      </div>
      {menuOpen ? (
        <>
          <div className="headerMenuScrim" onClick={() => setMenuOpen(false)} />
          <nav className="headerMenu" id="desk-header-menu" aria-label="Desk controls">
            <button
              type="button"
              className="headerMenuItem"
              disabled={busy}
              onClick={() => {
                bleeps.click?.play();
                setMenuOpen(false);
                void onRefresh();
              }}
            >
              <RefreshCw size={14} className={busy ? 'spinSlow' : undefined} />
              <span className="headerMenuLabel">
                Refresh
                <small>re-read the manifest and runtime state</small>
              </span>
            </button>
            <button
              type="button"
              className="headerMenuItem"
              disabled={busy || missing === 0}
              onClick={() => {
                bleeps.deploy?.play();
                setMenuOpen(false);
                void onUp();
              }}
            >
              <Zap size={14} />
              <span className="headerMenuLabel">
                Up
                <small>
                  {missing > 0
                    ? `start ${missing} missing session${missing === 1 ? '' : 's'}`
                    : 'all sessions running'}
                </small>
              </span>
            </button>
            <button
              type="button"
              className="headerMenuItem"
              aria-pressed={muted}
              onClick={() => {
                bleeps.click?.play();
                onToggleMuted();
              }}
            >
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              <span className="headerMenuLabel">
                Sound
                <small>{muted ? 'muted — tap to enable' : 'on — tap to mute'}</small>
              </span>
            </button>
            <button
              type="button"
              className="headerMenuItem"
              onClick={() => {
                bleeps.click?.play();
                setMenuOpen(false);
                onOpenSettings();
              }}
            >
              <SettingsIcon size={14} />
              <span className="headerMenuLabel">
                Settings
                <small>theme &amp; preferences</small>
              </span>
            </button>
            <button
              type="button"
              className="headerMenuItem danger"
              onClick={() => {
                bleeps.click?.play();
                setMenuOpen(false);
                onKillAll();
              }}
            >
              <Skull size={14} />
              <span className="headerMenuLabel">
                Kill all
                <small>terminate every agent process</small>
              </span>
            </button>
          </nav>
        </>
      ) : null}
      <div className="topbarTelemetry">
        {/* Phone-band fleet stats: the projectStats pills die with the wide
            primary row, but RUN/MISS are the two operationally vital counts —
            they reappear here as compact chips (desktop hides this cluster). */}
        <div className="telemetryFleet" aria-label="Fleet stats">
          <Pill tone="ok" title="Agents with a live session"><b>RUN</b> {totals?.running ?? 0}</Pill>
          <Pill
            tone={totals?.missing ? 'warn' : 'ok'}
            pulse={Boolean(totals?.missing)}
            title={totals?.missing ? 'Configured sessions without a live session - click to boot them (Up)' : 'Configured sessions without a live session'}
            onClick={totals?.missing && !busy ? () => void onUp() : undefined}
          >
            <b>MISS</b> {totals?.missing ?? 0}
          </Pill>
        </div>
        <TelemetryCell
          label="HOST"
          value={systemSnapshot?.hostname ?? placeholder}
          sub={
            pulseDown
              ? systemError ?? placeholder
              : systemSnapshot
                ? `up ${formatUptime(systemSnapshot.uptimeSeconds)} | ${systemSnapshot.kernel}`
                : placeholder
          }
          title={systemSnapshot ? `${systemSnapshot.platform} ${systemSnapshot.kernel}` : undefined}
          tone={warnTone}
        />
        <TelemetryCell
          label="CPU"
          value={systemSnapshot ? formatPercent(systemSnapshot.cpu.usagePercent) : placeholder}
          sub={systemSnapshot ? formatLoad(systemSnapshot) : placeholder}
          title="CPU utilization | sparkline: last 2 min, 0–100%"
          tone={warnTone}
          spark={telemetryHistory.cpu}
        />
        <TelemetryCell
          label="RAM"
          value={tileText(systemSnapshot?.memory && formatPercent(systemSnapshot.memory.usedPercent), 'unmeasured')}
          sub={tileText(
            systemSnapshot?.memory &&
              `${formatBytes(systemSnapshot.memory.usedBytes)} / ${formatBytes(systemSnapshot.memory.totalBytes)}`,
            'unmeasured'
          )}
          title="Memory used / total | sparkline: last 2 min, 0–100%"
          tone={warnTone}
          spark={telemetryHistory.ram}
        />
        {gpuCells.map((cell) => (
          <TelemetryCell
            key={cell.label}
            label={cell.label}
            value={cell.value}
            sub={cell.sub}
            tone={cell.tone}
            title={cell.title}
            spark={cell.spark}
          />
        ))}
        <TelemetryCell
          label="NET"
          value={tileText(
            systemSnapshot &&
              systemSnapshot.network.interfaces.length > 0 &&
              `${formatRate(systemSnapshot.network.rxBytesPerSecond)} down`,
            'unmeasured'
          )}
          sub={tileText(
            systemSnapshot &&
              systemSnapshot.network.interfaces.length > 0 &&
              `${formatRate(systemSnapshot.network.txBytesPerSecond)} up`,
            'no interfaces'
          )}
          title="Aggregate throughput across interfaces | sparkline: download, autoscaled to 2-min peak"
          tone={warnTone}
          spark={telemetryHistory.net}
          sparkFloor={1}
        />
        <TelemetryCell
          label="DISK"
          value={tileText(
            systemSnapshot?.disk &&
              `${formatPercent(systemSnapshot.disk.usedPercent)} | ${formatStorage(systemSnapshot.disk.usedBytes, systemSnapshot.disk.totalBytes)}`,
            'unmeasured'
          )}
          sub={tileText(
            systemSnapshot?.disk?.readBytesPerSecond !== undefined &&
              `r ${formatRate(systemSnapshot.disk.readBytesPerSecond)} | w ${formatRate(systemSnapshot.disk.writeBytesPerSecond)}`,
            'io init'
          )}
          title="Root filesystem usage and whole-disk I/O"
          tone={warnTone ?? (systemSnapshot?.disk && systemSnapshot.disk.usedPercent >= 90 ? 'warn' : undefined)}
          spark={telemetryHistory.disk}
          sparkFloor={1}
        />
      </div>
    </header>
  );
}

export const WorkspaceHeader = memo(WorkspaceHeaderImpl);
