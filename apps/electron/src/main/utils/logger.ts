/**
 * エラーハンドリングとログ出力のためのユーティリティ
 */

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { isDevelopment } from "./environment";

let cachedLogFilePath: string | null = null;
let logFileResolved = false;

/**
 * Resolve and prepare the log file path on first use. macOS: ~/Library/Logs/<appName>/main.log.
 * Returns null if the log directory cannot be created (e.g., app not yet ready).
 */
function getLogFilePath(): string | null {
  if (logFileResolved) return cachedLogFilePath;
  try {
    const logsDir = app.getPath("logs");
    fs.mkdirSync(logsDir, { recursive: true });
    cachedLogFilePath = path.join(logsDir, "main.log");
  } catch {
    cachedLogFilePath = null;
  }
  logFileResolved = true;
  return cachedLogFilePath;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendToLogFile(level: "INFO" | "ERROR", args: any[]): void {
  const file = getLogFilePath();
  if (!file) return;
  try {
    const line = `${new Date().toISOString()} [${level}] ${args
      .map(safeStringify)
      .join(" ")}\n`;
    fs.appendFile(file, line, () => {
      // best-effort, swallow errors
    });
  } catch {
    // best-effort
  }
}

/**
 * INFO レベルのログを出力
 * @param args ログに出力する任意の引数
 */
export function logInfo(...args: any[]): void {
  if (isDevelopment()) {
    console.log("[INFO]", JSON.stringify(args));
  }
  appendToLogFile("INFO", args);
}

/**
 * ERROR レベルのログを出力
 * @param args ログに出力する任意の引数
 */
export function logError(...args: any[]): void {
  // エラーログは本番環境でも出力する
  console.error("[ERROR]", ...args);
  appendToLogFile("ERROR", args);
}
