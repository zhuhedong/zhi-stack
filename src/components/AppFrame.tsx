import type { ReactNode } from 'react';
import { Wallpaper } from './Wallpaper';

export function AppFrame({ children, showDetail = false }: { children: ReactNode; showDetail?: boolean }) {
  return (
    <div className="app-frame">
      <Wallpaper />
      <div className={'app-shell' + (showDetail ? ' show-detail' : '')}>{children}</div>
    </div>
  );
}
