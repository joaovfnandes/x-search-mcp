import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const cuaCommand = process.env.CUA_COMMAND || "C:/Users/User/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  cwd: projectDir,
  env: {
    ...process.env,
    CUA_TRANSPORT: "stdio",
    CUA_COMMAND: cuaCommand,
    CUA_ARGS_JSON: '["mcp"]'
  },
  stderr: "inherit"
});

const normalize = (value) => value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
const queries = [
  "anime recommendation",
  "attack on titan",
  "retro gaming notícias",
  "from:OpenAI (model OR models)"
];

const client = new Client({ name: "x-search-sequential-regression", version: "0.1.0" });
await client.connect(transport);

try {
  for (const query of queries) {
    const result = await client.callTool({ name: "search_x", arguments: { query, live: true } });
    const output = (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
    if (result.isError) throw new Error(`${query}: ${output}`);
    const marker = "Conteudo atual capturado pelo CUA page.get_text:";
    const captured = output.slice(output.indexOf(marker) + marker.length);
    if (!normalize(captured).includes(normalize(query))) {
      throw new Error(`${query}: o texto capturado nao contem a consulta atual; possivel resultado defasado.`);
    }
    if (/loading timeline|carregando (a )?(timeline|linha do tempo)/i.test(captured)) {
      throw new Error(`${query}: a ferramenta respondeu antes de a timeline terminar de carregar.`);
    }
    const hasPost = /@[A-Za-z0-9_]{1,15}\b/.test(captured);
    const hasEmptyState = /no results|nenhum resultado|try searching for something else|tente buscar outra coisa/i.test(captured);
    if (!hasPost && !hasEmptyState) {
      throw new Error(`${query}: a resposta nao contem posts nem um estado final sem resultados.`);
    }
    console.log(`PASS ${query}`);
  }

  const profileResult = await client.callTool({
    name: "get_latest_profile_posts",
    arguments: { username: "OpenAI" }
  });
  const profileOutput = (profileResult.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (profileResult.isError) throw new Error(`get_latest_profile_posts: ${profileOutput}`);
  const profileMarker = "Conteudo atual capturado pelo CUA page.get_text:";
  const profileCaptured = profileOutput.slice(profileOutput.indexOf(profileMarker) + profileMarker.length);
  if (/\bloading\b/i.test(profileCaptured)) {
    throw new Error("get_latest_profile_posts: o perfil ainda esta carregando quando a ferramenta respondeu.");
  }
  const profileAuthorCount = (profileCaptured.match(/@OpenAI\b/g) ?? []).length;
  if (profileAuthorCount < 2 || !/\b\d+[hm]\b/m.test(profileCaptured) || profileCaptured.length < 800) {
    throw new Error("get_latest_profile_posts: a resposta nao contem a timeline carregada do perfil.");
  }
  console.log("PASS get_latest_profile_posts");
} finally {
  await client.close();
}
