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

    const client = new Client({ name: "x-search-mcp", version: "2.0.0" });
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
  const edgeCandidates = windows.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const window = item as Record<string, unknown>;
    const identity = `${window.app_name ?? ""} ${window.title ?? ""}`;
    const title = String(window.title ?? "");
    return /edge|msedge/i.test(identity)
      && !/restore pages|restaurar paginas|restaurar páginas/i.test(title)
      && window.is_on_screen !== false
      && window.minimized !== true
      && window.pid
      && window.window_id;
  }) as Array<Record<string, unknown>>;
  const edge = edgeCandidates.sort((left, right) => {
    const leftBounds = left.bounds as Record<string, unknown> | undefined;
    const rightBounds = right.bounds as Record<string, unknown> | undefined;
    const leftArea = Number(leftBounds?.width ?? 0) * Number(leftBounds?.height ?? 0);
    const rightArea = Number(rightBounds?.width ?? 0) * Number(rightBounds?.height ?? 0);
    return rightArea - leftArea;
  })[0];

  if (!edge) {
    throw new Error("EDGE_NOT_OPEN: nao encontrei uma janela visivel do Microsoft Edge. Abra o Edge no mesmo perfil autenticado no X e tente novamente.");
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

async function navigateEdgeToUrl(bridge: CuaBridge, url: string): Promise<EdgeWindow> {
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

async function waitForAddressBarUrl(
  bridge: CuaBridge,
  edge: EdgeWindow,
  matches: (url: URL) => boolean,
  description: string
): Promise<string> {
  let lastUrl = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await delay(750);
    const state = await readEdgeState(bridge, edge);
    lastUrl = addressBarValue(state);
    try {
      const parsed = new URL(lastUrl);
      if (matches(parsed)) return lastUrl;
    } catch {
      // A barra de enderecos ainda esta mudando; tenta novamente.
    }
  }
  if (!lastUrl) {
    throw new Error(`EDGE_NOT_READY: o Edge foi localizado, mas a barra de enderecos ainda nao esta disponivel para ${description}. Confirme que a janela esta aberta e tente novamente.`);
  }
  throw new Error(`EDGE_NOT_READY: o Edge nao confirmou ${description}. URL lida: ${lastUrl}. Confirme que a janela esta aberta e tente novamente.`);
}

async function waitForAddressBarQuery(bridge: CuaBridge, edge: EdgeWindow, query: string): Promise<string> {
  return waitForAddressBarUrl(
    bridge,
    edge,
    (url) => url.hostname === "x.com" && url.pathname === "/search" && url.searchParams.get("q") === query,
    "a URL da consulta"
  );
}

function timelineSection(pageText: string): string {
  const marker = pageText.match(/search timeline|buscar timeline|linha do tempo da pesquisa|linha do tempo de busca|timeline de busca/i);
  return marker?.index === undefined ? "" : pageText.slice(marker.index + marker[0].length);
}

function isFinishedTimeline(pageText: string): boolean {
  if (isPageLoading(pageText)) return false;
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

function normalizeUsername(value: string): string {
  const username = value.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
    throw new Error("O username precisa ter de 1 a 15 caracteres e conter apenas letras, numeros ou underscore.");
  }
  return username;
}

function normalizeHashtag(value: string): string {
  const hashtag = value.trim().replace(/^#/, "");
  if (!/^[\p{L}\p{N}_]+$/u.test(hashtag)) {
    throw new Error("A hashtag deve conter apenas letras, numeros ou underscore.");
  }
  return `#${hashtag}`;
}

function isPageLoading(pageText: string): boolean {
  return pageText.split(/\r?\n/).some((line) =>
    /^(?:loading\b|carregando\b)/i.test(line.trim())
  );
}

async function waitForProfilePage(
  bridge: CuaBridge,
  edge: EdgeWindow,
  username: string
): Promise<{ pageText: string; currentUrl: string }> {
  const currentUrl = await waitForAddressBarUrl(
    bridge,
    edge,
    (url) => url.hostname === "x.com" && (url.pathname === `/${username}` || url.pathname.startsWith(`/${username}/`)),
    `o perfil @${username}`
  );
  let lastText = "";

  for (let attempt = 0; attempt < 24; attempt += 1) {
    await delay(1000);
    const pageResult = await bridge.callTool("page", {
      action: "get_text",
      pid: edge.pid,
      window_id: edge.windowId
    });
    throwIfToolFailed("page.get_text", pageResult);
    lastText = contentToText(pageResult);
    const normalized = normalizeText(lastText);
    if (!normalized.includes(normalizeText(username)) || isPageLoading(lastText)) continue;
    return { pageText: lastText, currentUrl };
  }

  throw new Error(`O perfil @${username} foi aberto, mas o conteúdo nao terminou de carregar. Inicio do texto: ${lastText.slice(0, 240)}`);
}

async function waitForPostPage(
  bridge: CuaBridge,
  edge: EdgeWindow
): Promise<{ pageText: string; currentUrl: string }> {
  const currentUrl = await waitForAddressBarUrl(
    bridge,
    edge,
    (url) => url.hostname === "x.com" && /\/status\/\d+/.test(url.pathname),
    "a URL do post"
  );
  let lastText = "";

  for (let attempt = 0; attempt < 24; attempt += 1) {
    await delay(1000);
    const pageResult = await bridge.callTool("page", {
      action: "get_text",
      pid: edge.pid,
      window_id: edge.windowId
    });
    throwIfToolFailed("page.get_text", pageResult);
    lastText = contentToText(pageResult);
    if (lastText.trim().length < 80 || isPageLoading(lastText)) continue;
    return { pageText: lastText, currentUrl };
  }

  throw new Error(`O post foi aberto, mas o conteúdo nao terminou de carregar. URL: ${currentUrl}. Inicio do texto: ${lastText.slice(0, 240)}`);
}

function pageResponse(
  label: string,
  requestedUrl: string,
  currentUrl: string,
  edge: EdgeWindow,
  pageText: string
) {
  return {
    content: [{
      type: "text" as const,
      text: `${label}\nURL solicitada: ${requestedUrl}\nURL confirmada na barra do Edge: ${currentUrl}\nJanela Edge: pid=${edge.pid}, window_id=${edge.windowId}\n\nConteudo atual capturado pelo CUA page.get_text:\n${pageText.slice(0, 120_000)}`
    }]
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const edgeUnavailable = /EDGE_NOT_OPEN|EDGE_NOT_READY/.test(message);
  const edgeAction = edgeUnavailable
    ? "\n\nAcao necessaria: abra o Microsoft Edge no mesmo perfil autenticado no X e repita a solicitacao."
    : "\n\nMantenha o Edge aberto no mesmo perfil autenticado no X.";
  return {
    ...(edgeUnavailable ? {} : { isError: true }),
    ...(edgeUnavailable ? {
      structuredContent: {
        status: "edge_unavailable",
        code: message.match(/^(EDGE_[A-Z_]+)/)?.[1] ?? "EDGE_UNAVAILABLE",
        retryable: true
      }
    } : {}),
    content: [{
      type: "text" as const,
      text: `${message}${edgeAction}`
    }]
  };
}

async function executeSearch(query: string, live: boolean) {
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query${live ? "&f=live" : ""}`;
  const edge = await navigateEdgeToUrl(bridge, url);
  const { pageText, currentUrl } = await waitForCurrentSearchText(bridge, edge, query);
  return pageResponse(`Consulta: ${query}`, url, currentUrl, edge, pageText);
}

const config = loadConfig();
const bridge = new CuaBridge(config);
const server = new McpServer({ name: "x-search-mcp", version: "2.0.0" });

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
    try {
      return await executeSearch(query, live);
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  "get_latest_profile_posts",
  {
    description: "Abre um perfil do X e retorna os posts mais recentes visiveis na timeline do perfil.",
    inputSchema: {
      username: z.string().min(1).describe("Username do perfil, com ou sem @")
    }
  },
  async ({ username }) => {
    try {
      const normalizedUsername = normalizeUsername(username);
      const url = `https://x.com/${normalizedUsername}`;
      const edge = await navigateEdgeToUrl(bridge, url);
      const { pageText, currentUrl } = await waitForProfilePage(bridge, edge, normalizedUsername);
      return pageResponse(`Posts recentes de @${normalizedUsername}`, url, currentUrl, edge, pageText);
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  "get_profile_info",
  {
    description: "Abre um perfil do X e retorna o texto acessivel com nome, bio, contagens e informacoes visiveis.",
    inputSchema: {
      username: z.string().min(1).describe("Username do perfil, com ou sem @")
    }
  },
  async ({ username }) => {
    try {
      const normalizedUsername = normalizeUsername(username);
      const url = `https://x.com/${normalizedUsername}`;
      const edge = await navigateEdgeToUrl(bridge, url);
      const { pageText, currentUrl } = await waitForProfilePage(bridge, edge, normalizedUsername);
      return pageResponse(`Informacoes do perfil @${normalizedUsername}`, url, currentUrl, edge, pageText);
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  "search_hashtag_top",
  {
    description: "Pesquisa uma hashtag no X e retorna os resultados mais relevantes.",
    inputSchema: {
      hashtag: z.string().min(1).describe("Hashtag com ou sem #")
    }
  },
  async ({ hashtag }) => {
    try {
      return await executeSearch(normalizeHashtag(hashtag), false);
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  "search_hashtag_latest",
  {
    description: "Pesquisa uma hashtag no X e retorna os posts mais recentes.",
    inputSchema: {
      hashtag: z.string().min(1).describe("Hashtag com ou sem #")
    }
  },
  async ({ hashtag }) => {
    try {
      return await executeSearch(normalizeHashtag(hashtag), true);
    } catch (error) {
      return toolError(error);
    }
  }
);

server.registerTool(
  "get_post_thread",
  {
    description: "Abre um post do X e retorna o texto acessivel do post e do contexto da conversa visivel.",
    inputSchema: {
      post_url: z.string().url().describe("URL completa do post no X")
    }
  },
  async ({ post_url }) => {
    try {
      const parsed = new URL(post_url);
      if (parsed.hostname !== "x.com" || !/\/status\/\d+/.test(parsed.pathname)) {
        throw new Error("post_url precisa ser uma URL de post do x.com, como https://x.com/usuario/status/123.");
      }
      const edge = await navigateEdgeToUrl(bridge, parsed.toString());
      const { pageText, currentUrl } = await waitForPostPage(bridge, edge);
      return pageResponse("Thread do post", parsed.toString(), currentUrl, edge, pageText);
    } catch (error) {
      return toolError(error);
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
