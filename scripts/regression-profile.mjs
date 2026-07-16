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

const client = new Client({ name: "x-search-profile-regression", version: "1.5.0" });
await client.connect(transport);

try {
  const result = await client.callTool({
    name: "get_latest_profile_posts",
    arguments: { username: "OpenAI" }
  });
  const output = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (result.isError) throw new Error(output);

  const marker = "Conteudo atual capturado pelo CUA page.get_text:";
  const captured = output.slice(output.indexOf(marker) + marker.length);
  if (/\bloading\b/i.test(captured)) {
    throw new Error("o perfil ainda esta carregando quando a ferramenta respondeu");
  }
  const authorCount = (captured.match(/@OpenAI\b/g) ?? []).length;
  if (authorCount < 2 || !/\b\d+[hm]\b/m.test(captured) || captured.length < 800) {
    throw new Error("a resposta nao contem a timeline carregada do perfil");
  }
  console.log("PASS get_latest_profile_posts");
} finally {
  await client.close();
}
