import axios from 'axios';
import * as cheerio from 'cheerio';
import * as https from 'https';
import { parseStringPromise } from 'xml2js';
import { ApplicationException, UnauthenticatedSessionException } from './exceptions';
import { store_file } from './storage_utils';

function formatDate(date: Date): string {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}

function checkAuthentication(response: any) {
    const responseUrl = response.request?.res?.responseUrl || '';
    if (responseUrl.includes('/EmissorNacional/Login')) {
        throw new UnauthenticatedSessionException();
    }

    const location = response.headers['location'];
    if (location && location.includes('/EmissorNacional/Login')) {
        throw new UnauthenticatedSessionException();
    }
}

export async function login(cert: Buffer, password: string): Promise<string[]> {
    const agent = new https.Agent({
        pfx: cert,
        passphrase: password,
    });

    let response;
    try {
        response = await axios.get('https://www.nfse.gov.br/EmissorNacional/Certificado', {
            httpsAgent: agent,
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
        });
    } catch (error: any) {
        console.error('Error during login:', error.message);
        throw new ApplicationException(`Falha ao realizar login: ${error.message}`);
    }

    const location = response.headers['location'];
    if (!location || !location.endsWith('/EmissorNacional/Dashboard')) {
        throw new ApplicationException('Falha ao realizar login: Redirecionamento incorreto ou ausente.');
    }

    const cookies = response.headers['set-cookie'];

    if (!cookies) {
        console.warn('Warning: No cookies received from login request.');
        return [];
    }

    return cookies;
}

export async function buscar_nfse(cookies: string[], data_inicio: Date, data_fim: Date): Promise<any[]> {
    const allNfses: any[] = [];
    let currentStart = new Date(data_inicio);
    const end = new Date(data_fim);

    const cookieHeader = cookies.join('; ');

    while (currentStart <= end) {
        let chunkEnd = new Date(currentStart);
        chunkEnd.setDate(currentStart.getDate() + 29);

        if (chunkEnd > end) {
            chunkEnd = new Date(end);
        }

        console.log(`Fetching NFSe from ${formatDate(currentStart)} to ${formatDate(chunkEnd)}...`);

        try {
            const url = 'https://www.nfse.gov.br/EmissorNacional/Notas/Emitidas';
            const params = {
                busca: '',
                datainicio: formatDate(currentStart),
                datafim: formatDate(chunkEnd)
            };

            const response = await axios.get(url, {
                headers: {
                    'Cookie': cookieHeader
                },
                params: params,
                maxRedirects: 0,
                validateStatus: (status) => status >= 200 && status < 400
            });

            checkAuthentication(response);

            const $ = cheerio.load(response.data);
            const rows = $('table tbody tr');

            rows.each((_, element) => {
                const tr = $(element);

                const downloadLink = tr.find('a[href*="/EmissorNacional/Notas/Download/NFSe/"]');
                const href = downloadLink.attr('href');

                let chave = '';
                if (href) {
                    const match = href.match(/\/EmissorNacional\/Notas\/Download\/NFSe\/(\d+)/);
                    if (match && match[1]) {
                        chave = match[1];
                    }
                }

                // Se não encontrar a chave no link, pula (pode ser linha vazia ou cabeçalho mal formatado)
                if (!chave) return;

                // Extrai dados das colunas
                const dataEmissao = tr.find('td.td-data').text().trim();

                // Extrai Emitido para (CNPJ/CPF e Nome)
                const emitidoParaDiv = tr.find('td:nth-child(2) div');
                const cnpj = emitidoParaDiv.find('.cnpj').text().trim();

                let fullText = emitidoParaDiv.text().trim();
                // Limpa quebras de linha e espaços extras
                fullText = fullText.replace(/\s+/g, ' ');

                let nome = fullText;
                if (cnpj) {
                    // Remove o CNPJ do texto para pegar apenas o nome
                    nome = fullText.replace(cnpj, '').replace(/^[\s-]+/, '').trim();
                }

                const competencia = tr.find('td.td-competencia').text().trim();
                const municipioEmissor = tr.find('td.td-center').text().trim();
                const valorStr = tr.find('td.td-valor').text().trim();
                // Converte valor para number: 15.000,00 -> 15000.00
                const valor = parseFloat(valorStr.replace(/\./g, '').replace(',', '.'));

                // Status
                const status = tr.attr('data-situacao');

                allNfses.push({
                    data: dataEmissao,
                    emitidoPara: {
                        cnpj: cnpj,
                        nome: nome
                    },
                    competencia: competencia,
                    municipioEmissor: municipioEmissor,
                    valor: valor,
                    status: status,
                    chave: chave
                });
            });

        } catch (error: any) {
            if (error instanceof UnauthenticatedSessionException) {
                throw error;
            }
            console.error(`Error fetching for period ${formatDate(currentStart)} to ${formatDate(chunkEnd)}:`, error.message);
        }

        currentStart = new Date(chunkEnd);
        currentStart.setDate(currentStart.getDate() + 1);
    }

    return allNfses;
}

function getNested(obj: any, path: string): any {
    if (!obj) return null;
    if (path === '') return obj;

    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
        if (current === null || current === undefined) return null;

        if (Array.isArray(current)) {
            current = current[0];
        }

        current = current[part];
    }

    if (Array.isArray(current)) {
        current = current[0];
    }

    return current;
}

function formatNfseResult(xmlObj: any, xmlPath: string): any {
    if (!xmlObj || !xmlObj.NFSe || !xmlObj.NFSe.infNFSe) {
        return { raw: xmlObj, xml_path: xmlPath };
    }

    const inf = getNested(xmlObj, 'NFSe.infNFSe');

    const formatted: any = {
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
        xml_path: xmlPath
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
                }
            },
            servico: {
                codigo_tributacao_nacional: getNested(dps, 'serv.cServ.cTribNac'),
                descricao: getNested(dps, 'serv.cServ.xDescServ'),
                nbs: getNested(dps, 'serv.cServ.cNBS'),
                local_prestacao: getNested(dps, 'serv.locPrest.cLocPrestacao'),
            },
            valores_dps: {
                valor_servico: getNested(dps, 'valores.vServPrest.vServ'),
            }
        };
    }

    return formatted;
}

export async function get_nfse(cookies: string[], key: string): Promise<any> {
    const cookieHeader = cookies.join('; ');
    const url = `https://www.nfse.gov.br/EmissorNacional/Notas/Download/NFSe/${key}`;

    try {
        const response = await axios.get(url, {
            headers: {
                'Cookie': cookieHeader
            },
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400
        });

        checkAuthentication(response);

        const xmlData = response.data;
        const result = await parseStringPromise(xmlData);
        const savedPath = store_file(xmlData, '.xml');
        const formatted = formatNfseResult(result, savedPath);

        return formatted;

    } catch (error: any) {
        if (error instanceof UnauthenticatedSessionException) {
            throw error;
        }
        throw new ApplicationException(`Falha ao obter NFSe ${key}: ${error.message}`);
    }
}

export async function get_nfse_pdf(cookies: string[], key: string): Promise<string> {
    const cookieHeader = cookies.join('; ');
    const url = `https://www.nfse.gov.br/EmissorNacional/Notas/Download/DANFSe/${key}`;

    try {
        const response = await axios.get(url, {
            headers: {
                'Cookie': cookieHeader
            },
            maxRedirects: 0,
            validateStatus: (status) => status >= 200 && status < 400,
            responseType: 'arraybuffer'
        });

        checkAuthentication(response);

        const pdfData = response.data;
        const savedPath = store_file(pdfData, '.pdf');

        return savedPath;

    } catch (error: any) {
        if (error instanceof UnauthenticatedSessionException) {
            throw error;
        }
        throw new ApplicationException(`Falha ao obter PDF da NFSe ${key}: ${error.message}`);
    }
}
