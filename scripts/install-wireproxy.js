const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const version = "v1.1.3";
const hashes = {
  linux: "e88c1d090740373fc606c1bafd81d9a5eadc642cce5667616e20e9d7a444f51c",
  win32: "bce041ea9fe0f8a3351301dcbe29cdf6a523bb25cf9c62f17ebb5699a8051d0f",
};

async function install() {
  if (process.arch !== "x64" || !hashes[process.platform]) return;
  const windows = process.platform === "win32";
  const name = windows ? "wireproxy.exe" : "wireproxy";
  const bin = path.join(__dirname, "..", "bin");
  const destination = path.join(bin, name);
  try {
    await fs.access(destination);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const archive = "wireproxy_" + (windows ? "windows" : "linux") + "_amd64.tar.gz";
  const url = "https://github.com/windtf/wireproxy/releases/download/" + version + "/" + archive;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error("download returned HTTP " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== hashes[process.platform]) {
    throw new Error("SHA-256 mismatch for " + archive);
  }

  await fs.mkdir(bin, { recursive: true });
  const staging = await fs.mkdtemp(path.join(bin, ".install-"));
  try {
    await fs.writeFile(path.join(staging, archive), bytes);
    const tar = windows ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
    execFileSync(tar, ["-xzf", archive], { cwd: staging, windowsHide: true, stdio: "inherit" });
    const executable = path.join(staging, name);
    await fs.chmod(executable, 0o755);
    await fs.rename(executable, destination);
    console.log("[wireproxy] Installed " + version + " (" + archive + ", SHA-256 verified)");
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

install().catch(error => console.warn("[wireproxy] Optional installation failed: " + error.message));
