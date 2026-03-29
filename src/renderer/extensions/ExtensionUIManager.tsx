import React, { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import type { ExtensionPanelInfo } from "../../shared/extension-types";

/**
 * Extension UI state
 */
interface ExtensionUIState {
  registeredPanels: ExtensionPanelInfo[];
  isInitialized: boolean;
}

const ExtensionUIContext = createContext<ExtensionUIState>({
  registeredPanels: [],
  isInitialized: false,
});

/**
 * Hook to access extension UI state
 */
export function useExtensionUI(): ExtensionUIState {
  return useContext(ExtensionUIContext);
}

interface ExtensionUIProviderProps {
  children: ReactNode;
}

/**
 * Provider component for extension UI state
 * Initializes the extension UI system and loads panel registrations
 */
export function ExtensionUIProvider({ children }: ExtensionUIProviderProps): React.ReactElement {
  const [registeredPanels, setRegisteredPanels] = useState<ExtensionPanelInfo[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    const initialize = async () => {
      try {
        // Load panel registrations from main process
        const result = await window.api.extensions.getPanels();
        if (result.success && result.data) {
          setRegisteredPanels(result.data as ExtensionPanelInfo[]);
        }
        setIsInitialized(true);
      } catch (error) {
        console.error("[ExtensionUI] Failed to initialize:", error);
        setIsInitialized(true); // Still mark as initialized to prevent infinite loading
      }
    };

    initialize();
  }, []);

  return (
    <ExtensionUIContext.Provider value={{ registeredPanels, isInitialized }}>
      {children}
    </ExtensionUIContext.Provider>
  );
}
