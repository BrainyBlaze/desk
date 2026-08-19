import { useState, type FormEvent } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { AgentProfile, ProfileProvider } from '../core/types.js';
import { AGENT_PROFILE_PROVIDER_IDS } from '../shared/agentRegistry.js';
import { isProfileProvider } from '../shared/agentProfiles.js';
import {
  createAgentProfile,
  deleteAgentProfile,
  updateAgentProfile
} from './api.js';
import { toErrorMessage } from './asyncSafe.js';
import { CommandButton } from './headerPrimitives.js';
import { DeskSelect, IconButton } from './arwes/primitives.js';

const PROVIDER_OPTIONS = AGENT_PROFILE_PROVIDER_IDS.map((id) => ({
  value: id,
  label: id.charAt(0).toUpperCase() + id.slice(1)
}));

export function AgentProfilesSettings({
  profiles,
  onProfilesChange
}: {
  profiles: AgentProfile[];
  onProfilesChange: (profiles: AgentProfile[]) => void;
}): JSX.Element {
  const [provider, setProvider] = useState<ProfileProvider>('codex');
  const [label, setLabel] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createProfile(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextLabel = label.trim();
    if (!nextLabel) {
      setError('Profile label is required');
      return;
    }
    setBusyId('create');
    setError(null);
    try {
      const response = await createAgentProfile({ provider, label: nextLabel });
      onProfilesChange(response.profiles);
      setLabel('');
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function saveProfile(profile: AgentProfile): Promise<void> {
    const nextLabel = editingLabel.trim();
    if (!nextLabel) {
      setError('Profile label is required');
      return;
    }
    if (nextLabel === profile.label) {
      setEditingId(null);
      return;
    }
    setBusyId(profile.id);
    setError(null);
    try {
      const response = await updateAgentProfile({ id: profile.id, label: nextLabel });
      onProfilesChange(response.profiles);
      setEditingId(null);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function removeProfile(profile: AgentProfile): Promise<void> {
    setBusyId(profile.id);
    setError(null);
    try {
      const response = await deleteAgentProfile(profile.id);
      onProfilesChange(response.profiles);
      setDeleteId(null);
      if (editingId === profile.id) {
        setEditingId(null);
      }
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="agentProfilesSettings">
      <form className="profileCreateForm thinForm" onSubmit={(event) => void createProfile(event)}>
        <label>
          <span>Provider</span>
          <DeskSelect
            value={provider}
            options={PROVIDER_OPTIONS}
            onChange={(value) => {
              if (isProfileProvider(value)) {
                setProvider(value);
              }
            }}
          />
        </label>
        <label>
          <span>Profile label</span>
          <input
            value={label}
            maxLength={64}
            placeholder="Work account"
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <CommandButton
          icon={<Plus size={12} />}
          label="Add profile"
          disabled={busyId !== null || label.trim() === ''}
          submit
        />
      </form>

      {error ? (
        <div className="profileSettingsError" role="alert">
          {error}
        </div>
      ) : null}

      <div className="profileList" aria-live="polite">
        {profiles.length === 0 ? (
          <div className="profileEmpty">No agent profiles configured.</div>
        ) : (
          profiles.map((profile) => {
            const editing = editingId === profile.id;
            const confirmingDelete = deleteId === profile.id;
            const busy = busyId === profile.id;
            return (
              <div className="profileRow" key={profile.id}>
                <div className="profileProvider">{profile.provider}</div>
                <div className="profileIdentity">
                  {editing ? (
                    <input
                      aria-label={`Profile label for ${profile.id}`}
                      value={editingLabel}
                      maxLength={64}
                      disabled={busy}
                      autoFocus
                      onChange={(event) => setEditingLabel(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void saveProfile(profile);
                        }
                        if (event.key === 'Escape') {
                          setEditingId(null);
                        }
                      }}
                    />
                  ) : (
                    <strong>{profile.label}</strong>
                  )}
                  <span className="profileId">{profile.id}</span>
                  <small>Account status unavailable</small>
                </div>
                <div className="profileActions">
                  {editing ? (
                    <>
                      <IconButton
                        icon={<Check size={13} />}
                        label={`Save ${profile.label}`}
                        disabled={busy || editingLabel.trim() === ''}
                        onClick={() => void saveProfile(profile)}
                      />
                      <IconButton
                        icon={<X size={13} />}
                        label={`Cancel editing ${profile.label}`}
                        disabled={busy}
                        onClick={() => setEditingId(null)}
                      />
                    </>
                  ) : confirmingDelete ? (
                    <>
                      <span className="profileDeletePrompt">Delete?</span>
                      <IconButton
                        icon={<Check size={13} />}
                        label={`Confirm deleting ${profile.label}`}
                        disabled={busy}
                        onClick={() => void removeProfile(profile)}
                      />
                      <IconButton
                        icon={<X size={13} />}
                        label={`Cancel deleting ${profile.label}`}
                        disabled={busy}
                        onClick={() => setDeleteId(null)}
                      />
                    </>
                  ) : (
                    <>
                      <IconButton
                        icon={<Pencil size={13} />}
                        label={`Rename ${profile.label}`}
                        disabled={busyId !== null}
                        onClick={() => {
                          setDeleteId(null);
                          setEditingId(profile.id);
                          setEditingLabel(profile.label);
                          setError(null);
                        }}
                      />
                      <IconButton
                        icon={<Trash2 size={13} />}
                        label={`Delete ${profile.label}`}
                        disabled={busyId !== null}
                        onClick={() => {
                          setEditingId(null);
                          setDeleteId(profile.id);
                          setError(null);
                        }}
                      />
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
