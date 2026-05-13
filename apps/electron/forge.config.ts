import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { WebpackPlugin } from "@electron-forge/plugin-webpack";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

import { mainConfig } from "./webpack.main.config";
import { rendererConfig } from "./webpack.renderer.config";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerDeb } from "@electron-forge/maker-deb";
import * as path from "path";
import { execFileSync } from "child_process";
import { postMake } from "./forge-hooks";

// eslint-disable-next-line @typescript-eslint/no-var-requires
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });


const isMac = process.platform === "darwin";
const hasSignIdentity = !!process.env.PUBLIC_IDENTIFIER;
const hasNotarizeCreds = !!(
  process.env.APPLE_API_KEY &&
  process.env.APPLE_API_KEY_ID &&
  process.env.APPLE_API_ISSUER
);

/**
 * Determine the architecture native modules and the packaged app should target.
 *
 * Resolution order:
 *   1. `npm_config_target_arch` — explicit override (cross-arch CI builds).
 *   2. `sysctl.proc_translated` on macOS — detects when an x86_64 Node binary
 *      runs under Rosetta on an Apple Silicon machine. In that case
 *      `process.arch` reports "x64" but Electron downloads an arm64 binary,
 *      so natives must be built for arm64 to be loadable by the host Electron.
 *   3. `process.arch` — normal case.
 */
function detectTargetArch(): NodeJS.Architecture {
  if (process.env.npm_config_target_arch) {
    return process.env.npm_config_target_arch as NodeJS.Architecture;
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    try {
      const translated = execFileSync(
        "sysctl",
        ["-n", "sysctl.proc_translated"],
        { encoding: "utf8" },
      ).trim();
      if (translated === "1") return "arm64";
    } catch {
      // sysctl missing or unavailable — fall through.
    }
  }
  return process.arch;
}

const targetArch = detectTargetArch();

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: "./public/images/icon/icon",
    // Support both Intel and Apple Silicon architectures (see detectTargetArch).
    arch: targetArch,
    // Set executable name for Linux
    executableName: process.platform === "linux" ? "mcp-router" : undefined,
    // Only sign/notarize on macOS when credentials are available (CI-safe)
    osxSign: isMac && hasSignIdentity
      ? {
          identity: process.env.PUBLIC_IDENTIFIER,
        }
      : undefined,
    osxNotarize: isMac && hasNotarizeCreds
      ? {
          appleApiKey: process.env.APPLE_API_KEY || "",
          appleApiKeyId: process.env.APPLE_API_KEY_ID || "",
          appleApiIssuer: process.env.APPLE_API_ISSUER || "",
        }
      : undefined,
  },
  rebuildConfig: {
    // Force rebuild native modules for the target architecture
    arch: targetArch,
  },
  makers: [
    new MakerSquirrel({
      name: "MCP-Router",
      authors: "fjm2u",
      description:
        "Effortlessly manage your MCP servers with the MCP Router. MCP Router provides a user-friendly interface for managing MCP servers, making it easier than ever to work with the MCP.",
      setupIcon: "./public/images/icon/icon.ico",
    }),
    new MakerDMG(
      {
        name: "MCP-Router",
        format: "ULFO",
        icon: "./public/images/icon/icon.icns",
      },
      ["darwin"],
    ),
    new MakerDeb({
      options: {
        name: "mcp-router",
        productName: "MCP Router",
        genericName: "MCP Server Manager",
        description:
          "Effortlessly manage your MCP servers with the MCP Router. MCP Router provides a user-friendly interface for managing MCP servers, making it easier than ever to work with the MCP.",
        productDescription:
          "A unified MCP server management application for managing Model Context Protocol servers.",
        maintainer: "fjm2u",
        homepage: "https://github.com/mcp-router/mcp-router",
        categories: ["Utility", "Development"],
        icon: "./public/images/icon/icon.png",
        bin: "mcp-router",
      },
    }),
    new MakerZIP(),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: "./src/index.html",
            js: "./src/renderer.tsx",
            name: "main_window",
            preload: {
              js: "./src/preload.ts",
            },
          },
        ],
      },
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        authToken: process.env.GITHUB_TOKEN,
        repository: {
          owner: "mcp-router",
          name: "mcp-router",
        },
        prerelease: true,
        draft: true,
      },
    },
  ],
  hooks: {
    postMake,
  },
};

export default config;
