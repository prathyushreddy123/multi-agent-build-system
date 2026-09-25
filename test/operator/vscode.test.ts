import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildVsCodeInvocation,
  detectWslDistro,
  discoverVsCodeExecutable,
  isWindowsHostedVsCode,
  launchVsCode,
} from "../../src/operator/vscode.ts";

function executable(path: string, body = "#!/bin/sh\nexit 0\n"): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

test("folder and file invocations preserve spaces and Unicode as single arguments", () => {
  const folder = "/home/user/live worktrees/任务 one";
  assert.deepEqual(
    buildVsCodeInvocation({ executable: "/usr/bin/code", windowsHosted: false }, { kind: "folder", path: folder }, null),
    { executable: "/usr/bin/code", args: ["--new-window", folder], remote: null },
  );

  const file = `${folder}/src/hello 世界.ts`;
  assert.deepEqual(
    buildVsCodeInvocation(
      { executable: "/mnt/c/Program Files/Microsoft VS Code/bin/code", windowsHosted: true },
      { kind: "file", path: file, line: 17, column: 4 },
      "Ubuntu-24.04",
    ),
    {
      executable: "/mnt/c/Program Files/Microsoft VS Code/bin/code",
      args: ["--remote", "wsl+Ubuntu-24.04", "--new-window", "--goto", `${file}:17:4`],
      remote: "wsl+Ubuntu-24.04",
    },
  );
});

test("Windows-hosted VS Code requires the detected WSL distribution", () => {
  assert.equal(detectWslDistro({ WSL_DISTRO_NAME: " Ubuntu-24.04 " }), "Ubuntu-24.04");
  assert.equal(detectWslDistro({}), null);
  assert.equal(isWindowsHostedVsCode("/mnt/c/Users/me/code.exe"), true);
  assert.throws(
    () => buildVsCodeInvocation(
      { executable: "/mnt/c/Users/me/code.exe", windowsHosted: true },
      { kind: "folder", path: "/home/me/worktree" },
      null,
    ),
    /WSL distribution could not be detected/,
  );
});

test("executable discovery honors option, environment, and PATH precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "mabs-vscode-discovery-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const option = join(root, "configured editor with spaces");
    const environment = join(root, "environment-code");
    const pathCode = join(bin, "code");
    executable(option);
    executable(environment);
    executable(pathCode);

    assert.deepEqual(
      discoverVsCodeExecutable({
        configuredExecutable: option,
        env: { PATH: bin, MABS_VSCODE_EXECUTABLE: environment },
      }).source,
      "option",
    );
    assert.equal(
      discoverVsCodeExecutable({ env: { PATH: bin, MABS_VSCODE_EXECUTABLE: environment } }).executable,
      environment,
    );
    assert.equal(discoverVsCodeExecutable({ env: { PATH: bin } }).executable, pathCode);
    assert.throws(
      () => discoverVsCodeExecutable({ configuredExecutable: join(root, "missing"), env: { PATH: bin } }),
      /Configured VS Code executable.*unavailable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery follows symlinks when deciding whether the editor is Windows-hosted", () => {
  const root = mkdtempSync(join(tmpdir(), "mabs-vscode-link-"));
  try {
    const link = join(root, "code");
    // The pure detector accepts a canonical Windows path. Symlink behavior is
    // covered here with a Linux target to prove canonicalization is harmless.
    const target = join(root, "real-code");
    executable(target);
    symlinkSync(target, link);
    const found = discoverVsCodeExecutable({ configuredExecutable: link, env: { PATH: "" } });
    assert.equal(found.resolvedPath, target);
    assert.equal(found.windowsHosted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful CLI process is reported as an unverified launch request", async () => {
  const root = mkdtempSync(join(tmpdir(), "mabs-vscode-launch-"));
  try {
    const calls = join(root, "calls.json");
    const editor = join(root, "VS Code 测试");
    executable(editor, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\n`);
    const target = join(root, "live worktree", "src", "file name.ts");
    const result = await launchVsCode(
      { kind: "file", path: target, line: 9 },
      { configuredExecutable: editor, wslDistro: null },
    );
    assert.equal(result.status, "launch-requested");
    assert.equal(result.guiVerified, false);
    assert.deepEqual(JSON.parse(readFileSync(calls, "utf8")), ["--new-window", "--goto", `${target}:9`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected CLI request reports the target and process failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "mabs-vscode-failure-"));
  try {
    const editor = join(root, "code");
    executable(editor, "#!/bin/sh\nprintf 'remote extension unavailable' >&2\nexit 23\n");
    await assert.rejects(
      () => launchVsCode(
        { kind: "folder", path: "/home/me/live-worktree" },
        { configuredExecutable: editor, wslDistro: null },
      ),
      /could not request \/home\/me\/live-worktree: remote extension unavailable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relative targets and invalid locations fail before any editor runs", () => {
  assert.throws(
    () => buildVsCodeInvocation({ executable: "/usr/bin/code", windowsHosted: false }, { kind: "folder", path: "relative" }),
    /absolute paths/,
  );
  assert.throws(
    () => buildVsCodeInvocation(
      { executable: "/usr/bin/code", windowsHosted: false },
      { kind: "file", path: "/work/file.ts", line: 0 },
    ),
    /positive integer/,
  );
});
