type ClipboardFileItem = Pick<DataTransferItem, 'kind' | 'getAsFile'>;
type ComposerDragTypes = { includes(value: string): boolean } | readonly string[];
export interface ComposerResizeState {
  startY: number;
  startHeight: number;
}
type ComposerResizeRef = { current: ComposerResizeState | null };
type ComposerPointerTarget = {
  setPointerCapture?: (pointerId: number) => void;
  hasPointerCapture?: (pointerId: number) => boolean;
  releasePointerCapture?: (pointerId: number) => void;
};
type ComposerPointerEventLike = {
  preventDefault(): void;
  currentTarget: ComposerPointerTarget;
  pointerId: number;
  clientY: number;
};
type ComposerFileDropEventLike = {
  preventDefault(): void;
  dataTransfer: {
    types: ComposerDragTypes;
    files: FileList | File[];
  };
};
type ComposerPasteEventLike = {
  preventDefault(): void;
  clipboardData: {
    items: ArrayLike<ClipboardFileItem> | Iterable<ClipboardFileItem>;
  };
};
type ComposerUpload = (channel: string, name: string, content: string) => Promise<{ markdown: string }>;

export function appendComposerFileLinks(current: string, links: string[]): string {
  if (links.length === 0) {
    return current;
  }
  const separator = current.length > 0 && !current.endsWith('\n') && !current.endsWith(' ') ? ' ' : '';
  return `${current}${separator}${links.join(' ')}`;
}

export function filesFromClipboardItems(items: ArrayLike<ClipboardFileItem> | Iterable<ClipboardFileItem>): File[] {
  return Array.from(items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function composerPlainEnterShouldSend(key: string, shiftKey: boolean, isComposing = false): boolean {
  return key === 'Enter' && !shiftKey && !isComposing;
}

export function restoreComposerTextAfterFailedSend(submitted: string, current: string): string {
  return current.length === 0 ? submitted : `${submitted}\n${current}`;
}

export function composerResizeKeyDelta(key: string, step: number): number | null {
  if (key === 'ArrowUp') {
    return step;
  }
  if (key === 'ArrowDown') {
    return -step;
  }
  return null;
}

export function composerDragIncludesFiles(types: ComposerDragTypes): boolean {
  return types.includes('Files');
}

export function startComposerResize(
  event: ComposerPointerEventLike,
  resizeRef: ComposerResizeRef,
  currentHeight: number,
  afterStart?: () => void
): void {
  event.preventDefault();
  resizeRef.current = { startY: event.clientY, startHeight: currentHeight };
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId);
  } catch {
    // Synthetic pointer events do not always create an active capture target.
  }
  afterStart?.();
}

export function dragComposerResize(
  event: ComposerPointerEventLike,
  resizeRef: ComposerResizeRef,
  applyHeight: (resize: ComposerResizeState, clientY: number) => void
): boolean {
  const resize = resizeRef.current;
  if (!resize) {
    return false;
  }
  event.preventDefault();
  applyHeight(resize, event.clientY);
  return true;
}

export function finishComposerResize(event: ComposerPointerEventLike, resizeRef: ComposerResizeRef): void {
  resizeRef.current = null;
  try {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  } catch {
    // See setPointerCapture guard above.
  }
}

export async function runComposerFileUpload(
  files: FileList | File[],
  options: {
    channel: string;
    upload: ComposerUpload;
    setUploading: (uploading: boolean) => void;
    appendLinks: (links: string[]) => void;
    onSuccess?: () => void;
    onError: (message: string) => void;
    focus: () => void;
  }
): Promise<boolean> {
  const list = Array.from(files);
  if (list.length === 0) {
    return false;
  }
  options.setUploading(true);
  try {
    const links: string[] = [];
    for (const file of list) {
      links.push((await options.upload(options.channel, file.name, await fileToBase64(file))).markdown);
    }
    options.appendLinks(links);
    options.onSuccess?.();
    return true;
  } catch (error) {
    options.onError(error instanceof Error ? error.message : 'upload failed');
    return false;
  } finally {
    options.setUploading(false);
    options.focus();
  }
}

export function handleComposerFileDragOver(event: ComposerFileDropEventLike, setDragOver: (dragOver: boolean) => void): boolean {
  if (!composerDragIncludesFiles(event.dataTransfer.types)) {
    return false;
  }
  event.preventDefault();
  setDragOver(true);
  return true;
}

export function handleComposerFileDrop(
  event: ComposerFileDropEventLike,
  setDragOver: (dragOver: boolean) => void,
  uploadFiles: (files: FileList | File[]) => void | Promise<void>
): void {
  event.preventDefault();
  setDragOver(false);
  void uploadFiles(event.dataTransfer.files);
}

export function handleComposerFilePaste(
  event: ComposerPasteEventLike,
  uploadFiles: (files: File[]) => void | Promise<void>
): boolean {
  const files = filesFromClipboardItems(event.clipboardData.items);
  if (files.length === 0) {
    return false;
  }
  event.preventDefault();
  void uploadFiles(files);
  return true;
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
