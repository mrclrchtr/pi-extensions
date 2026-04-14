// LSP Manager — server pool with lazy spawning and diagnostic collection.

import * as fs from "node:fs";
import * as path from "node:path";
import { LspClient } from "./client.ts";
import { getServerForFile } from "./config.ts";
import type { Diagnostic, LspConfig } from "./types.ts";
import { commandExists, findProjectRoot } from "./utils.ts";

// ── Types ─────────────────────────────────────────────────────────────

export interface ServerStatus {
  name: string;
  status: "running" | "error" | "unavailable";
  root: string;
  openFiles: string[];
}

export interface DiagnosticSummary {
  file: string;
  errors: number;
  warnings: number;
}

export interface ManagerStatus {
  servers: ServerStatus[];
}

// ── LspManager ────────────────────────────────────────────────────────

export class LspManager {
  /** Active clients keyed by "serverName:root" */
  private clients = new Map<string, LspClient>();
  /** Servers we've already tried and failed to start */
  private unavailable = new Set<string>();

  constructor(private readonly config: LspConfig) {}

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Get or create an LSP client for the given file.
   * Returns null if no server is configured or available.
   */
  async getClientForFile(filePath: string): Promise<LspClient | null> {
    const match = getServerForFile(this.config, filePath);
    if (!match) return null;

    const [serverName, serverConfig] = match;

    // Find project root
    const fileDir = path.dirname(path.resolve(filePath));
    const root = findProjectRoot(fileDir, serverConfig.rootMarkers, process.cwd());
    const key = `${serverName}:${root}`;

    // Check if unavailable
    if (this.unavailable.has(key)) return null;

    // Return existing client
    const existing = this.clients.get(key);
    if (existing && existing.status === "running") return existing;

    // If existing client errored, remove it
    if (existing && existing.status === "error") {
      this.clients.delete(key);
      this.unavailable.add(key);
      return null;
    }

    // Validate command exists
    if (!commandExists(serverConfig.command)) {
      this.unavailable.add(key);
      return null;
    }

    // Spawn new client
    const client = new LspClient(serverName, serverConfig, root);
    this.clients.set(key, client);

    try {
      await client.start();
      return client;
    } catch (_err) {
      this.unavailable.add(key);
      this.clients.delete(key);
      return null;
    }
  }

  /**
   * Sync a file with its LSP server and wait for diagnostics.
   * Returns diagnostics filtered to the given severity threshold.
   */
  async syncFileAndGetDiagnostics(
    filePath: string,
    maxSeverity: number = 1,
  ): Promise<Diagnostic[]> {
    const client = await this.getClientForFile(filePath);
    if (!client) return [];

    const resolvedPath = path.resolve(filePath);
    let content: string;
    try {
      content = fs.readFileSync(resolvedPath, "utf-8");
    } catch {
      return [];
    }

    const diagnostics = await client.syncAndWaitForDiagnostics(resolvedPath, content);
    return diagnostics.filter((d) => d.severity !== undefined && d.severity <= maxSeverity);
  }

  /** Shut down all running LSP servers. */
  async shutdownAll(): Promise<void> {
    const shutdowns = Array.from(this.clients.values()).map((c) => c.shutdown().catch(() => {}));
    await Promise.all(shutdowns);
    this.clients.clear();
    this.unavailable.clear();
  }

  /** Get status of all servers. */
  getStatus(): ManagerStatus {
    const servers: ServerStatus[] = [];
    for (const [_key, client] of this.clients) {
      servers.push({
        name: client.name,
        status: client.status === "running" ? "running" : "error",
        root: client.root,
        openFiles: client.openFiles,
      });
    }
    return { servers };
  }

  /** Get a diagnostic summary across all servers and files. */
  getDiagnosticSummary(): DiagnosticSummary[] {
    const fileDiags = new Map<string, { errors: number; warnings: number }>();

    for (const client of this.clients.values()) {
      for (const entry of client.getAllDiagnostics()) {
        const file = path.relative(process.cwd(), entry.uri.replace("file://", ""));
        const current = fileDiags.get(file) ?? { errors: 0, warnings: 0 };
        for (const d of entry.diagnostics) {
          if (d.severity === 1) current.errors++;
          else if (d.severity === 2) current.warnings++;
        }
        fileDiags.set(file, current);
      }
    }

    return Array.from(fileDiags.entries()).map(([file, counts]) => ({
      file,
      ...counts,
    }));
  }

  /**
   * Ensure a file is open in its LSP server.
   * Used when the agent needs to read a file for the first time.
   */
  async ensureFileOpen(filePath: string): Promise<LspClient | null> {
    const client = await this.getClientForFile(filePath);
    if (!client) return null;

    const resolvedPath = path.resolve(filePath);
    try {
      const content = fs.readFileSync(resolvedPath, "utf-8");
      client.didOpen(resolvedPath, content);
      return client;
    } catch {
      return null;
    }
  }
}
