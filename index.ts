#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { login, buscar_nfse, get_nfse, get_nfse_pdf } from './src/nfse';
import { ApplicationException, UnauthenticatedSessionException } from './src/exceptions';

dotenv.config();

const CERT_PASSWORD: string | undefined = process.env.CERT_PASSWORD;
const CERT_FILE: string | undefined = process.env.CERT_FILE;
const TRANSPORT: string = process.env.MCP_TRANSPORT || 'stdio';
const HOST: string = process.env.MCP_HOST || '127.0.0.1';
const PORT: number = parseInt(process.env.MCP_PORT || '3000', 10);

let cachedCookies: string[] | null = null;

async function ensureAuthenticated(): Promise<string[]> {
  if (cachedCookies) {
    return cachedCookies;
  }

  if (!CERT_PASSWORD) {
    throw new ApplicationException('CERT_PASSWORD não configurado.');
  }
  if (!CERT_FILE) {
    throw new ApplicationException('CERT_FILE não configurado.');
  }

  const pfxPath = path.resolve(__dirname, CERT_FILE);
  if (!fs.existsSync(pfxPath)) {
    throw new ApplicationException(`Certificado não encontrado em ${pfxPath}`);
  }

  const pfxBuffer: Buffer = fs.readFileSync(pfxPath);
  cachedCookies = await login(pfxBuffer, CERT_PASSWORD);

  if (cachedCookies.length === 0) {
    throw new ApplicationException('Nenhum cookie recebido após login.');
  }

  return cachedCookies;
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'mcp-nfse-nacional',
    version: '1.0.0',
  });

  server.tool(
    'nfse_login',
    'Autentica no portal NFSe Nacional usando o certificado digital configurado. Necessário antes de usar as outras ferramentas.',
    {},
    async () => {
      try {
        cachedCookies = null;
        const cookies = await ensureAuthenticated();
        return {
          content: [{
            type: 'text',
            text: `Login realizado com sucesso. ${cookies.length} cookie(s) obtido(s).`,
          }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Erro ao fazer login: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'nfse_buscar',
    'Busca notas fiscais de serviço eletrônicas (NFSe) emitidas em um período. Retorna lista com data, destinatário, valor, status e chave de cada nota.',
    {
      data_inicio: z.string().describe('Data de início no formato YYYY-MM-DD'),
      data_fim: z.string().describe('Data de fim no formato YYYY-MM-DD'),
    },
    async ({ data_inicio, data_fim }) => {
      try {
        const cookies = await ensureAuthenticated();
        const startDate = new Date(`${data_inicio}T00:00:00`);
        const endDate = new Date(`${data_fim}T23:59:59`);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
          return {
            content: [{ type: 'text', text: 'Datas inválidas. Use o formato YYYY-MM-DD.' }],
            isError: true,
          };
        }

        const nfses = await buscar_nfse(cookies, startDate, endDate);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ total: nfses.length, notas: nfses }, null, 2),
          }],
        };
      } catch (error: unknown) {
        if (error instanceof UnauthenticatedSessionException) {
          cachedCookies = null;
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Erro ao buscar NFSe: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'nfse_detalhes',
    'Obtém os detalhes completos de uma NFSe específica a partir de sua chave. Retorna dados do cabeçalho, emitente, valores, DPS e salva o XML localmente.',
    {
      chave: z.string().describe('Chave identificadora da NFSe'),
    },
    async ({ chave }) => {
      try {
        const cookies = await ensureAuthenticated();
        const details = await get_nfse(cookies, chave);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(details, null, 2),
          }],
        };
      } catch (error: unknown) {
        if (error instanceof UnauthenticatedSessionException) {
          cachedCookies = null;
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Erro ao obter detalhes da NFSe: ${message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'nfse_pdf',
    'Baixa o PDF (DANFSe) de uma NFSe específica a partir de sua chave. Retorna o caminho do arquivo PDF salvo localmente.',
    {
      chave: z.string().describe('Chave identificadora da NFSe'),
    },
    async ({ chave }) => {
      try {
        const cookies = await ensureAuthenticated();
        const pdfPath = await get_nfse_pdf(cookies, chave);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ pdf_path: pdfPath }, null, 2),
          }],
        };
      } catch (error: unknown) {
        if (error instanceof UnauthenticatedSessionException) {
          cachedCookies = null;
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Erro ao baixar PDF da NFSe: ${message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function startStreamableHttp(): Promise<void> {
  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Not found' },
        id: null,
      }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed' },
        id: null,
      }));
      return;
    }

    try {
      const body = await readBody(req);
      const parsedBody = JSON.parse(body);

      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);

      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error: unknown) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        }));
      }
    }
  });

  httpServer.listen(PORT, HOST, () => {
    console.error(`NFSe Nacional MCP Server running on Streamable HTTP at http://${HOST}:${PORT}/mcp`);
  });
}

async function startStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('NFSe Nacional MCP Server running on stdio');
}

async function main(): Promise<void> {
  if (TRANSPORT === 'streamable-http') {
    await startStreamableHttp();
  } else {
    await startStdio();
  }
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
