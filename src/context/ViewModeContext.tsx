import React, { createContext, useContext, useState } from 'react';
import { loadViewMode, saveViewMode, ViewMode } from '../services/sessionStorage.ts';

interface ViewModeContextValue {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  toggleViewMode: () => void;
  isSimple: boolean;
}

const ViewModeContext = createContext<ViewModeContextValue>({
  viewMode: 'simple',
  setViewMode: () => {},
  toggleViewMode: () => {},
  isSimple: true,
});

export const ViewModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [viewMode, setViewModeState] = useState<ViewMode>(() => loadViewMode());

  const setViewMode = (mode: ViewMode) => {
    setViewModeState(mode);
    saveViewMode(mode);
  };

  const toggleViewMode = () => {
    setViewMode(viewMode === 'simple' ? 'advanced' : 'simple');
  };

  return (
    <ViewModeContext.Provider
      value={{
        viewMode,
        setViewMode,
        toggleViewMode,
        isSimple: viewMode === 'simple',
      }}
    >
      {children}
    </ViewModeContext.Provider>
  );
};

export function useViewMode() {
  return useContext(ViewModeContext);
}
