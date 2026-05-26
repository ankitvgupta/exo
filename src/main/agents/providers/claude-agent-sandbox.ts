import path from "path";

export function buildFilesystemSandbox(
  homeDir = process.env.HOME,
  platform = process.platform,
): {
  denyRead: string[];
  allowRead?: string[];
} {
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

  if (platform === "linux") {
    return {
      denyRead: [
        path.join(homeDir, ".ssh"),
        path.join(homeDir, ".gnupg"),
        path.join(homeDir, ".aws"),
        path.join(homeDir, ".config", "gh"),
        path.join(homeDir, ".config", "gcloud"),
        path.join(homeDir, ".local", "share", "keyrings"),
      ],
    };
  }

  return { denyRead: [] };
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
