// Integration tests — spawn real LSP servers against temp projects.
// These require typescript-language-server + tsserver on PATH.
// Skip with: pnpm test -- --testPathIgnorePatterns integration

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LspClient } from "../client.ts";
import type { Diagnostic, ServerConfig } from "../types.ts";

const TS_SERVER_CONFIG: ServerConfig = {
  command: "typescript-language-server",
  args: ["--stdio"],
  fileTypes: ["ts"],
  rootMarkers: ["tsconfig.json", "package.json"],
};

// ── Fixture Setup ─────────────────────────────────────────────────────

let tmpDir: string;
let goodFile: string;
let badFile: string;

function hasCommand(cmd: string): boolean {
  try {
    const { execSync } = require("node:child_process");
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_TS_LSP = hasCommand("typescript-language-server") && hasCommand("tsserver");

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-integration-"));

  // Minimal tsconfig
  fs.writeFileSync(
    path.join(tmpDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext" },
      include: ["*.ts"],
    }),
  );

  // A valid TS file
  goodFile = path.join(tmpDir, "good.ts");
  fs.writeFileSync(
    goodFile,
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  );

  // A file with a type error
  badFile = path.join(tmpDir, "bad.ts");
  fs.writeFileSync(badFile, 'export const x: number = "not a number";\n');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe.skipIf(!HAS_TS_LSP)("LspClient integration (typescript-language-server)", () => {
  let client: LspClient;

  afterAll(async () => {
    if (client?.status === "running") {
      await client.shutdown();
    }
  });

  it("starts and initializes successfully", async () => {
    client = new LspClient("typescript-language-server", TS_SERVER_CONFIG, tmpDir);
    await client.start();
    expect(client.status).toBe("running");
  }, 15_000);

  it("opens a document and tracks it", () => {
    const content = fs.readFileSync(goodFile, "utf-8");
    client.didOpen(goodFile, content);
    expect(client.openFiles).toContain(goodFile);
  });

  it("returns hover information", async () => {
    const hover = await client.hover(goodFile, { line: 0, character: 16 });
    expect(hover).not.toBeNull();
    // Should contain "add" function signature
    const text = JSON.stringify(hover);
    expect(text).toContain("add");
  }, 10_000);

  it("returns definition location", async () => {
    // Write a file that references something
    const refFile = path.join(tmpDir, "ref.ts");
    fs.writeFileSync(refFile, 'import { add } from "./good";\nconst result = add(1, 2);\n');
    client.didOpen(refFile, fs.readFileSync(refFile, "utf-8"));

    // Wait for server to process
    await sleep(1000);

    // Go to definition of "add" on line 2, col ~16
    const def = await client.definition(refFile, { line: 1, character: 15 });
    expect(def).not.toBeNull();
  }, 10_000);

  it("returns document symbols", async () => {
    const symbols = await client.documentSymbols(goodFile);
    expect(symbols).not.toBeNull();
    expect(Array.isArray(symbols)).toBe(true);
    expect(symbols?.length).toBeGreaterThan(0);

    // Should find the "add" function
    const text = JSON.stringify(symbols);
    expect(text).toContain("add");
  }, 10_000);

  it("collects diagnostics for file with type error", async () => {
    const content = fs.readFileSync(badFile, "utf-8");
    const diagnostics = await client.syncAndWaitForDiagnostics(badFile, content);
    expect(diagnostics.length).toBeGreaterThan(0);
    // Should report a type error
    const hasError = diagnostics.some((d: Diagnostic) => d.severity === 1);
    expect(hasError).toBe(true);
  }, 10_000);

  it("returns no diagnostics for valid file", async () => {
    const content = fs.readFileSync(goodFile, "utf-8");
    const diagnostics = await client.syncAndWaitForDiagnostics(goodFile, content);

    // Filter to errors only (warnings about unused vars, etc. are ok)
    const errors = diagnostics.filter((d: Diagnostic) => d.severity === 1);
    expect(errors).toHaveLength(0);
  }, 10_000);

  it("updates diagnostics after fixing a file", async () => {
    // First sync bad content
    const badContent = 'export const y: number = "wrong";\n';
    const fixFile = path.join(tmpDir, "fixme.ts");
    fs.writeFileSync(fixFile, badContent);
    const diagsBefore = await client.syncAndWaitForDiagnostics(fixFile, badContent);
    const errorsBefore = diagsBefore.filter((d: Diagnostic) => d.severity === 1);
    expect(errorsBefore.length).toBeGreaterThan(0);

    // Now fix it
    const goodContent = "export const y: number = 42;\n";
    fs.writeFileSync(fixFile, goodContent);
    const diagsAfter = await client.syncAndWaitForDiagnostics(fixFile, goodContent);
    const errorsAfter = diagsAfter.filter((d: Diagnostic) => d.severity === 1);
    expect(errorsAfter).toHaveLength(0);
  }, 15_000);

  it("returns code actions for diagnostic", async () => {
    const content = fs.readFileSync(badFile, "utf-8");
    await client.syncAndWaitForDiagnostics(badFile, content);

    const diags = client.getDiagnostics(badFile);
    const actions = await client.codeActions(
      badFile,
      { start: { line: 0, character: 0 }, end: { line: 0, character: 40 } },
      { diagnostics: diags },
    );
    // May or may not have actions — just verify no crash
    expect(actions === null || Array.isArray(actions)).toBe(true);
  }, 10_000);

  it("closes a document and removes from tracking", () => {
    client.didClose(goodFile);
    expect(client.openFiles).not.toContain(goodFile);
  });

  it("shuts down cleanly", async () => {
    await client.shutdown();
    expect(client.status).toBe("shutdown");
  }, 10_000);
});

// ── Helper ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
