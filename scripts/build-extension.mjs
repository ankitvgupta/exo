#!/usr/bin/env node
/**
 * Build script for packaging mail client extensions into .zip files.
 *
 * Usage:
 *   node scripts/build-extension.mjs <extension-dir> [--out <output-dir>]
 *
 * Example:
 *   node scripts/build-extension.mjs src/extensions-private/mail-ext-example --out dist/extensions
 *
 * The extension directory must contain:
 *   - package.json with a "mailExtension" field
 *   - src/index.ts (main process entry point)
 *   - src/renderer/index.ts (optional, renderer entry point)
 *
 * Output: A .zip file containing:
 *   - package.json (manifest)
 *   - dist/main.js (bundled main process code, CJS)
 *   - dist/renderer.js (bundled renderer code, ESM, if renderer entry exists)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, join, basename } from "path";
import { execSync } from "child_process";

// We use archiver for zipping — it's commonly available or we fall back to
// the built-in `zip` command
const args = process.argv.slice(2);

// Parse args
let extensionDir = null;
let outputDir = "dist/extensions";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) {
    outputDir = args[i + 1];
    i++;
  } else if (!args[i].startsWith("--")) {
    extensionDir = args[i];
  }
}

if (!extensionDir) {
  console.error("Usage: build-extension.mjs <extension-dir> [--out <output-dir>]");
  process.exit(1);
}

const extPath = resolve(extensionDir);
const pkgJsonPath = join(extPath, "package.json");

if (!existsSync(pkgJsonPath)) {
  console.error(`No package.json found at ${extPath}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
if (!pkg.mailExtension && !pkg.agentProvider) {
  console.error(`package.json must have a "mailExtension" and/or "agentProvider" field`);
  process.exit(1);
}

const manifest = pkg.mailExtension;
const agentManifest = pkg.agentProvider;
const extensionId = manifest?.id ?? agentManifest?.id ?? pkg.name;
const displayName = manifest?.displayName ?? agentManifest?.displayName ?? pkg.name;
console.log(`Building extension: ${displayName} (${extensionId})`);

// Create temp build dir
const buildDir = join(extPath, ".build");
mkdirSync(join(buildDir, "dist"), { recursive: true });

// Copy package.json (strip builtIn flag for installable extensions)
const installablePkg = { ...pkg };
if (manifest) {
  installablePkg.mailExtension = { ...manifest, builtIn: false };
}
writeFileSync(join(buildDir, "package.json"), JSON.stringify(installablePkg, null, 2));

// Determine entry points
const mainEntry = join(extPath, "src/index.ts");
const rendererEntry = join(extPath, "src/renderer/index.ts");
const rendererEntryTsx = join(extPath, "src/renderer/index.tsx");

const hasMainEntry = existsSync(mainEntry);
if (!hasMainEntry && !pkg.agentProvider) {
  console.error(`No main entry point found at ${mainEntry}`);
  process.exit(1);
}

if (hasMainEntry) {
  // Build main process bundle (CJS for require())
  console.log("Building main process bundle...");
  try {
    execSync(
      `npx esbuild "${mainEntry}" --bundle --format=cjs --platform=node --target=node20 ` +
      `--outfile="${join(buildDir, "dist/main.js")}" ` +
      `--external:electron --external:better-sqlite3 ` +
      // Extension types are provided by the host app at runtime
      `--alias:@mail-client/extension-types=@mail-client/extension-types ` +
      `--define:process.env.NODE_ENV='"production"'`,
      { stdio: "inherit", cwd: extPath }
    );
  } catch (e) {
    console.error("Failed to build main process bundle");
    process.exit(1);
  }
}

// Build renderer bundle (ESM) if renderer entry exists
const actualRendererEntry = existsSync(rendererEntry) ? rendererEntry
  : existsSync(rendererEntryTsx) ? rendererEntryTsx
  : null;

if (actualRendererEntry) {
  console.log("Building renderer bundle...");
  try {
    execSync(
      `npx esbuild "${actualRendererEntry}" --bundle --format=esm --platform=browser --target=es2022 ` +
      `--outfile="${join(buildDir, "dist/renderer.js")}" ` +
      `--external:react --external:react-dom ` +
      `--jsx=automatic ` +
      `--define:process.env.NODE_ENV='"production"'`,
      { stdio: "inherit", cwd: extPath }
    );
  } catch (e) {
    console.error("Failed to build renderer bundle");
    process.exit(1);
  }
}

// Build agent provider bundle (CJS, fully self-contained) if agentProvider field exists
if (pkg.agentProvider) {
  // Provider entry point — look in src/ first, then root
  const providerCandidates = [
    join(extPath, "src", "provider.ts"),
    join(extPath, "src", "index.ts"),
    join(extPath, "provider.ts"),
    join(extPath, "index.ts"),
  ];
  const actualProviderEntry = providerCandidates.find(existsSync) ?? null;

  if (actualProviderEntry) {
    console.log("Building agent provider bundle...");
    try {
      execSync(
        `npx esbuild "${actualProviderEntry}" --bundle --format=cjs --platform=node --target=node20 ` +
        `--outfile="${join(buildDir, "dist/provider.js")}" ` +
        `--external:electron ` +
        `--define:process.env.NODE_ENV='"production"'`,
        { stdio: "inherit", cwd: extPath }
      );
    } catch (e) {
      console.error("Failed to build agent provider bundle");
      process.exit(1);
    }
  }

  // Main-setup entry point for auth/config in main process
  const mainSetupEntry = existsSync(join(extPath, "src", "main-setup.ts"))
    ? join(extPath, "src", "main-setup.ts")
    : join(extPath, "main-setup.ts");
  if (existsSync(mainSetupEntry)) {
    console.log("Building main-setup bundle...");
    try {
      execSync(
        `npx esbuild "${mainSetupEntry}" --bundle --format=cjs --platform=node --target=node20 ` +
        `--outfile="${join(buildDir, "dist/main-setup.js")}" ` +
        `--external:electron ` +
        `--define:process.env.NODE_ENV='"production"'`,
        { stdio: "inherit", cwd: extPath }
      );
    } catch (e) {
      console.error("Failed to build main-setup bundle");
      process.exit(1);
    }
  }
}

// Create .zip file
mkdirSync(resolve(outputDir), { recursive: true });
const outputPath = resolve(join(outputDir, `${extensionId}.zip`));

console.log(`Packaging to ${outputPath}...`);
try {
  // Use system zip (available on macOS and Linux)
  execSync(`cd "${buildDir}" && zip -r "${outputPath}" package.json dist/`, { stdio: "inherit" });
} catch (e) {
  console.error("Failed to create extension package. Ensure 'zip' is installed.");
  process.exit(1);
}

// Cleanup
execSync(`rm -rf "${buildDir}"`);

console.log(`\nSuccessfully built: ${outputPath}`);
console.log(`Install with: Settings → Extensions → Install Extension`);
