import React from 'react';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { AgStudioAiModule } from 'ag-studio';
import type { Snapshot } from '@shared/types';
import { buildStudioData } from './data';
import { INITIAL_STATE } from './state';
import { widgets } from './registry';
import { tidewaterTheme } from './theme';
import { DataVersionContext, UiBridgeContext, type UiBridge } from './context';

export interface StudioViewProps {
  snapshot: Snapshot;
  mode: 'view' | 'edit';
  /** which Studio panels to show in edit mode */
  panelSet?: 'collector' | 'full';
  ai?: any;
  aiToolDisplay?: Record<string, any>;
  bridge: UiBridge;
}

export function StudioView({ snapshot, mode, panelSet = 'collector', ai, aiToolDisplay, bridge }: StudioViewProps) {
  const [version, setVersion] = React.useState(0);
  // Studio reads `data` reactively for synchronous sources; keep identity stable between real changes.
  const data = React.useMemo(() => buildStudioData(snapshot), [snapshot]);
  React.useEffect(() => setVersion((v) => v + 1), [data]);
  const initial = React.useRef(INITIAL_STATE);
  return (
    <DataVersionContext.Provider value={version}>
      <UiBridgeContext.Provider value={bridge}>
        <AgStudioProvider>
          <AgStudio
            style={{ height: '100%', width: '100%' }}
            mode={mode}
            modules={[AgStudioAiModule]}
            theme={tidewaterTheme}
            data={data as any}
            widgets={widgets as any}
            initialState={initial.current}
            panels={(panelSet === 'full' ? { view: { right: [] }, edit: { left: ['data'], right: ['edit', 'ai'] } } : { view: { right: [] }, edit: { left: [], right: ['ai'] } }) as any}
            ai={ai}
            aiToolDisplay={aiToolDisplay}
          />
        </AgStudioProvider>
      </UiBridgeContext.Provider>
    </DataVersionContext.Provider>
  );
}
