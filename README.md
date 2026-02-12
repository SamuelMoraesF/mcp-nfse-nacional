# mcp-nfse-nacional

MCP Server para consulta de Notas Fiscais de Serviço Eletrônicas (NFSe) no portal nacional ([nfse.gov.br](https://www.nfse.gov.br)). Permite que agentes de IA autentiquem-se com certificado digital e-CNPJ/e-CPF e consultem, detalhem e baixem PDFs de NFSe emitidas.

## Ferramentas disponíveis

O servidor expõe três ferramentas via protocolo MCP:

| Ferramenta | Descrição | Parâmetros |
|---|---|---|
| `nfse_buscar` | Busca NFSe emitidas em um período. Retorna lista com data, destinatário, valor, status e chave de cada nota. | `data_inicio` (YYYY-MM-DD), `data_fim` (YYYY-MM-DD) |
| `nfse_detalhes` | Obtém os detalhes completos de uma NFSe a partir da sua chave. Retorna cabeçalho, emitente, valores, DPS e salva o XML localmente. | `chave` (string) |
| `nfse_pdf` | Baixa o PDF (DANFSe) de uma NFSe a partir da sua chave. Retorna o caminho do arquivo PDF salvo localmente. | `chave` (string) |

> A autenticação é gerenciada automaticamente. O login é realizado na primeira chamada e, caso a sessão expire (erro de autenticação), uma nova tentativa de login é feita de forma transparente.

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `CERT_FILE` | **Sim** | — | Caminho para o arquivo do certificado digital (`.pfx` / `.p12`), relativo ao diretório do projeto ou absoluto. |
| `CERT_PASSWORD` | **Sim** | — | Senha do certificado digital. |
| `MCP_TRANSPORT` | Não | `stdio` | Modo de transporte do servidor MCP. Valores aceitos: `stdio` ou `streamable-http`. |
| `MCP_HOST` | Não | `127.0.0.1` | Endereço de bind do servidor HTTP (somente no modo `streamable-http`). |
| `MCP_PORT` | Não | `3000` | Porta do servidor HTTP (somente no modo `streamable-http`). |
| `STORAGE_PATH` | Não | `./storage` | Diretório onde os XMLs e PDFs baixados serão armazenados. |

Você pode definir as variáveis em um arquivo `.env` na raiz do projeto.

## Executando via npx

### Modo stdio (padrão)

Ideal para integração direta com clientes MCP (Claude Desktop, VS Code, etc.):

```bash
CERT_FILE=./certificado.pfx CERT_PASSWORD=sua_senha npx -y mcp-nfse-nacional
```

Exemplo de configuração em um cliente MCP (`mcp.json`):

```json
{
  "servers": {
    "nfse-nacional": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-nfse-nacional"],
      "env": {
        "CERT_FILE": "/caminho/absoluto/para/certificado.pfx",
        "CERT_PASSWORD": "sua_senha"
      }
    }
  }
}
```

### Modo Streamable HTTP

Ideal para ambientes onde o servidor precisa ficar escutando conexões HTTP:

```bash
CERT_FILE=./certificado.pfx CERT_PASSWORD=sua_senha MCP_TRANSPORT=streamable-http MCP_HOST=127.0.0.1 MCP_PORT=3000 npx -y mcp-nfse-nacional
```

O endpoint MCP ficará disponível em `http://127.0.0.1:3000/mcp`.

Exemplo de configuração em um cliente MCP (`mcp.json`):

```json
{
  "servers": {
    "nfse-nacional": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

## Executando via Docker (Streamable HTTP)

### Build da imagem

```bash
docker build -t mcp-nfse-nacional .
```

### Execução

```bash
docker run -d \
  --name mcp-nfse-nacional \
  -p 3000:3000 \
  -v /caminho/para/certificado.pfx:/app/certificado.pfx:ro \
  -v /caminho/para/storage:/app/storage \
  -e CERT_FILE=certificado.pfx \
  -e CERT_PASSWORD=sua_senha \
  mcp-nfse-nacional
```

O endpoint MCP ficará disponível em `http://localhost:3000/mcp`.

> O Dockerfile já define `MCP_TRANSPORT=streamable-http`, `MCP_HOST=0.0.0.0` e `MCP_PORT=3000` por padrão.

## Segurança

> ⚠️ **O certificado digital é um ativo crítico.** Ele possui validade jurídica e representa a identidade da sua empresa ou pessoa física perante a Receita Federal e demais órgãos. Trate-o com o mesmo cuidado que trataria uma senha-mestre.

### Orientações essenciais

- **Nunca versione o certificado (`.pfx` / `.p12`) ou sua senha em repositórios Git.** Adicione `*.pfx`, `*.p12` e `.env` ao seu `.gitignore`.
- **Não exponha o servidor HTTP publicamente.** No modo `streamable-http`, o servidor não possui autenticação própria. Mantenha-o acessível apenas em `127.0.0.1` ou proteja-o com um reverse proxy autenticado (com mTLS, API key, etc.).
- **Use variáveis de ambiente ou secrets managers** para fornecer a senha do certificado. Evite passá-la como argumento de linha de comando, pois ela pode ficar visível no histórico do shell e na listagem de processos (`ps`).
- **Monte o certificado como somente leitura** no Docker (flag `:ro`), minimizando riscos de alteração acidental.
- **Restrinja permissões do arquivo do certificado** no sistema de arquivos (`chmod 400 certificado.pfx`).
- **Monitore a expiração do certificado.** Certificados digitais possuem validade (geralmente 1 a 3 anos). Tenha um processo para renovação.
- **Armazenamento local de XMLs e PDFs:** os arquivos baixados são salvos no diretório `storage/`. Garanta que esse diretório tenha permissões adequadas e que os dados fiscais sejam tratados conforme as políticas de privacidade da sua organização.
