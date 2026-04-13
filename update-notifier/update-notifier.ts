/**
 * update-notifier — Notifies when a new version of pi is available.
 *
 * On session start, checks the npm registry for a newer version.
 * If found, shows a persistent widget — no automatic install.
 * Run /update manually to check and install.
 * Detects install method (npm, pnpm, yarn, bun) to use the right command.
 *
 * Set PI_SKIP_AUTO_UPDATE=1 to disable the startup check.
 * Command: /update — manually trigger an update check + install
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { exec, execSync } from "node:child_process";

const PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function binaryExists(binary: string): boolean {
	try {
		execSync(`command -v ${binary}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function detectInstallMethod(): string {
	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase();
	if (resolvedPath.includes("/.bun/") || resolvedPath.includes("\\.bun\\")) {
		return "bun";
	}
	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/") || resolvedPath.includes("\\pnpm\\")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/") || resolvedPath.includes("\\yarn\\")) {
		return "yarn";
	}
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/") || resolvedPath.includes("\\npm\\")) {
		return "npm";
	}

	if (binaryExists("bun")) return "bun";
	if (binaryExists("pnpm")) return "pnpm";
	if (binaryExists("yarn")) return "yarn";
	if (binaryExists("npm")) return "npm";

	return "npm";
}

function getInstallCommand(): string {
	const method = detectInstallMethod();
	switch (method) {
		case "bun":
			return `bun install -g ${PACKAGE_NAME}`;
		case "pnpm":
			return `pnpm install -g ${PACKAGE_NAME}`;
		case "yarn":
			return `yarn global add ${PACKAGE_NAME}`;
		default:
			return `npm install -g ${PACKAGE_NAME}`;
	}
}

function getCurrentVersion(): string | undefined {
	try {
		const pkgPath = require.resolve(`${PACKAGE_NAME}/package.json`);
		return require(pkgPath).version;
	} catch {
		try {
			const result = execSync("pi --version 2>/dev/null || echo unknown", { encoding: "utf-8" }).trim();
			return result === "unknown" ? undefined : result;
		} catch {
			return undefined;
		}
	}
}

async function fetchLatestVersion(): Promise<string | undefined> {
	try {
		const response = await fetch(REGISTRY_URL);
		if (!response.ok) return undefined;
		const data = (await response.json()) as { version?: string };
		return data.version;
	} catch {
		return undefined;
	}
}

function isNewer(latest: string, current: string): boolean {
	const l = latest.split(".").map(Number);
	const c = current.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
		if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
	}
	return false;
}

function runInstallAsync(cmd: string): Promise<{ ok: boolean; error?: string }> {
	return new Promise((resolve) => {
		const child = exec(cmd, { timeout: 120_000 }, (err, _stdout, stderr) => {
			if (err) {
				const msg = stderr?.trim()?.split("\n").pop() || err.message || "unknown error";
				resolve({ ok: false, error: msg });
			} else {
				resolve({ ok: true });
			}
		});
		// Ensure we don't keep the process alive if pi exits
		child.unref();
	});
}

export default function (pi: ExtensionAPI) {
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;

	function startSpinner(ctx: { ui: any }, message: string) {
		let frame = 0;
		const render = () => {
			const theme = ctx.ui.theme;
			const s = theme.fg("warning", SPINNER[frame % SPINNER.length]);
			ctx.ui.setWidget("update-notifier", [s + " " + theme.fg("dim", message)]);
			frame++;
		};
		render();
		spinnerTimer = setInterval(render, 80);
	}

	function stopSpinner() {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	}

	function showResult(ctx: { ui: any }, color: string, message: string, ttl: number) {
		const theme = ctx.ui.theme;
		ctx.ui.setWidget("update-notifier", [theme.fg(color, "●") + " " + theme.fg("dim", message)]);
		setTimeout(() => ctx.ui.setWidget("update-notifier", undefined), ttl);
	}

	async function notifyIfUpdateAvailable(ctx: { ui: any }): Promise<void> {
		if (process.env.PI_SKIP_AUTO_UPDATE) return;

		const current = getCurrentVersion();
		if (!current) return;

		const latest = await fetchLatestVersion();
		if (!latest) return;

		if (!isNewer(latest, current)) return;

		// Show a persistent widget — user must run /update to install
		const theme = ctx.ui.theme;
		ctx.ui.setWidget("update-notifier", [
			theme.fg("warning", "●") + " " + theme.fg("dim", `pi ${latest} available (current: ${current}) — run /update to install`),
		]);
	}

	async function checkAndUpdate(ctx: { ui: any }): Promise<void> {
		if (process.env.PI_SKIP_AUTO_UPDATE) {
			ctx.ui.notify("Auto-update is disabled (PI_SKIP_AUTO_UPDATE)", "info");
			return;
		}

		const current = getCurrentVersion();
		if (!current) {
			ctx.ui.notify("Could not determine current pi version", "warning");
			return;
		}

		startSpinner(ctx, `checking for updates (${current})...`);

		const latest = await fetchLatestVersion();

		if (!latest) {
			stopSpinner();
			showResult(ctx, "warning", "could not check for updates", 5000);
			return;
		}

		if (!isNewer(latest, current)) {
			stopSpinner();
			showResult(ctx, "success", `pi ${current} is up to date`, 5000);
			return;
		}

		// New version available — install
		startSpinner(ctx, `updating pi ${current} → ${latest}...`);

		const result = await runInstallAsync(getInstallCommand());
		stopSpinner();

		if (result.ok) {
			ctx.ui.setWidget("update-notifier", undefined); // clear the notification widget if it was shown
			showResult(ctx, "success", `pi updated to ${latest} — restart to apply`, 15000);
		} else {
			showResult(ctx, "error", `update failed: ${result.error}`, 10000);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		setTimeout(() => notifyIfUpdateAvailable(ctx), 3000);
	});

	pi.registerCommand("update", {
		description: "Check for pi updates and install if available",
		handler: async (_args, ctx) => {
			await checkAndUpdate(ctx);
		},
	});
}
