// LSP Extension for pi — provides Language Server Protocol integration.
//
// Gives the agent type-aware hover, go-to-definition, find-references,
// diagnostics, document-symbols, rename, and code-actions via a registered
// `lsp` tool. Intercepts write/edit to surface blocking diagnostics inline.
//
// Environment variables:
//   PI_LSP_DISABLED=1        — disable all LSP functionality
//   PI_LSP_SERVERS=a,b       — restrict to listed servers
//   PI_LSP_SEVERITY=2        — inline severity threshold (1=error, 2=warn, 3=info, 4=hint)

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadConfig } from "./config.ts";
import { formatDiagnostics } from "./diagnostics.ts";
import { LspManager } from "./manager.ts";
import { executeAction, type LspAction, lspToolDescription } from "./tool-actions.ts";

const LspActionEnum = Type.Union([
  Type.Literal("hover"),
  Type.Literal("definition"),
  Type.Literal("references"),
  Type.Literal("diagnostics"),
  Type.Literal("symbols"),
  Type.Literal("rename"),
  Type.Literal("code_actions"),
]);

export default function lspExtension(pi: ExtensionAPI) {
  // ── guard: globally disabled ────────────────────────────────────────
  if (process.env.PI_LSP_DISABLED === "1") {
    pi.registerCommand("lsp-status", {
      description: "Show LSP server status",
      handler: async (_args, ctx) => {
        ctx.ui.notify("LSP is disabled (PI_LSP_DISABLED=1)", "warning");
      },
    });
    return;
  }

  // ── state ───────────────────────────────────────────────────────────
  let manager: LspManager | null = null;
  const inlineSeverity = parseSeverity(process.env.PI_LSP_SEVERITY);

  // ── session lifecycle ───────────────────────────────────────────────
  pi.on("session_start", async (_event, _ctx) => {
    // Shut down any prior session's servers
    if (manager) {
      await manager.shutdownAll();
    }
    const config = loadConfig(process.cwd());
    manager = new LspManager(config);
  });

  pi.on("session_shutdown", async () => {
    if (manager) {
      await manager.shutdownAll();
      manager = null;
    }
  });

  // ── lsp tool ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: lspToolDescription,
    parameters: Type.Object({
      action: LspActionEnum,
      file: Type.Optional(Type.String({ description: "File path (relative or absolute)" })),
      line: Type.Optional(Type.Number({ description: "1-based line number" })),
      character: Type.Optional(Type.Number({ description: "1-based column number" })),
      newName: Type.Optional(Type.String({ description: "New name (for rename action)" })),
    }),
    // biome-ignore lint/complexity/useMaxParams: pi ToolDefinition.execute signature
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!manager) {
        return {
          content: [{ type: "text", text: "LSP not initialized. Start a new session first." }],
          details: {},
        };
      }
      const text = await executeAction(
        manager,
        params as {
          action: LspAction;
          file?: string;
          line?: number;
          character?: number;
          newName?: string;
        },
      );
      return {
        content: [{ type: "text", text }],
        details: {},
      };
    },
  });

  // ── write/edit interception ─────────────────────────────────────────
  pi.on("tool_result", async (event) => {
    if (!manager) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const input = event.input as { path?: string };
    const filePath = input.path;
    if (!filePath) return;

    try {
      const diags = await manager.syncFileAndGetDiagnostics(filePath, inlineSeverity);
      if (diags.length > 0) {
        const existing = Array.isArray(event.content) ? event.content : [];
        const diagText = formatDiagnostics(filePath, diags);
        return {
          content: [
            ...existing,
            { type: "text" as const, text: `\n\n⚠️ LSP Diagnostics:\n${diagText}` },
          ],
        };
      }
    } catch {
      // Never block the agent on LSP errors
    }
  });

  // ── /lsp-status command ─────────────────────────────────────────────
  pi.registerCommand("lsp-status", {
    description: "Show LSP server status, open files, and diagnostics",
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: simple sequential logic
    handler: async (_args, ctx) => {
      if (!manager) {
        ctx.ui.notify("LSP not initialized", "warning");
        return;
      }
      const status = manager.getStatus();
      const lines: string[] = ["## LSP Status\n"];

      if (status.servers.length === 0) {
        lines.push("No LSP servers active.\n");
      } else {
        for (const s of status.servers) {
          const icon = s.status === "running" ? "🟢" : s.status === "error" ? "🔴" : "⚪";
          lines.push(`${icon} **${s.name}** — ${s.status} (root: ${s.root})`);
          lines.push(`   Files: ${s.openFiles.join(", ") || "none"}`);
        }
      }

      const diagSummary = manager.getDiagnosticSummary();
      if (diagSummary.length > 0) {
        lines.push("\n### Diagnostics");
        for (const d of diagSummary) {
          lines.push(`- **${d.file}**: ${d.errors} error(s), ${d.warnings} warning(s)`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

function parseSeverity(env: string | undefined): number {
  if (!env) return 1; // default: errors only
  const n = parseInt(env, 10);
  if (n >= 1 && n <= 4) return n;
  return 1;
}
