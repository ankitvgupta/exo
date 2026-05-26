import path from "path";

export function buildFilesystemSandbox(
  homeDir = process.env.HOME,
  platform = process.platform,
): {
  denyRead: string[];
  allowRead?: string[];
} {
  // Without HOME we can't construct the user-relative deny paths (~/.ssh,
  // ~/.aws, browser profiles, etc.), so the list is empty and the agent is
  // effectively unsandboxed for reads. This only happens when HOME is unset
  // (e.g. some stripped containers) — normal desktop/CI runs always set it.
  // Returned explicitly so the trade-off is visible to operators.
  if (!homeDir) return { denyRead: [] };

  if (platform === "darwin") {
    return {
      denyRead: [
        path.join(homeDir, "Music"),
        path.join(homeDir, "Pictures"),
        path.join(homeDir, "Movies"),
        path.join(homeDir, "Library"),
        "/Volumes",
      ],
      allowRead: [
        // Re-allow the app's own data directory within ~/Library
        path.join(homeDir, "Library", "Application Support", "exo"),
      ],
    };
  }

  // Credentials, keys, and browser profiles the agent should never read.
  // Mirrors the intent of the macOS ~/Library deny (which covered browser
  // data and keychains). Used for Linux and as a default-deny fallback for
  // any other platform, so an unrecognized platform is never left unsandboxed.
  const sensitive = [
    path.join(homeDir, ".ssh"),
    path.join(homeDir, ".gnupg"),
    path.join(homeDir, ".aws"),
    path.join(homeDir, ".config", "gh"),
    path.join(homeDir, ".config", "gcloud"),
    path.join(homeDir, ".local", "share", "keyrings"),
    // Browser profiles: cookies, saved passwords, history.
    path.join(homeDir, ".mozilla"),
    path.join(homeDir, ".config", "google-chrome"),
    path.join(homeDir, ".config", "chromium"),
  ];

  return { denyRead: sensitive };
}

export function buildPlatformSandboxGuidance(platform = process.platform): string {
  if (platform === "darwin") {
    return "IMPORTANT: On macOS, accessing ~/Desktop, ~/Downloads, or ~/Documents triggers a system permission prompt attributed to this app. Do not proactively read, search, or scan these directories as part of broader operations (e.g., searching the home directory). Only access them when the user's request specifically requires it.";
  }

  if (platform === "linux") {
    return "IMPORTANT: On Linux, do not proactively read, search, or scan sensitive home-directory locations such as ~/.ssh, ~/.gnupg, cloud credential folders, desktop keyrings, or browser profile data. Only access files in the home directory when the user's request specifically requires them.";
  }

  return "";
}
