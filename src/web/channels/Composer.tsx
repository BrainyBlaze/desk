import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useBleeps } from '@arwes/react';
import { AtSign, Paperclip, SendHorizontal } from 'lucide-react';
import { IconButton } from '../arwes/primitives.js';
import type { DeskBleepName } from '../arwes/bleeps.js';
import { channelsUpload } from './channelsClient.js';
import { applyMention, composerInputHeightFromTopResize, mentionQueryAt, type MentionQuery } from './channelsModel.js';
import {
  appendComposerFileLinks,
  composerDragIncludesFiles,
  composerPlainEnterShouldSend,
  composerResizeKeyDelta,
  filesFromClipboardItems
} from '../composerInput.js';

const COMPOSER_INPUT_MIN_HEIGHT = 38;
const COMPOSER_INPUT_MAX_HEIGHT = 260;
const COMPOSER_KEY_RESIZE_STEP = 12;

/**
 * Slack-style composer: Enter sends (Shift+Enter for a newline), @mention
 * autocomplete over the channel roster, attach button + drag-drop + paste
 * uploads that insert protocol `_files/` markdown links.
 */
export function Composer({
  channel,
  handles,
  placeholder,
  disabled,
  seedText,
  draftKey,
  onSend,
  onError
}: {
  channel: string;
  handles: string[];
  placeholder: string;
  disabled?: boolean;
  /** externally injected draft text (e.g. "mention author"); consumed once */
  seedText?: { text: string; nonce: number } | null;
  /** localStorage key — drafts survive channel switches and reloads */
  draftKey?: string;
  onSend: (body: string) => Promise<boolean>;
  onError: (message: string) => void;
}): JSX.Element {
  const bleeps = useBleeps<DeskBleepName>();
  const [text, setTextRaw] = useState(() => (draftKey ? localStorage.getItem(draftKey) ?? '' : ''));
  const draftKeyRef = useRef(draftKey);
  const setText = useCallback(
    (value: string | ((current: string) => string)) => {
      setTextRaw((current) => {
        const next = typeof value === 'function' ? value(current) : value;
        const key = draftKeyRef.current;
        if (key) {
          if (next.length > 0) {
            localStorage.setItem(key, next);
          } else {
            localStorage.removeItem(key);
          }
        }
        return next;
      });
    },
    []
  );
  // Channel switch re-keys the draft: stash nothing, just load the new one.
  useEffect(() => {
    if (draftKeyRef.current !== draftKey) {
      draftKeyRef.current = draftKey;
      setTextRaw(draftKey ? localStorage.getItem(draftKey) ?? '' : '');
    }
  }, [draftKey]);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const seedNonceRef = useRef(0);

  useEffect(() => {
    if (seedText && seedText.nonce !== seedNonceRef.current) {
      seedNonceRef.current = seedText.nonce;
      setText((current) => (current.length > 0 && !current.endsWith(' ') ? `${current} ${seedText.text}` : current + seedText.text));
      areaRef.current?.focus();
    }
  }, [seedText]);

  const mentionOptions = mention
    ? [...handles, 'channel', 'human']
        .filter((handle, index, all) => all.indexOf(handle) === index)
        .filter((handle) => handle.toLowerCase().startsWith(mention.partial.toLowerCase()))
    : [];

  const refreshMention = useCallback((value: string, caret: number) => {
    setMention(mentionQueryAt(value, caret));
    setMentionIndex(0);
  }, []);

  const inputHeightBounds = (): { minHeight: number; maxHeight: number } => ({
    minHeight: COMPOSER_INPUT_MIN_HEIGHT,
    maxHeight: Math.min(COMPOSER_INPUT_MAX_HEIGHT, Math.max(COMPOSER_INPUT_MIN_HEIGHT, window.innerHeight * 0.45))
  });

  const currentInputHeight = (): number => areaRef.current?.getBoundingClientRect().height ?? manualHeight ?? COMPOSER_INPUT_MIN_HEIGHT;

  const setClampedManualHeight = (height: number): void => {
    setManualHeight(composerInputHeightFromTopResize(height, 0, 0, inputHeightBounds()));
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    resizeRef.current = { startY: event.clientY, startHeight: currentInputHeight() };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events used by automated checks do not always create
      // an active pointer capture target; dragging still works through move events.
    }
    bleeps.hover?.play();
  };

  const dragResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const resize = resizeRef.current;
    if (!resize) {
      return;
    }
    event.preventDefault();
    setManualHeight(composerInputHeightFromTopResize(resize.startHeight, resize.startY, event.clientY, inputHeightBounds()));
  };

  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    resizeRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // See setPointerCapture guard above.
    }
  };

  const resizeFromKeyboard = (delta: number): void => {
    setClampedManualHeight(currentInputHeight() + delta);
  };

  const pickMention = (handle: string): void => {
    const area = areaRef.current;
    if (!mention || !area) {
      return;
    }
    const caret = area.selectionStart ?? text.length;
    const applied = applyMention(text, caret, mention, handle);
    setText(applied.text);
    setMention(null);
    bleeps.click?.play();
    window.requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(applied.caret, applied.caret);
    });
  };

  const send = async (): Promise<void> => {
    const body = text.trim();
    if (body.length === 0 || sending || disabled) {
      return;
    }
    setSending(true);
    try {
      const ok = await onSend(body);
      if (ok) {
        setText('');
        setMention(null);
        bleeps.deploy?.play();
      }
    } finally {
      setSending(false);
      areaRef.current?.focus();
    }
  };

  const uploadFiles = async (files: FileList | File[]): Promise<void> => {
    const list = [...files];
    if (list.length === 0) {
      return;
    }
    setUploading(true);
    try {
      const links: string[] = [];
      for (const file of list) {
        const buffer = await file.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const CHUNK = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
        }
        const result = await channelsUpload(channel, file.name, btoa(binary));
        links.push(result.markdown);
      }
      setText((current) => appendComposerFileLinks(current, links));
      bleeps.open?.play();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'upload failed');
    } finally {
      setUploading(false);
      areaRef.current?.focus();
    }
  };

  return (
    <div className="chanComposerWrap">
    {/* anchored to the wrap, NOT inside the composer: the octagon clip-path
        would clip anything rendered above the input invisible */}
    {mention && mentionOptions.length > 0 ? (
      <div className="chanMentionPop">
        {mentionOptions.slice(0, 8).map((handle, index) => (
          <button
            key={handle}
            type="button"
            className={`chanMentionOption ${index === mentionIndex ? 'active' : ''}`}
            onMouseEnter={() => setMentionIndex(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              pickMention(handle);
            }}
          >
            <AtSign size={10} />
            <span>{handle}</span>
            {handle === 'channel' ? <small>everyone</small> : handle === 'human' ? <small>operator</small> : null}
          </button>
        ))}
      </div>
    ) : null}
    <div
      className={`chanComposer ${dragOver ? 'dragOver' : ''}`}
      onDragOver={(event) => {
        if (composerDragIncludesFiles(event.dataTransfer.types)) {
          event.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        void uploadFiles(event.dataTransfer.files);
      }}
    >
      <button
        type="button"
        className="chanComposerResizeHandle"
        aria-label="Resize chat input"
        title="Drag to resize chat input"
        onPointerDown={startResize}
        onPointerMove={dragResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onKeyDown={(event) => {
          const delta = composerResizeKeyDelta(event.key, COMPOSER_KEY_RESIZE_STEP);
          if (delta !== null) {
            event.preventDefault();
            resizeFromKeyboard(delta);
          }
        }}
      />
      <textarea
        ref={areaRef}
        className="chanComposerInput"
        rows={2}
        style={manualHeight ? { height: `${manualHeight}px` } : undefined}
        placeholder={placeholder}
        value={text}
        disabled={disabled || sending}
        onChange={(event) => {
          setText(event.target.value);
          refreshMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={(event) => {
          const area = event.target as HTMLTextAreaElement;
          refreshMention(area.value, area.selectionStart ?? area.value.length);
        }}
        onPaste={(event) => {
          const files = filesFromClipboardItems(event.clipboardData.items);
          if (files.length > 0) {
            event.preventDefault();
            void uploadFiles(files);
          }
        }}
        onKeyDown={(event) => {
          if (mention && mentionOptions.length > 0) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setMentionIndex((index) => (index + 1) % Math.min(8, mentionOptions.length));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setMentionIndex((index) => (index - 1 + Math.min(8, mentionOptions.length)) % Math.min(8, mentionOptions.length));
              return;
            }
            if (event.key === 'Tab' || event.key === 'Enter') {
              event.preventDefault();
              pickMention(mentionOptions[mentionIndex] ?? mentionOptions[0]);
              return;
            }
            if (event.key === 'Escape') {
              setMention(null);
              return;
            }
          }
          if (composerPlainEnterShouldSend(event.key, event.shiftKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="chanComposerActions">
        <label className="chanAttach" title="Attach files">
          <input
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) {
                void uploadFiles(event.target.files);
                event.target.value = '';
              }
            }}
          />
          <Paperclip size={13} />
        </label>
        <IconButton
          icon={<SendHorizontal size={13} />}
          label="Send (Enter)"
          disabled={disabled || sending || uploading || text.trim().length === 0}
          onClick={() => void send()}
        />
      </div>
      {uploading ? <div className="chanComposerStatus">uploading…</div> : null}
    </div>
    {/* outside the octagon clip-path — a child would be clipped invisible */}
    {text.length > 0 ? (
      <div className="chanComposerHint" aria-hidden="true">
        <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline · <kbd>@</kbd> mention · drop or paste files
      </div>
    ) : null}
    </div>
  );
}
