#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
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

async function withAutoLogin<T>(action: (cookies: string[]) => Promise<T>): Promise<T> {
  const cookies = await ensureAuthenticated();
  try {
    return await action(cookies);
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedSessionException) {
      cachedCookies = null;
      const freshCookies = await ensureAuthenticated();
      return await action(freshCookies);
    }
    throw error;
  }
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'mcp-nfse-nacional',
    version: '1.0.0',
  });

  server.tool(
    'nfse_buscar',
    'Busca notas fiscais de serviço eletrônicas (NFSe) emitidas em um período. Retorna lista com data, destinatário, valor, status e chave de cada nota.',
    {
      data_inicio: z.string().describe('Data de início no formato YYYY-MM-DD'),
      data_fim: z.string().describe('Data de fim no formato YYYY-MM-DD'),
    },
    async ({ data_inicio, data_fim }) => {
      try {
        const startDate = new Date(`${data_inicio}T00:00:00`);
        const endDate = new Date(`${data_fim}T23:59:59`);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
          return {
            content: [{ type: 'text', text: 'Datas inválidas. Use o formato YYYY-MM-DD.' }],
            isError: true,
          };
        }

        const nfses = await withAutoLogin((cookies) => buscar_nfse(cookies, startDate, endDate));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ total: nfses.length, notas: nfses }, null, 2),
          }],
        };
      } catch (error: unknown) {
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
        const details = await withAutoLogin((cookies) => get_nfse(cookies, chave));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(details, null, 2),
          }],
        };
      } catch (error: unknown) {
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
        const pdfPath = await withAutoLogin((cookies) => get_nfse_pdf(cookies, chave));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ pdf_path: pdfPath }, null, 2),
          }],
        };
      } catch (error: unknown) {
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
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

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

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const parsedBody = JSON.parse(body);

        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          await session.transport.handleRequest(req, res, parsedBody);
        } else if (!sessionId) {
          const server = createMcpServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
          });

          await server.connect(transport);

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) {
              sessions.delete(sid);
            }
            server.close();
          };

          await transport.handleRequest(req, res, parsedBody);

          const newSessionId = transport.sessionId;
          if (newSessionId) {
            sessions.set(newSessionId, { server, transport });
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Invalid or expired session' },
            id: null,
          }));
        }
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
    } else if (req.method === 'GET') {
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid or missing session ID' },
          id: null,
        }));
        return;
      }

      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res);
    } else if (req.method === 'DELETE') {
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid or missing session ID' },
          id: null,
        }));
        return;
      }

      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res);
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed' },
        id: null,
      }));
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
