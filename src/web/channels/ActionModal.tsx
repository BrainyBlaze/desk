import { type ReactNode, useCallback } from 'react';
import { useBleeps } from '@arwes/react';
import { Modal } from '../arwes/primitives.js';
import type { DeskBleepName } from '../arwes/bleeps.js';

export function ActionModal({
  open,
  title,
  icon,
  onClose,
  children,
  wide,
  help
}: {
  open: boolean;
  title: string;
  icon: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  help?: string;
}): JSX.Element | null {
  if (!open) {
    return null;
  }
  return (
    <Modal title={title} icon={icon} onClose={onClose} wide={wide} help={help}>
      {children}
    </Modal>
  );
}

export function useActionSounds(): {
  hover: () => void;
  click: (run?: () => void) => void;
} {
  const bleeps = useBleeps<DeskBleepName>();
  const hover = useCallback(() => {
    bleeps.hover?.play();
  }, [bleeps.hover]);
  const click = useCallback(
    (run?: () => void) => {
      bleeps.click?.play();
      run?.();
    },
    [bleeps.click]
  );
  return { hover, click };
}
