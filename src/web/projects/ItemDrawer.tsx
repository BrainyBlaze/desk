import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Animated, Animator, useBleeps } from '@arwes/react';
import { Archive, ExternalLink, GitBranchPlus, MessageSquarePlus, Pencil, Send, UserPlus, X } from 'lucide-react';
import { Cmd, IconButton, Pill, TextReveal } from '../arwes/primitives.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import {
  projectsItemDetail,
  type FieldValuePayload,
  type ItemDetail,
  type ProjectField,
  type ProjectItem
} from './projectsClient.js';
import { displayValue, valueFor } from './projectsModel.js';
import { FieldEditor } from './FieldEditor.js';
import { itemIcon } from './BoardView.js';

const ItemMarkdown = lazy(() => import('./ItemMarkdown.js'));

const FIELD_EDITABLE = new Set(['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'ITERATION']);

export interface ItemDrawerProps {
  item: ProjectItem | null;
  fields: ProjectField[];
  viewerLogin: string | null;
  /** bumped after mutations so the body/comments refetch */
  revision: number;
  onClose: () => void;
  onSetField: (item: ProjectItem, field: ProjectField, value: FieldValuePayload) => void;
  onIssueState: (item: ProjectItem, state: 'close' | 'reopen') => void;
  onAssignSelf: (item: ProjectItem) => void;
  onComment: (item: ProjectItem, body: string) => Promise<boolean>;
  onArchive: (item: ProjectItem) => void;
  onConvertDraft: (item: ProjectItem) => void;
  onEditDraft: (item: ProjectItem, title: string, body: string) => void;
  onOpenExternal: (item: ProjectItem) => void;
  /** routes a detail-load failure to the parent (e.g. MissingScopeError -> auth degradation) */
  onError?: (error: unknown) => void;
}

export function ItemDrawer({
  item,
  fields,
  viewerLogin,
  revision,
  onClose,
  onSetField,
  onIssueState,
  onAssignSelf,
  onComment,
  onArchive,
  onConvertDraft,
  onEditDraft,
  onOpenExternal,
  onError
}: ItemDrawerProps): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [editingBody, setEditingBody] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const requestSeqRef = useRef(0);

  useEffect(() => {
    setDetail(null);
    setEditingBody(false);
    setLoadError(false);
    if (!item) {
      return;
    }
    const seq = (requestSeqRef.current += 1);
    setLoading(true);
    projectsItemDetail(item.id)
      .then((payload) => {
        if (requestSeqRef.current === seq) {
          setDetail(payload.item);
          setDraftTitle(payload.item.content?.title ?? '');
          setDraftBody(payload.item.content?.body ?? '');
        }
      })
      .catch((error: unknown) => {
        if (requestSeqRef.current === seq) {
          setLoadError(true);
        }
        // Route to the parent so a MissingScopeError still drives the auth-degradation UI.
        if (requestSeqRef.current === seq) {
          onError?.(error);
        }
      })
      .finally(() => {
        if (requestSeqRef.current === seq) {
          setLoading(false);
        }
      });
  }, [item, revision, reloadNonce, onError]);

  const isDraft = item?.type === 'DRAFT_ISSUE';
  const isClosed = item?.content?.state === 'CLOSED' || item?.content?.state === 'MERGED';
  const repoItem = Boolean(item?.content?.repository);

  return (
    <Animator root active={item !== null} manager="stagger" duration={{ enter: 0.3, exit: 0.2, stagger: 0.04 }} unmountOnExited>
      <Animated className="projDrawer" animated={['fade', ['x', 40, 0]]}>
        {item ? (
          <>
            <div className="notifHeader">
              <div className="railTitle">
                {itemIcon(item)}
                <TextReveal as="span" manager="decipher">
                  {item.content?.repository
                    ? `${item.content.repository.nameWithOwner}#${item.content.number}`
                    : 'Draft item'}
                </TextReveal>
                {item.content?.state ? (
                  <Pill tone={isClosed ? 'muted' : 'ok'}>{item.content.state.toLowerCase()}</Pill>
                ) : null}
              </div>
              <div className="railActions">
                {repoItem ? (
                  <IconButton icon={<ExternalLink size={12} />} label="Open on GitHub" onClick={() => onOpenExternal(item)} />
                ) : null}
                <IconButton icon={<X size={12} />} label="Close panel" onClick={onClose} />
              </div>
            </div>

            <div className="projDrawerBody">
              <h3 className="projDrawerTitle">{item.content?.title ?? '(untitled)'}</h3>

              <div className="projDrawerActions">
                {repoItem ? (
                  <>
                    <Cmd
                      icon={<Pencil size={12} />}
                      label={isClosed ? 'Reopen' : 'Close'}
                      tone={isClosed ? undefined : 'danger'}
                      onClick={() => onIssueState(item, isClosed ? 'reopen' : 'close')}
                    />
                    {viewerLogin && !(item.content?.assignees?.nodes ?? []).some((user) => user.login === viewerLogin) ? (
                      <Cmd icon={<UserPlus size={12} />} label="Assign me" onClick={() => onAssignSelf(item)} />
                    ) : null}
                  </>
                ) : null}
                {isDraft ? <Cmd icon={<GitBranchPlus size={12} />} label="Convert to issue" onClick={() => onConvertDraft(item)} /> : null}
                <Cmd
                  icon={<Archive size={12} />}
                  label={item.isArchived ? 'Unarchive' : 'Archive'}
                  onClick={() => onArchive(item)}
                />
              </div>

              <div className="projDrawerFields">
                {fields
                  .filter((field) => FIELD_EDITABLE.has(field.dataType))
                  .map((field) => (
                    <label key={field.id} className="projDrawerField">
                      <span>{field.name}</span>
                      <FieldEditor
                        field={field}
                        current={displayValue(valueFor(item, field.id))}
                        onApply={(payload) => onSetField(item, field, payload)}
                      />
                    </label>
                  ))}
              </div>

              {(item.content?.labels?.nodes.length ?? 0) > 0 ? (
                <div className="projCardLabels projDrawerLabels">
                  {item.content!.labels!.nodes.map((label) => (
                    <i key={label.name} className="projLabelChip" style={{ borderColor: `#${label.color}`, color: `#${label.color}` }}>
                      {label.name}
                    </i>
                  ))}
                </div>
              ) : null}

              <div className="projDrawerSection">
                <div className="projDrawerSectionHead">
                  <TextReveal as="span" manager="decipher">Description</TextReveal>
                  {isDraft && !editingBody ? (
                    <IconButton
                      icon={<Pencil size={11} />}
                      label="Edit draft"
                      onClick={() => {
                        setDraftTitle(detail?.content?.title ?? item.content?.title ?? '');
                        setDraftBody(detail?.content?.body ?? '');
                        setEditingBody(true);
                      }}
                    />
                  ) : null}
                </div>
                {editingBody ? (
                  <div className="projDraftEditor">
                    <input
                      className="treeInlineInput"
                      value={draftTitle}
                      placeholder="Title"
                      onChange={(event) => setDraftTitle(event.target.value)}
                    />
                    <textarea
                      className="gitCommitInput projDraftBody"
                      rows={8}
                      value={draftBody}
                      placeholder="Body (markdown)"
                      onChange={(event) => setDraftBody(event.target.value)}
                    />
                    <div className="confirmActions">
                      <Cmd icon={<X size={12} />} label="Cancel" onClick={() => setEditingBody(false)} />
                      <Cmd
                        icon={<Send size={12} />}
                        label="Save draft"
                        disabled={draftTitle.trim() === ''}
                        onClick={() => {
                          setEditingBody(false);
                          onEditDraft(item, draftTitle.trim(), draftBody);
                        }}
                      />
                    </div>
                  </div>
                ) : loading ? (
                  <div className="viewerStatus">loading…</div>
                ) : loadError ? (
                  <div className="viewerStatus">
                    Could not load this item.{' '}
                    <button type="button" onClick={() => setReloadNonce((n) => n + 1)}>
                      Retry
                    </button>
                  </div>
                ) : detail?.content?.body ? (
                  <Suspense fallback={<div className="viewerStatus">loading renderer…</div>}>
                    <ItemMarkdown body={detail.content.body} />
                  </Suspense>
                ) : (
                  <div className="gitEmptyNote">No description.</div>
                )}
              </div>

              {repoItem ? (
                <div className="projDrawerSection">
                  <div className="projDrawerSectionHead">
                    <TextReveal as="span" manager="decipher">Comments</TextReveal>
                    <Pill tone="muted">{detail?.content?.comments?.nodes.length ?? 0}</Pill>
                  </div>
                  {(detail?.content?.comments?.nodes ?? []).map((entry, index) => (
                    <Animator key={index}>
                      <Animated className="projComment" animated={['fade', ['y', 6, 0]]}>
                        <header>
                          <strong>@{entry.author?.login ?? 'ghost'}</strong>
                          <small>{new Date(entry.createdAt).toLocaleString()}</small>
                        </header>
                        <Suspense fallback={<div className="viewerStatus">…</div>}>
                          <ItemMarkdown body={entry.body} />
                        </Suspense>
                      </Animated>
                    </Animator>
                  ))}
                  <div className="projCommentComposer">
                    <textarea
                      className="gitCommitInput"
                      rows={2}
                      placeholder="Comment (markdown, Ctrl+Enter to send)"
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && comment.trim() !== '') {
                          event.preventDefault();
                          setSending(true);
                          void onComment(item, comment.trim()).then((ok) => {
                            setSending(false);
                            if (ok) {
                              setComment('');
                              bleeps.deploy?.play();
                            }
                          });
                        }
                      }}
                    />
                    <Cmd
                      icon={<MessageSquarePlus size={12} />}
                      label={sending ? 'Sending…' : 'Comment'}
                      disabled={sending || comment.trim() === ''}
                      onClick={() => {
                        setSending(true);
                        void onComment(item, comment.trim()).then((ok) => {
                          setSending(false);
                          if (ok) {
                            setComment('');
                            bleeps.deploy?.play();
                          }
                        });
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </Animated>
    </Animator>
  );
}
