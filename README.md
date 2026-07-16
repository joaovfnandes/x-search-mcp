# X Search MCP

Este MCP usa o CUA Driver para controlar o Microsoft Edge e pesquisar no X.com usando o mesmo perfil que já está aberto e autenticado.

## Ferramentas

- `list_cua_tools`: lista as ferramentas expostas pelo CUA conectado.
- `search_x`: abre uma busca no X e retorna o texto atual da página.
- `get_latest_profile_posts`: retorna os posts mais recentes visíveis de um perfil.
- `get_profile_info`: retorna o texto acessível com as informações visíveis de um perfil.
- `search_hashtag_top`: pesquisa uma hashtag e retorna os resultados mais relevantes.
- `search_hashtag_latest`: pesquisa uma hashtag e retorna os posts mais recentes.
- `get_post_thread`: abre um post e retorna o contexto visível da conversa.

`search_x` aceita operadores do X, por exemplo:

- `from:OpenAI model`;
- `"frase exata"`;
- `since:2026-07-01 until:2026-07-15`;
- `lang:pt filter:links`.

O parâmetro `live=true` abre a aba de posts mais recentes. Ele apenas controla o filtro da busca; não é usado como mecanismo de atualização.

## Como funciona

1. Localiza a janela aberta do Edge com `list_windows`.
2. Navega pela barra de endereços usando `get_window_state`, `click`, `set_value` e `press_key`.
3. Lê o conteúdo atual com `page(action="get_text")`.
4. Confirma que a URL e o texto retornado pertencem à consulta atual antes de responder.

Essa validação evita devolver silenciosamente o conteúdo de uma busca anterior quando a árvore de acessibilidade do X fica defasada.

## Instalação

```powershell
npm install
npm run build
```

Variáveis necessárias para o CUA via `stdio`:

```text
CUA_TRANSPORT=stdio
CUA_COMMAND=C:\Users\User\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe
CUA_ARGS_JSON=["mcp"]
```

Para CUA via HTTP:

```text
CUA_TRANSPORT=http
CUA_URL=http://localhost:3000/mcp
```

## Teste de regressão

Com o Edge aberto e autenticado no X:

```powershell
npm run test:sequential
```

O teste executa quatro pesquisas consecutivas e uma leitura de perfil na mesma sessão. Ele falha se alguma resposta contiver conteúdo defasado ou se a timeline do perfil ainda estiver carregando.

Para testar somente a timeline de um perfil:

```powershell
npm run test:profile
```

## Requisitos e limites

- O Edge precisa estar aberto no perfil desejado.
- A sessão do X precisa estar autenticada para buscas completas.
- O MCP não armazena senha e não contorna login, CAPTCHA ou controles do site.
- Não é necessário iniciar o Edge com porta de debugging nem usar perfil temporário.
