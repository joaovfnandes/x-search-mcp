import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type TransportKind = "stdio" | "http";
type JsonObject = Record<string, unknown>;

interface Config {
  transport: TransportKind;
  command?: string;
  args: string[];
  url?: string;
}

type EdgeWindow = { pid: number; windowId: number };

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`A variavel ${name} e obrigatoria.`);
  return value;
}

function loadConfig(): Config {
  const transport = (process.env.CUA_TRANSPORT?.trim() || "stdio") as TransportKind;
  if (transport !== "stdio" && transport !== "http") {
    throw new Error("CUA_TRANSPORT deve ser 'stdio' ou 'http'.");
  }

  const argsRaw = process.env.CUA_ARGS_JSON?.trim() || "[]";
  let args: string[];
  try {
    const parsed: unknown = JSON.parse(argsRaw);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("o valor precisa ser um array JSON de strings");
    }
    args = parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CUA_ARGS_JSON nao contem um array valido: ${message}`);
  }

  return {
    transport,
    command: transport === "stdio" ? required("CUA_COMMAND") : undefined,
    args,
    url: transport === "http" ? required("CUA_URL") : undefined
  };
}

function contentToText(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return JSON.stringify(result, null, 2);

  return content
    .map((item) => {
      if (!item || typeof item !== "object") return String(item);
      const block = item as { type?: string; text?: string; data?: string };
      if (block.type === "text" && block.text) return block.text;
      if (block.type === "image" && block.data) return `[imagem recebida: ${block.data.length} bytes]`;
      return JSON.stringify(item);
    })
    .join("\n");
}

function structuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const value = (result as { structuredContent?: unknown }).structuredContent;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CuaBridge {
  private client?: Client;
  private transport?: StdioClientTransport | StreamableHTTPClientTransport;

  constructor(private readonly config: Config) {}

  async connect(): Promise<Client> {
    if (this.client) return this.client;

    const client = new Client({ name: "x-search-mcp", version: "0.1.0" });
    if (this.config.transport === "stdio") {
      this.transport = new StdioClientTransport({
        command: this.config.command!,
        args: this.config.args,
        stderr: "inherit"
      });
    } else {
      this.transport = new StreamableHTTPClientTransport(new URL(this.config.url!));
    }

    await client.connect(this.transport);
    this.client = client;
    return client;
  }

  async listTools(): Promise<unknown> {
    const client = await this.connect();
    return client.listTools();
  }

  async callTool(name: string, args: JsonObject): Promise<unknown> {
    const client = await this.connect();
    return client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}

function throwIfToolFailed(name: string, result: unknown): void {
  if (result && typeof result === "object" && (result as { isError?: unknown }).isError === true) {
    throw new Error(`${name}: ${contentToText(result)}`);
  }
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function jsonToolList(value: unknown): string {
  const tools = (value as { tools?: Array<{ name?: string; description?: string }> })?.tools;
  if (!Array.isArray(tools)) return JSON.stringify(value, null, 2);
  return tools
    .map((tool) => `- ${tool.name ?? "(sem nome)"}: ${tool.description ?? "sem descricao"}`)
    .join("\n");
}

async function findEdgeWindow(bridge: CuaBridge): Promise<EdgeWindow> {
  const result = await bridge.callTool("list_windows", {});
  const structured = structuredContent(result);
  const rawWindows = structured.windows ?? structured._legacy_windows;
  const windows = Array.isArray(rawWindows) ? rawWindows : [];
  const edge = windows.find((item) => {
    if (!item || typeof item !== "object") return false;
    const window = item as Record<string, unknown>;
    const identity = `${window.app_name ?? ""} ${window.title ?? ""}`;
    return /edge|msedge/i.test(identity) && window.pid && window.window_id;
  }) as Record<string, unknown> | undefined;

  if (!edge) {
    throw new Error("Nao encontrei uma janela do Microsoft Edge. Abra o Edge e tente novamente.");
  }

  return { pid: Number(edge.pid), windowId: Number(edge.window_id) };
}

async function readEdgeState(bridge: CuaBridge, edge: EdgeWindow): Promise<unknown> {
  return bridge.callTool("get_window_state", {
    pid: edge.pid,
    window_id: edge.windowId,
    include_screenshot: false,
    max_elements: 300,
    max_depth: 12
  });
}

function findAddressBar(state: unknown): { elementIndex: number; elementToken?: string } {
  const elements = structuredContent(state).elements;
  if (Array.isArray(elements)) {
    const addressBar = elements.find((item) => {
      if (!item || typeof item !== "object") return false;
      const element = item as Record<string, unknown>;
      const label = String(element.label ?? "");
      const role = String(element.role ?? "");
      const value = String(element.value ?? "");
      return role === "Edit" && (/address|endereco|pesquisa|search/i.test(label) || value.startsWith("http"));
    }) as Record<string, unknown> | undefined;

    if (addressBar && typeof addressBar.element_index === "number") {
      return {
        elementIndex: addressBar.element_index,
        elementToken: typeof addressBar.element_token === "string" ? addressBar.element_token : undefined
      };
    }
  }

  const text = contentToText(state);
  const match = text.match(/\[(\d+)\] Edit [^\n]*(address|endere[cç]os|pesquisa)/i);
  if (match) return { elementIndex: Number(match[1]) };
  throw new Error("Nao encontrei a barra de enderecos do Edge no estado da janela.");
}

function addressBarValue(state: unknown): string {
  const elements = structuredContent(state).elements;
  if (!Array.isArray(elements)) return "";
  const addressBar = elements.find((item) => {
    if (!item || typeof item !== "object") return false;
    const element = item as Record<string, unknown>;
    const label = String(element.label ?? "");
    const value = String(element.value ?? "");
    return element.role === "Edit" && (/address|endereco|pesquisa|search/i.test(label) || value.startsWith("http"));
  }) as Record<string, unknown> | undefined;
  return typeof addressBar?.value === "string" ? addressBar.value : "";
}

async function navigateEdgeToSearch(bridge: CuaBridge, url: string): Promise<EdgeWindow> {
  const edge = await findEdgeWindow(bridge);
  const frontResult = await bridge.callTool("bring_to_front", {
    pid: edge.pid,
    window_id: edge.windowId
  });
  throwIfToolFailed("bring_to_front", frontResult);

  const initialState = await readEdgeState(bridge, edge);
  const addressBar = findAddressBar(initialState);

  const clickResult = await bridge.callTool("click", {
    pid: edge.pid,
    window_id: edge.windowId,
    element_index: addressBar.elementIndex,
    ...(addressBar.elementToken ? { element_token: addressBar.elementToken } : {}),
    delivery_mode: "foreground"
  });
  throwIfToolFailed("click", clickResult);

  const setValueResult = await bridge.callTool("set_value", {
    pid: edge.pid,
    window_id: edge.windowId,
    element_index: addressBar.elementIndex,
    ...(addressBar.elementToken ? { element_token: addressBar.elementToken } : {}),
    value: url
  });
  throwIfToolFailed("set_value", setValueResult);

  const enterResult = await bridge.callTool("press_key", {
    pid: edge.pid,
    window_id: edge.windowId,
    key: "enter",
    delivery_mode: "foreground"
  });
  throwIfToolFailed("press_key", enterResult);
  return edge;
}

async function waitForAddressBarQuery(bridge: CuaBridge, edge: EdgeWindow, query: string): Promise<string> {
  let lastUrl = "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await delay(750);
    const state = await readEdgeState(bridge, edge);
    lastUrl = addressBarValue(state);
    try {
      const parsed = new URL(lastUrl);
      if (parsed.hostname === "x.com" && parsed.pathname === "/search" && parsed.searchParams.get("q") === query) {
        return lastUrl;
      }
    } catch {
      // A barra de enderecos ainda esta mudando; tenta novamente.
    }
  }
  throw new Error(`O Edge nao confirmou a URL da consulta. URL lida: ${lastUrl || "desconhecida"}.`);
}

function timelineSection(pageText: string): string {
  const marker = pageText.match(/search timeline|linha do tempo da pesquisa|timeline de busca/i);
  return marker?.index === undefined ? "" : pageText.slice(marker.index + marker[0].length);
}

function isFinishedTimeline(pageText: string): boolean {
  if (/loading timeline|carregando (a )?(timeline|linha do tempo)/i.test(pageText)) return false;
  const timeline = timelineSection(pageText);
  if (!timeline) return false;
  const hasPost = /(^|\n)@[A-Za-z0-9_]{1,15}\b/m.test(timeline);
  const hasEmptyState = /no results|nenhum resultado|try searching for something else|tente buscar outra coisa/i.test(timeline);
  return hasPost || hasEmptyState;
}

async function waitForCurrentSearchText(
  bridge: CuaBridge,
  edge: EdgeWindow,
  query: string
): Promise<{ pageText: string; currentUrl: string }> {
  const expectedQuery = normalizeText(query);
  const currentUrl = await waitForAddressBarQuery(bridge, edge, query);
  let lastText = "";

  for (let attempt = 0; attempt < 24; attempt += 1) {
    await delay(1250);
    const pageResult = await bridge.callTool("page", {
      action: "get_text",
      pid: edge.pid,
      window_id: edge.windowId
    });
    throwIfToolFailed("page.get_text", pageResult);
    lastText = contentToText(pageResult);

    if (!normalizeText(lastText).includes(expectedQuery)) continue;
    if (isFinishedTimeline(lastText)) return { pageText: lastText, currentUrl };
  }

  throw new Error(`A URL da busca foi confirmada, mas a timeline nao terminou de carregar. URL: ${currentUrl}. Inicio do texto: ${lastText.slice(0, 240)}`);
}

const config = loadConfig();
const bridge = new CuaBridge(config);
const server = new McpServer({ name: "x-search-mcp", version: "0.1.0" });

server.registerTool(
  "list_cua_tools",
  {
    description: "Lista as ferramentas disponiveis no CUA MCP conectado ao Edge.",
    inputSchema: {}
  },
  async () => {
    try {
      const result = await bridge.listTools();
      return { content: [{ type: "text", text: jsonToolList(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
      };
    }
  }
);

server.registerTool(
  "search_x",
  {
    description: "Pesquisa no X.com usando o Microsoft Edge controlado pelo CUA e retorna o texto acessivel da pagina. Aceita operadores como from:, since:, until:, lang:, filter:links e frases entre aspas.",
    inputSchema: {
      query: z.string().min(1).describe("Termo ou consulta de busca do X"),
      live: z.boolean().default(true).describe("Usa a aba de posts mais recentes quando possivel")
    }
  },
  async ({ query, live }) => {
    const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query${live ? "&f=live" : ""}`;
    try {
      const edge = await navigateEdgeToSearch(bridge, url);
      const { pageText, currentUrl } = await waitForCurrentSearchText(bridge, edge, query);
      return {
        content: [{
          type: "text",
          text: `Consulta: ${query}\nURL solicitada: ${url}\nURL confirmada na barra do Edge: ${currentUrl}\nJanela Edge: pid=${edge.pid}, window_id=${edge.windowId}\n\nConteudo atual capturado pelo CUA page.get_text:\n${pageText.slice(0, 120_000)}`
        }]
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `${error instanceof Error ? error.message : String(error)}\n\nMantenha o Edge aberto no mesmo perfil autenticado no X.` }]
      };
    }
  }
);

const serverTransport = new StdioServerTransport();
await server.connect(serverTransport);

const shutdown = async () => {
  await bridge.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
