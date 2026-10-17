import React from 'react';

/** Version counter bumped whenever a new snapshot has been pushed into Studio's data engine. */
export const DataVersionContext = React.createContext(0);
export const useDataVersion = () => React.useContext(DataVersionContext);

export interface UiBridge {
  onSelectPayer?: (payerId: string | null) => void;
  selectedPayer?: string | null;
}
export const UiBridgeContext = React.createContext<UiBridge>({});
