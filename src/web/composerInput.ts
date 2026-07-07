type ClipboardFileItem = Pick<DataTransferItem, 'kind' | 'getAsFile'>;
type ComposerDragTypes = { includes(value: string): boolean } | readonly string[];

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

export function composerPlainEnterShouldSend(key: string, shiftKey: boolean): boolean {
  return key === 'Enter' && !shiftKey;
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
