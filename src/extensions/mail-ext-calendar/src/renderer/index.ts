/**
 * Calendar Extension - Renderer entry point
 * Exports panel registrations for the extension UI system.
 */
import { CalendarPanel } from "./CalendarPanel";

export const panelRegistrations = [
  {
    extensionId: "calendar",
    panelId: "day-view",
    component: CalendarPanel,
  },
];
