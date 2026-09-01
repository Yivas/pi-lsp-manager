import { existsSync, writeFileSync } from "node:fs";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
const events = { initialized: 0, configuration: 0, folders: 0, open: 0, change: 0, close: 0, cancelled: 0, late: 0 };
let lastUri = "file:///workspace/file.ts";
let pushOnly = false;
let unversionedDiagnostics = false;
let crashOnceMethod;
let crashOnceMarker;
function crashOnce(method) {
  if (crashOnceMethod !== method || !crashOnceMarker || existsSync(crashOnceMarker)) return false;
  writeFileSync(crashOnceMarker, method);
  setImmediate(() => process.exit(1));
  return true;
}
connection.onRequest("initialize", async (params) => {
  pushOnly = params?.initializationOptions?.pushOnly === true;
  unversionedDiagnostics = params?.initializationOptions?.unversionedDiagnostics === true;
  crashOnceMethod = params?.initializationOptions?.crashOnceMethod;
  crashOnceMarker = params?.initializationOptions?.crashOnceMarker;
  if (params?.initializationOptions?.delayInitialize) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  events.configuration += 1;
  await connection.sendRequest("workspace/configuration", { items: [{}] });
  events.folders += 1;
  await connection.sendRequest("workspace/workspaceFolders");
  return {
    capabilities: {
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      renameProvider: { prepareProvider: true },
      codeActionProvider: true,
      ...(pushOnly ? {} : { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }),
      textDocumentSync: 1,
    },
  };
});
connection.onNotification("initialized", () => { events.initialized += 1; });
connection.onNotification("workspace/didChangeConfiguration", () => { events.configuration += 1; });
connection.onNotification("textDocument/didOpen", (params) => {
  events.open += 1;
  lastUri = params.textDocument.uri;
  connection.sendNotification("textDocument/publishDiagnostics", {
    uri: lastUri,
    ...(unversionedDiagnostics ? {} : { version: params.textDocument.version }),
    diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, code: "fake", source: "fake", message: "fake diagnostic" }],
  });
});
connection.onNotification("textDocument/didChange", () => { events.change += 1; });
connection.onNotification("textDocument/didClose", () => { events.close += 1; });
connection.onNotification("$/cancelRequest", () => { events.cancelled += 1; });
connection.onRequest("textDocument/diagnostic", () => {
  if (crashOnce("textDocument/diagnostic")) return new Promise(() => undefined);
  return { kind: "full", items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, code: "fake", source: "fake", message: "fake diagnostic" }] };
});
connection.onRequest("textDocument/definition", () => {
  if (crashOnce("textDocument/definition")) return new Promise(() => undefined);
  return [{ uri: lastUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }];
});
connection.onRequest("textDocument/references", () => {
  if (crashOnce("textDocument/references")) return new Promise(() => undefined);
  return [
    { uri: lastUri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
    { uri: lastUri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
  ];
});
connection.onRequest("textDocument/documentSymbol", () => {
  if (crashOnce("textDocument/documentSymbol")) return new Promise(() => undefined);
  return [{ name: "zeta", kind: 12, detail: "fake" }, { name: "alpha", kind: 12, detail: "fake" }];
});
connection.onRequest("workspace/symbol", () => {
  if (crashOnce("workspace/symbol")) return new Promise(() => undefined);
  return [{ name: "zeta", kind: 12, detail: "fake" }, { name: "alpha", kind: 12, detail: "fake" }];
});
connection.onRequest("textDocument/prepareRename", () => {
  if (crashOnce("textDocument/prepareRename")) return new Promise(() => undefined);
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
});
connection.onRequest("textDocument/codeAction", (params) => {
  if (crashOnce("textDocument/codeAction")) return new Promise(() => undefined);
  if ((params?.range?.end?.line ?? 0) < 1 || (params?.context?.diagnostics?.length ?? 0) < 1) return [];
  return [{ title: "Fake fix", kind: "quickfix", edit: { changes: {} } }];
});
connection.onRequest("state", () => events);
connection.onRequest("late", (_params, token) => new Promise((resolve) => {
  events.late += 1;
  token.onCancellationRequested(() => { events.cancelled += 1; });
  setTimeout(() => resolve("late"), 20);
}));
connection.onRequest("silent", () => new Promise(() => undefined));
connection.onRequest("crash", () => {
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 0);
  return new Promise(() => undefined);
});
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
