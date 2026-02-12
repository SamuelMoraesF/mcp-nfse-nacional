import axios, { AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import * as https from 'https';
import { parseStringPromise } from 'xml2js';
import { ApplicationException, UnauthenticatedSessionException } from './exceptions';
import { store_file } from './storage_utils';

export interface EmitidoPara {
  cnpj: string;
  nome: string;
}

export interface NfseListItem {
  data: string;
  emitidoPara: EmitidoPara;
  competencia: string;
  municipioEmissor: string;
  valor: number;
  status: string;
  chave: string;
}

export interface Endereco {
  logradouro: string | null;
  numero: string | null;
  bairro: string | null;
  codigo_municipio: string | null;
  uf?: string | null;
  cep: string | null;
}

export interface Emitente {
  cnpj: string | null;
  inscricao_municipal: string | null;
  razao_social: string | null;
  endereco: Endereco;
  telefone: string | null;
  email: string | null;
}

export interface Cabecalho {
  id: string | null;
  municipio_emissor: string | null;
  municipio_prestacao: string | null;
  numero_nfse: string | null;
  codigo_municipio_incidencia: string | null;
  municipio_incidencia: string | null;
  tributacao_nacional: string | null;
  nbs: string | null;
  versao_aplicativo: string | null;
  ambiente_gerador: string | null;
  tipo_emissao: string | null;
  processo_emissao: string | null;
  status_emissao: string | null;
  data_hora_processamento: string | null;
  numero_documento_municipal: string | null;
}

export interface Valores {
  base_calculo: string | null;
  aliquota: string | null;
  issqn: string | null;
  total_retencoes: string | null;
  valor_liquido: string | null;
  valor_deducao: string | null;
}

export interface Prestador {
  cnpj: string | null;
  inscricao_municipal: string | null;
}

export interface Tomador {
  cnpj: string | null;
  cpf: string | null;
  razao_social: string | null;
  endereco: Omit<Endereco, 'uf'>;
}

export interface Servico {
  codigo_tributacao_nacional: string | null;
  descricao: string | null;
  nbs: string | null;
  local_prestacao: string | null;
}

export interface ValoresDps {
  valor_servico: string | null;
}

export interface Dps {
  id: string | null;
  tipo_ambiente: string | null;
  data_emissao: string | null;
  numero_dps: string | null;
  serie: string | null;
  competencia: string | null;
  tipo_emitente: string | null;
  local_emissao: string | null;
  prestador: Prestador;
  tomador: Tomador;
  servico: Servico;
  valores_dps: ValoresDps;
}

export interface NfseDetail {
  cabecalho: Cabecalho;
  emitente: Emitente;
  valores: Valores;
  dps: Dps | Record<string, never>;
  xml_path: string;
}

export interface NfseRawDetail {
  raw: unknown;
  xml_path: string;
}

function formatDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function checkAuthentication(response: AxiosResponse): void {
  const responseUrl: string = response.request?.res?.responseUrl || '';
  if (responseUrl.includes('/EmissorNacional/Login')) {
    throw new UnauthenticatedSessionException();
  }

  const location = response.headers['location'] as string | undefined;
  if (location && location.includes('/EmissorNacional/Login')) {
    throw new UnauthenticatedSessionException();
  }
}

export async function login(cert: Buffer, password: string): Promise<string[]> {
  const agent = new https.Agent({
    pfx: cert,
    passphrase: password,
  });

  let response: AxiosResponse;
  try {
    response = await axios.get('https://www.nfse.gov.br/EmissorNacional/Certificado', {
      httpsAgent: agent,
      maxRedirects: 0,
      validateStatus: (status: number) => status >= 200 && status < 400,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApplicationException(`Falha ao realizar login: ${message}`);
  }

  const location = response.headers['location'] as string | undefined;
  if (!location || !location.endsWith('/EmissorNacional/Dashboard')) {
    throw new ApplicationException('Falha ao realizar login: Redirecionamento incorreto ou ausente.');
  }

  const cookies = response.headers['set-cookie'];
  if (!cookies) {
    return [];
  }

  return cookies;
}

export async function buscar_nfse(
  cookies: string[],
  data_inicio: Date,
  data_fim: Date
): Promise<NfseListItem[]> {
  const allNfses: NfseListItem[] = [];
  let currentStart = new Date(data_inicio);
  const end = new Date(data_fim);
  const cookieHeader = cookies.join('; ');

  while (currentStart <= end) {
    let chunkEnd = new Date(currentStart);
    chunkEnd.setDate(currentStart.getDate() + 29);

    if (chunkEnd > end) {
      chunkEnd = new Date(end);
    }

    try {
      const url = 'https://www.nfse.gov.br/EmissorNacional/Notas/Emitidas';
      const params = {
        busca: '',
        datainicio: formatDate(currentStart),
        datafim: formatDate(chunkEnd),
      };

      const response = await axios.get(url, {
        headers: { Cookie: cookieHeader },
        params,
        maxRedirects: 0,
        validateStatus: (status: number) => status >= 200 && status < 400,
      });

      checkAuthentication(response);

      const $ = cheerio.load(response.data as string);
      const rows = $('table tbody tr');

      rows.each((_: number, element: cheerio.Element) => {
        const tr = $(element);

        const downloadLink = tr.find('a[href*="/EmissorNacional/Notas/Download/NFSe/"]');
        const href = downloadLink.attr('href');

        let chave = '';
        if (href) {
          const match = href.match(/\/EmissorNacional\/Notas\/Download\/NFSe\/(\d+)/);
          if (match?.[1]) {
            chave = match[1];
          }
        }

        if (!chave) return;

        const dataEmissao = tr.find('td.td-data').text().trim();
        const emitidoParaDiv = tr.find('td:nth-child(2) div');
        const cnpj = emitidoParaDiv.find('.cnpj').text().trim();

        let fullText = emitidoParaDiv.text().trim().replace(/\s+/g, ' ');
        let nome = fullText;
        if (cnpj) {
          nome = fullText.replace(cnpj, '').replace(/^[\s-]+/, '').trim();
        }

        const competencia = tr.find('td.td-competencia').text().trim();
        const municipioEmissor = tr.find('td.td-center').text().trim();
        const valorStr = tr.find('td.td-valor').text().trim();
        const valor = parseFloat(valorStr.replace(/\./g, '').replace(',', '.'));
        const status = tr.attr('data-situacao') || '';

        allNfses.push({
          data: dataEmissao,
          emitidoPara: { cnpj, nome },
          competencia,
          municipioEmissor,
          valor,
          status,
          chave,
        });
      });
    } catch (error: unknown) {
      if (error instanceof UnauthenticatedSessionException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Error fetching for period ${formatDate(currentStart)} to ${formatDate(chunkEnd)}: ${message}`
      );
    }

    currentStart = new Date(chunkEnd);
    currentStart.setDate(currentStart.getDate() + 1);
  }

  return allNfses;
}

function getNested(obj: unknown, path: string): string | null {
  if (!obj) return null;
  if (path === '') return obj as string;

  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return null;

    if (Array.isArray(current)) {
      current = current[0];
    }

    current = (current as Record<string, unknown>)[part];
  }

  if (Array.isArray(current)) {
    current = current[0];
  }

  return (current as string) ?? null;
}

function formatNfseResult(
  xmlObj: Record<string, unknown>,
  xmlPath: string
): NfseDetail | NfseRawDetail {
  const nfseObj = xmlObj as { NFSe?: { infNFSe?: unknown } };
  if (!nfseObj?.NFSe?.infNFSe) {
    return { raw: xmlObj, xml_path: xmlPath };
  }

  const inf = getNested(xmlObj as unknown, 'NFSe.infNFSe');

  const formatted: NfseDetail = {
    cabecalho: {
      id: getNested(inf, '$.Id'),
      municipio_emissor: getNested(inf, 'xLocEmi'),
      municipio_prestacao: getNested(inf, 'xLocPrestacao'),
      numero_nfse: getNested(inf, 'nNFSe'),
      codigo_municipio_incidencia: getNested(inf, 'cLocIncid'),
      municipio_incidencia: getNested(inf, 'xLocIncid'),
      tributacao_nacional: getNested(inf, 'xTribNac'),
      nbs: getNested(inf, 'xNBS'),
      versao_aplicativo: getNested(inf, 'verAplic'),
      ambiente_gerador: getNested(inf, 'ambGer'),
      tipo_emissao: getNested(inf, 'tpEmis'),
      processo_emissao: getNested(inf, 'procEmi'),
      status_emissao: getNested(inf, 'cStat'),
      data_hora_processamento: getNested(inf, 'dhProc'),
      numero_documento_municipal: getNested(inf, 'nDFSe'),
    },
    emitente: {
      cnpj: getNested(inf, 'emit.CNPJ'),
      inscricao_municipal: getNested(inf, 'emit.IM'),
      razao_social: getNested(inf, 'emit.xNome'),
      endereco: {
        logradouro: getNested(inf, 'emit.enderNac.xLgr'),
        numero: getNested(inf, 'emit.enderNac.nro'),
        bairro: getNested(inf, 'emit.enderNac.xBairro'),
        codigo_municipio: getNested(inf, 'emit.enderNac.cMun'),
        uf: getNested(inf, 'emit.enderNac.UF'),
        cep: getNested(inf, 'emit.enderNac.CEP'),
      },
      telefone: getNested(inf, 'emit.fone'),
      email: getNested(inf, 'emit.email'),
    },
    valores: {
      base_calculo: getNested(inf, 'valores.vBC'),
      aliquota: getNested(inf, 'valores.pAliqAplic'),
      issqn: getNested(inf, 'valores.vISSQN'),
      total_retencoes: getNested(inf, 'valores.vTotalRet'),
      valor_liquido: getNested(inf, 'valores.vLiq'),
      valor_deducao: getNested(inf, 'valores.vCalcDR'),
    },
    dps: {},
    xml_path: xmlPath,
  };

  const dps = getNested(inf, 'DPS.infDPS');
  if (dps) {
    formatted.dps = {
      id: getNested(dps, '$.Id'),
      tipo_ambiente: getNested(dps, 'tpAmb'),
      data_emissao: getNested(dps, 'dhEmi'),
      numero_dps: getNested(dps, 'nDPS'),
      serie: getNested(dps, 'serie'),
      competencia: getNested(dps, 'dCompet'),
      tipo_emitente: getNested(dps, 'tpEmit'),
      local_emissao: getNested(dps, 'cLocEmi'),
      prestador: {
        cnpj: getNested(dps, 'prest.CNPJ'),
        inscricao_municipal: getNested(dps, 'prest.IM'),
      },
      tomador: {
        cnpj: getNested(dps, 'toma.CNPJ'),
        cpf: getNested(dps, 'toma.CPF'),
        razao_social: getNested(dps, 'toma.xNome'),
        endereco: {
          logradouro: getNested(dps, 'toma.end.xLgr'),
          numero: getNested(dps, 'toma.end.nro'),
          bairro: getNested(dps, 'toma.end.xBairro'),
          codigo_municipio: getNested(dps, 'toma.end.endNac.cMun'),
          cep: getNested(dps, 'toma.end.endNac.CEP'),
        },
      },
      servico: {
        codigo_tributacao_nacional: getNested(dps, 'serv.cServ.cTribNac'),
        descricao: getNested(dps, 'serv.cServ.xDescServ'),
        nbs: getNested(dps, 'serv.cServ.cNBS'),
        local_prestacao: getNested(dps, 'serv.locPrest.cLocPrestacao'),
      },
      valores_dps: {
        valor_servico: getNested(dps, 'valores.vServPrest.vServ'),
      },
    };
  }

  return formatted;
}

export async function get_nfse(
  cookies: string[],
  key: string
): Promise<NfseDetail | NfseRawDetail> {
  const cookieHeader = cookies.join('; ');
  const url = `https://www.nfse.gov.br/EmissorNacional/Notas/Download/NFSe/${key}`;

  try {
    const response = await axios.get(url, {
      headers: { Cookie: cookieHeader },
      maxRedirects: 0,
      validateStatus: (status: number) => status >= 200 && status < 400,
    });

    checkAuthentication(response);

    const xmlData = response.data as string;
    const result = await parseStringPromise(xmlData);
    const savedPath = store_file(xmlData, '.xml');

    return formatNfseResult(result as Record<string, unknown>, savedPath);
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedSessionException) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ApplicationException(`Falha ao obter NFSe ${key}: ${message}`);
  }
}

export async function get_nfse_pdf(cookies: string[], key: string): Promise<string> {
  const cookieHeader = cookies.join('; ');
  const url = `https://www.nfse.gov.br/EmissorNacional/Notas/Download/DANFSe/${key}`;

  try {
    const response = await axios.get(url, {
      headers: { Cookie: cookieHeader },
      maxRedirects: 0,
      validateStatus: (status: number) => status >= 200 && status < 400,
      responseType: 'arraybuffer',
    });

    checkAuthentication(response);

    const pdfData = response.data as Buffer;
    return store_file(pdfData, '.pdf');
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedSessionException) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ApplicationException(`Falha ao obter PDF da NFSe ${key}: ${message}`);
  }
}
