export async function zipDirectory(sourceDir: string, destinationPath: string): Promise<void> {
  const { createWriteStream } = await import("fs");
  const archiver = (await import("archiver")).default;

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destinationPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize().catch(reject);
  });
}

export async function extractZipArchive(zipPath: string, destinationDir: string): Promise<void> {
  const extract = (await import("extract-zip")).default;
  await extract(zipPath, { dir: destinationDir });
}
