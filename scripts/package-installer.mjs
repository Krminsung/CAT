#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { get } from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "packaging", "runtime-manifest.json");
const installerTemplatePath = join(root, "scripts", "installer-header.sh");
const artifactsPath = join(root, "artifacts");
const maximumRuntimeBytes = 128 * 1024 * 1024;

const appInputs = [
  "dist",
  "bin",
  "package.json",
  "package-lock.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "packaging/runtime-manifest.json",
  "docs/release",
];

function packagingError(message) {
  return new Error(`[package] ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command,
      args,
      {
        cwd: options.cwd ?? root,
        env: options.env ?? process.env,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", (error) => {
      reject(packagingError(`${command} 명령을 시작할 수 없습니다: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        packagingError(
          `${command} 명령이 실패했습니다: ${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw packagingError(`${label} 값이 객체가 아닙니다.`);
  }
  return value;
}

function requireString(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw packagingError(`${label} 값이 올바르지 않습니다.`);
  }
  return value;
}

function parseRuntimeManifest(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw packagingError(`runtime manifest JSON을 읽을 수 없습니다: ${error.message}`);
  }

  const manifest = requireObject(parsed, "runtime manifest");
  if (manifest.schemaVersion !== 1) {
    throw packagingError("지원하지 않는 runtime manifest schema입니다.");
  }

  const runtime = requireObject(manifest.bundleRuntime, "bundleRuntime");
  const version = requireString(runtime.version, "bundleRuntime.version", /^v\d+\.\d+\.\d+$/u);
  const releaseIndexUrl = requireString(
    runtime.releaseIndexUrl,
    "bundleRuntime.releaseIndexUrl",
    /^https:\/\/nodejs\.org\/download\/release\/v\d+\.\d+\.\d+\/$/u,
  );
  if (releaseIndexUrl !== `https://nodejs.org/download/release/${version}/`) {
    throw packagingError("Node.js release URL과 고정 버전이 일치하지 않습니다.");
  }
  if (runtime.checksumsUrl !== `${releaseIndexUrl}SHASUMS256.txt`) {
    throw packagingError("Node.js checksum URL과 고정 release 경로가 일치하지 않습니다.");
  }
  if (!Array.isArray(runtime.targets) || runtime.targets.length !== 2) {
    throw packagingError("Linux x64/arm64 runtime 대상 두 개가 필요합니다.");
  }

  const expectedArchitectures = new Set(["x64", "arm64"]);
  const targets = runtime.targets.map((candidate, index) => {
    const target = requireObject(candidate, `bundleRuntime.targets[${index}]`);
    if (target.platform !== "linux") {
      throw packagingError("bundle runtime은 Linux만 지원합니다.");
    }
    const architecture = requireString(
      target.architecture,
      `bundleRuntime.targets[${index}].architecture`,
      /^(?:x64|arm64)$/u,
    );
    if (!expectedArchitectures.delete(architecture)) {
      throw packagingError(`중복되거나 알 수 없는 runtime architecture입니다: ${architecture}`);
    }
    const archive = requireString(
      target.archive,
      `bundleRuntime.targets[${index}].archive`,
      /^node-v\d+\.\d+\.\d+-linux-(?:x64|arm64)\.tar\.xz$/u,
    );
    const expectedArchive = `node-${version}-linux-${architecture}.tar.xz`;
    if (archive !== expectedArchive) {
      throw packagingError(`runtime archive 이름이 고정 버전/architecture와 다릅니다: ${archive}`);
    }
    const url = requireString(target.url, `bundleRuntime.targets[${index}].url`, /^https:\/\//u);
    if (url !== `${releaseIndexUrl}${archive}`) {
      throw packagingError(`runtime URL이 공식 고정 release 경로와 다릅니다: ${url}`);
    }
    const checksum = requireString(
      target.sha256,
      `bundleRuntime.targets[${index}].sha256`,
      /^[a-f0-9]{64}$/u,
    );
    return { architecture, archive, checksum, url };
  });

  if (expectedArchitectures.size !== 0) {
    throw packagingError("필수 runtime architecture가 빠졌습니다.");
  }
  return { manifest, targets, version };
}

async function downloadRuntime(target, destination) {
  const runtimeUrl = new URL(target.url);
  if (
    runtimeUrl.protocol !== "https:" ||
    runtimeUrl.hostname !== "nodejs.org" ||
    runtimeUrl.username !== "" ||
    runtimeUrl.password !== "" ||
    runtimeUrl.search !== "" ||
    runtimeUrl.hash !== ""
  ) {
    throw packagingError(`허용되지 않은 runtime URL입니다: ${target.url}`);
  }

  const response = await new Promise((resolve, reject) => {
    const request = get(
      runtimeUrl,
      {
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "cat-agent-cli-packager/0.1",
        },
      },
      resolve,
    );
    request.setTimeout(30_000, () => {
      request.destroy(packagingError(`runtime 다운로드가 응답 제한을 넘었습니다: ${target.archive}`));
    });
    request.once("error", reject);
  });

  if (response.statusCode !== 200) {
    response.resume();
    throw packagingError(
      `runtime 다운로드 HTTP 상태가 올바르지 않습니다: ${target.archive} (${response.statusCode ?? "unknown"})`,
    );
  }

  const contentLength = Number(response.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > maximumRuntimeBytes) {
    response.destroy();
    throw packagingError(`runtime Content-Length가 허용 범위를 벗어났습니다: ${target.archive}`);
  }

  const digest = createHash("sha256");
  let receivedBytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > maximumRuntimeBytes) {
        callback(packagingError(`runtime 다운로드 크기 제한을 넘었습니다: ${target.archive}`));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(response, meter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }

  if (receivedBytes !== contentLength) {
    await rm(destination, { force: true });
    throw packagingError(`runtime 다운로드 길이가 Content-Length와 다릅니다: ${target.archive}`);
  }
  const actualChecksum = digest.digest("hex");
  if (actualChecksum !== target.checksum) {
    await rm(destination, { force: true });
    throw packagingError(`runtime SHA-256이 manifest와 다릅니다: ${target.archive}`);
  }
}

function renderInstaller(template, replacements) {
  let rendered = template;
  for (const [name, value] of Object.entries(replacements)) {
    const marker = `@@${name}@@`;
    const occurrences = rendered.split(marker).length - 1;
    if (occurrences !== 1) {
      throw packagingError(`installer template marker가 정확히 한 개가 아닙니다: ${marker}`);
    }
    rendered = rendered.replace(marker, value);
  }
  if (/@@[A-Z][A-Z0-9_]*@@/u.test(rendered)) {
    throw packagingError("치환되지 않은 installer template marker가 남았습니다.");
  }
  return rendered;
}

async function copyApplication(stage) {
  await mkdir(stage, { recursive: true });
  for (const relativePath of appInputs) {
    const source = join(root, relativePath);
    const destination = join(stage, relativePath);
    if (!(await pathExists(source))) {
      throw packagingError(`필수 packaging 입력이 없습니다: ${relativePath}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
  }

  await chmod(join(stage, "bin", "cat"), 0o755);
  await runFile(
    "npm",
    ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
    {
      cwd: stage,
      env: {
        ...process.env,
        NODE_ENV: "production",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_ignore_scripts: "true",
        npm_config_update_notifier: "false",
      },
    },
  );
}

async function createPayloadArchive(payloadRoot, destination) {
  await runFile(
    "tar",
    [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-czf",
      destination,
      "-C",
      payloadRoot,
      ".",
    ],
    { env: { ...process.env, GZIP: "-n" } },
  );
}

async function main() {
  if (process.platform !== "linux") {
    throw packagingError("installer packaging은 Linux host에서만 지원합니다.");
  }
  if (await pathExists(artifactsPath)) {
    throw packagingError("기존 artifacts 경로를 덮어쓰지 않습니다. 별도로 옮기거나 제거한 뒤 진행하세요.");
  }

  const packageSource = await readFile(join(root, "package.json"), "utf8");
  const packageManifest = requireObject(JSON.parse(packageSource), "package.json");
  const packageVersion = requireString(packageManifest.version, "package.json version", /^\d+\.\d+\.\d+$/u);
  if (packageManifest.name !== "cat-agent-cli") {
    throw packagingError("예상한 package 이름이 아닙니다.");
  }

  const lockPath = join(root, "package-lock.json");
  const lockChecksumBefore = sha256(await readFile(lockPath));
  const runtimeSource = await readFile(manifestPath, "utf8");
  const runtime = parseRuntimeManifest(runtimeSource);
  const installerTemplate = await readFile(installerTemplatePath, "utf8");
  const temporary = await mkdtemp(join(root, ".cat-package-"));
  const publishStage = join(temporary, "publish");

  try {
    const applicationStage = join(temporary, "application");
    const downloadStage = join(temporary, "downloads");
    await mkdir(downloadStage, { recursive: true });
    await mkdir(publishStage, { recursive: true });
    await copyApplication(applicationStage);

    const downloadedRuntimes = new Map();
    for (const target of runtime.targets) {
      const destination = join(downloadStage, target.archive);
      process.stdout.write(`[package] Node.js ${runtime.version} ${target.architecture} 다운로드 및 검증\n`);
      await downloadRuntime(target, destination);
      downloadedRuntimes.set(target.architecture, destination);
    }

    const checksumLines = [];
    for (const target of runtime.targets) {
      const payloadRoot = join(temporary, `payload-${target.architecture}`);
      const payloadApp = join(payloadRoot, "app");
      const payloadRuntime = join(payloadRoot, "runtime");
      await mkdir(payloadRuntime, { recursive: true });
      await cp(applicationStage, payloadApp, { recursive: true });
      await copyFile(downloadedRuntimes.get(target.architecture), join(payloadRuntime, target.archive));
      await writeFile(join(payloadRoot, "runtime-manifest.json"), runtimeSource, {
        encoding: "utf8",
        mode: 0o644,
      });

      const payloadArchive = join(temporary, `payload-${target.architecture}.tar.gz`);
      await createPayloadArchive(payloadRoot, payloadArchive);
      const payloadBuffer = await readFile(payloadArchive);
      const payloadChecksum = sha256(payloadBuffer);
      const payloadBase64 = payloadBuffer.toString("base64").match(/.{1,76}/gu)?.join("\n") ?? "";
      const installerName = `cat-agent-cli-v${packageVersion}-linux-${target.architecture}-install.sh`;
      const installer = renderInstaller(installerTemplate, {
        NODE_ARCHIVE: target.archive,
        NODE_SHA256: target.checksum,
        NODE_VERSION: runtime.version,
        PACKAGE_VERSION: packageVersion,
        PAYLOAD: payloadBase64,
        PAYLOAD_SHA256: payloadChecksum,
        TARGET_ARCH: target.architecture,
      });
      const installerPath = join(publishStage, installerName);
      await writeFile(installerPath, installer, { encoding: "utf8", mode: 0o755 });
      await chmod(installerPath, 0o755);

      const installerChecksum = sha256(await readFile(installerPath));
      const checksumLine = `${installerChecksum}  ${installerName}`;
      checksumLines.push(checksumLine);
      await writeFile(`${installerPath}.sha256`, `${checksumLine}\n`, "utf8");
    }

    checksumLines.sort();
    await writeFile(join(publishStage, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, "utf8");

    const lockChecksumAfter = sha256(await readFile(lockPath));
    if (lockChecksumAfter !== lockChecksumBefore) {
      throw packagingError("packaging 도중 root package-lock.json이 변경되었습니다.");
    }
    await rename(publishStage, artifactsPath);
    process.stdout.write(`[package] 완료: ${artifactsPath}\n`);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
