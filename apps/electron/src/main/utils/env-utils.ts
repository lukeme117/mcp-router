import process from "node:process";
import * as fs from "node:fs";
import * as path from "node:path";
import { execa } from "execa";
import stripAnsi from "strip-ansi";
import { homedir, userInfo } from "node:os";
import { logInfo } from "@/main/utils/logger";

const DELIMITER = "_ENV_DELIMITER_";

/**
 * Common bin directories where developer tools like uvx, npx, node, bun, etc.
 * are typically installed. macOS GUI-launched apps inherit a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) that excludes /usr/local/bin, /opt/homebrew/bin,
 * and user-local dirs — so when getUserShellEnv() fails or times out, the
 * fallback process.env can't find these tools and spawn returns ENOENT.
 * We prepend the directories that actually exist on disk to keep the augmented
 * PATH tidy.
 */
function getCommonBinPaths(): string[] {
  if (process.platform === "win32") return [];
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    path.join(home, ".local", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".deno", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, "Library", "pnpm"),
  ].filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Return a copy of `env` with common developer bin directories prepended to PATH.
 * Existing PATH entries are preserved (and deduplicated) so user-supplied paths
 * still take precedence on collisions further down.
 */
function withAugmentedPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const extras = getCommonBinPaths();
  if (extras.length === 0) return env;
  const existing = (env.PATH || "").split(":").filter(Boolean);
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const p of [...extras, ...existing]) {
    if (!seen.has(p)) {
      seen.add(p);
      combined.push(p);
    }
  }
  return { ...env, PATH: combined.join(":") };
}

/**
 * Check if a command exists in the system's PATH
 * @param cmd Command to check
 * @returns boolean indicating whether the command exists
 */
export async function commandExists(cmd: string): Promise<boolean> {
  try {
    const shellEnv = await getUserShellEnv();
    // Get PATH from shell environment
    const PATH = shellEnv.PATH || shellEnv.Path || process.env.PATH;
    if (!PATH) return false;

    // Check if the command exists using 'which' on Unix or 'where' on Windows
    const checkCommand = process.platform === "win32" ? "where" : "which";
    await execa(checkCommand, [cmd], {
      env: shellEnv,
      stdio: "ignore",
      reject: true,
    });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Run a command with proper logging
 * @param cmd Command to run or executable path
 * @param args Array of arguments to pass to the command
 * @param useShell Whether to use shell for command execution (default: false)
 * @param useShellEnv Whether to use the user's shell environment (default: true)
 * @returns Command output as string
 */
export async function run(cmd: string, args: string[] = [], useShell = false) {
  const cmdDisplay = useShell ? cmd : `${cmd} ${args.join(" ")}`;
  logInfo(`\n> ${cmdDisplay}, useShell: ${useShell}\n`);

  try {
    // If useShellEnv is true, get and merge user's shell environment
    const shellEnv = await getUserShellEnv();

    // Change stdio to pipe both stdout and stderr
    const { stdout, stderr } = await execa(cmd, args, {
      shell: useShell,
      stdio: ["inherit", "pipe", "pipe"], // Changed to pipe stderr as well
      env: shellEnv,
    });

    // Return the combined output if stdout is empty but stderr has content
    // This handles commands that output to stderr instead of stdout
    return stdout || stderr;
  } catch (err) {
    // For errors, try to extract any useful output from stderr/stdout
    if (
      err &&
      typeof err === "object" &&
      ("stderr" in err || "stdout" in err)
    ) {
      const errorOutput = (err as any).stdout || (err as any).stderr;
      return errorOutput; // Return any output even on error
    }
    throw err;
  }
}

// ユーザのシェルで読み込まれる環境変数を取得する非同期関数
const SHELL_ENV_TIMEOUT_MS = 5_000;

export async function getUserShellEnv() {
  // Windowsの場合、シェル初期化ファイルの問題がないのでそのまま返す
  if (process.platform === "win32") {
    return { ...process.env };
  }

  try {
    // ログインシェル( -l ) + 対話モード( -i )を実行し、envを取得する
    // `DISABLE_AUTO_UPDATE` は oh-my-zsh の自動アップデートを防ぐための例
    const shell = detectDefaultShell();
    // Bound the shell invocation. Slow or hanging shell init (Powerlevel10k
    // instant prompt, oh-my-zsh auto-update, conda init with network) would
    // otherwise stall every MCP server start indefinitely.
    const { stdout } = await execa(
      shell,
      ["-ilc", `echo -n "${DELIMITER}"; env; echo -n "${DELIMITER}"`],
      {
        env: {
          DISABLE_AUTO_UPDATE: "true",
        },
        timeout: SHELL_ENV_TIMEOUT_MS,
      },
    );

    // 出力は '_ENV_DELIMITER_env_vars_ENV_DELIMITER_' の形になるので、区切ってパースする
    const parts = stdout.split(DELIMITER);
    const rawEnv = parts[1] || ""; // 区切り文字の間の部分

    const shellEnv: { [key: string]: string } = {};
    for (const line of stripAnsi(rawEnv).split("\n")) {
      if (!line) continue;
      const [key, ...values] = line.split("=");
      shellEnv[key] = values.join("=");
    }

    return shellEnv;
  } catch (error) {
    // シェルの起動に失敗 / タイムアウトした場合は、Electron / Node.js の既存の環境変数を
    // PATH 拡張付きで返す。macOS の GUI 起動アプリでは /usr/local/bin などが PATH に
    // 含まれないため、uvx/npx/node 等の発見に失敗してしまう。
    console.log(
      `[env-utils] getUserShellEnv failed/timed out, augmenting process.env PATH with common bin dirs: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return withAugmentedPath({ ...process.env });
  }
}

/**
 * Detect the default shell for the current platform
 * @returns The path to the default shell
 */
const detectDefaultShell = () => {
  const { env } = process;

  if (process.platform === "win32") {
    return env.COMSPEC || "cmd.exe";
  }

  const { shell } = userInfo();
  if (shell) {
    return shell;
  }

  if (process.platform === "darwin") {
    return env.SHELL || "/bin/zsh";
  }

  return env.SHELL || "/bin/sh";
};
