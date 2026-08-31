import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
const events = { initialized: 0, configuration: 0, folders: 0, open: 0, change: 0, close: 0, cancelled: 0, late: 0 };
connection.onRequest("initialize", async (params) => {
  if (params?.initializationOptions?.delayInitialize) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  events.configuration += 1;
  await connection.sendRequest("workspace/configuration", { items: [{}] });
  events.folders += 1;
  await connection.sendRequest("workspace/workspaceFolders");
  return { capabilities: { definitionProvider: true, textDocumentSync: 1 } };
});
connection.onNotification("initialized", () => { events.initialized += 1; });
connection.onNotification("workspace/didChangeConfiguration", () => { events.configuration += 1; });
connection.onNotification("textDocument/didOpen", () => { events.open += 1; });
connection.onNotification("textDocument/didChange", () => { events.change += 1; });
connection.onNotification("textDocument/didClose", () => { events.close += 1; });
connection.onNotification("$/cancelRequest", () => { events.cancelled += 1; });
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
