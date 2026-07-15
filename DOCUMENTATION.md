# Documentação do X Search MCP

## Visão geral

O `x-search-mcp` é um servidor MCP que usa o CUA Driver para controlar o Microsoft Edge e pesquisar no X.com. Ele reutiliza o perfil do Edge que já está aberto, incluindo a sessão autenticada do X.

O servidor não acessa a API do X diretamente. A busca é feita pela interface visível do Edge e o texto é lido pela árvore de acessibilidade da página.

## Requisitos

- Windows com Microsoft Edge instalado.
- CUA Driver instalado e disponível neste caminho, ou em outro caminho configurado:
  `C:\Users\User\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe`
- Edge aberto no perfil que será usado.
- Sessão do X.com autenticada, quando a conta for necessária para visualizar os resultados.
- Node.js instalado.

## Instalação

Na pasta do projeto, execute:

```powershell
npm install
npm run build
```

O comando de compilação gera `dist/index.js`. A pasta `dist/` não é versionada; ela deve ser recriada sempre que o código for instalado ou alterado.

## Configuração do CUA

O transporte padrão é `stdio`. As variáveis podem ser definidas em um arquivo `.env`:

```text
CUA_TRANSPORT=stdio
CUA_COMMAND=C:\Users\User\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe
CUA_ARGS_JSON=["mcp"]
```

Também é possível usar um CUA MCP via HTTP:

```text
CUA_TRANSPORT=http
CUA_URL=http://localhost:3000/mcp
```

Use `.env.example` como modelo. Nunca coloque senhas, cookies, tokens ou arquivos `.env` no GitHub.

## Configuração no Hermes

Depois de executar `npm run build`, adicione o servidor ao arquivo de configuração do Hermes. Substitua o caminho pelo local real do projeto:

```json
{
  "mcpServers": {
    "x-search": {
      "command": "node",
      "args": [
        "C:\\Users\\User\\Documents\\Codex\\2026-07-15\\no-m\\outputs\\x-search-mcp\\dist\\index.js"
      ],
      "env": {
        "CUA_TRANSPORT": "stdio",
        "CUA_COMMAND": "C:\\Users\\User\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe",
        "CUA_ARGS_JSON": "[\"mcp\"]"
      }
    }
  }
}
```

Depois de salvar a configuração, reinicie ou recarregue o Hermes para que ele descubra as ferramentas.

## Ferramentas disponíveis

### `list_cua_tools`

Lista as ferramentas expostas pelo CUA MCP conectado. É útil para verificar se a conexão com o CUA Driver está funcionando.

Entrada:

```json
{}
```

### `search_x`

Abre uma pesquisa no X e retorna o texto acessível da página.

Entrada:

```json
{
  "query": "from:OpenAI (model OR models)",
  "live": true
}
```

Parâmetros:

- `query`: termo ou consulta do X. Aceita operadores como `from:`, `since:`, `until:`, `lang:`, `filter:links` e frases entre aspas.
- `live`: quando `true`, acrescenta o filtro de posts mais recentes (`f=live`). O valor padrão é `true`.

Exemplos de consultas:

```text
from:OpenAI model
"frase exata"
since:2026-07-01 until:2026-07-15
lang:pt filter:links
```

## O que a resposta contém

Em caso de sucesso, `search_x` retorna:

- a consulta solicitada;
- a URL confirmada na barra do Edge;
- o identificador da janela do Edge;
- o texto capturado pelo `page.get_text` do CUA.

A ferramenta confirma que a URL contém a consulta atual e espera que a timeline deixe o estado de carregamento. Isso impede que uma busca anterior seja devolvida silenciosamente.

Se a timeline continuar em `Loading timeline`, a ferramenta retorna erro em vez de apresentar dados possivelmente antigos.

## Fluxo recomendado para o Hermes

1. Verifique se o Edge está aberto e em primeiro plano.
2. Chame `search_x` com uma consulta específica.
3. Leia os posts presentes no texto retornado.
4. Se houver erro de carregamento, aguarde alguns segundos e tente novamente.
5. Se o erro persistir, confirme que o Edge continua aberto no mesmo perfil autenticado.

O Edge precisa estar em primeiro plano porque o CUA Driver envia ações de teclado e mouse para a janela visível. A ferramenta tenta colocá-lo na frente automaticamente, mas a política de foco do Windows pode impedir essa ação em alguns casos.

## Teste de regressão

Com o Edge aberto e autenticado no X, execute:

```powershell
npm run test:sequential
```

O teste executa buscas consecutivas na mesma sessão e verifica que:

- a resposta corresponde à consulta atual;
- a resposta não está presa em `Loading timeline`;
- há posts ou um estado final indicando que não existem resultados.

## Limitações conhecidas

- O resultado depende do carregamento da interface do X e da árvore de acessibilidade do Edge.
- O MCP não armazena senhas nem contorna login, CAPTCHA ou controles do X.
- A conta do X pode alterar o conteúdo exibido, os filtros e os limites de acesso.
- Não é necessário iniciar o Edge com uma porta de debugging nem usar um perfil temporário.
- A busca retorna o texto que o CUA consegue ler; ela não garante todos os elementos visuais ou metadados internos do X.

## Segurança

O repositório é público, mas o perfil do Edge, cookies, senhas e credenciais permanecem no computador local. Não copie esses dados para o projeto. O arquivo `.gitignore` exclui `node_modules/`, `dist/`, `.env` e logs locais.
