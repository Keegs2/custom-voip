/**
 * Local types for the admin tab-shell chrome (AdminPage / PlatformManagementPage).
 * Only the shell's own structural shape lives here — no global types are duplicated.
 */

export interface ShellTab {
  label: string;
  to: string;
}
