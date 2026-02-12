import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { login, buscar_nfse, get_nfse, get_nfse_pdf, NfseListItem, NfseDetail } from '../src/nfse';

dotenv.config();

const TIMEOUT = 60_000;

let cookies: string[];

beforeAll(async () => {
  const certPassword = process.env.CERT_PASSWORD;
  const certFile = process.env.CERT_FILE;

  expect(certPassword).toBeDefined();
  expect(certFile).toBeDefined();

  const pfxPath = path.resolve(__dirname, '..', certFile!);
  expect(fs.existsSync(pfxPath)).toBe(true);

  const pfxBuffer: Buffer = fs.readFileSync(pfxPath);
  cookies = await login(pfxBuffer, certPassword!);

  expect(cookies).toBeDefined();
  expect(cookies.length).toBeGreaterThan(0);
}, TIMEOUT);

describe('Fluxo de aceitação NFSe Nacional', () => {
  let nfses: NfseListItem[];

  it('deve consultar todas as notas dos últimos 6 meses', async () => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 6);

    nfses = await buscar_nfse(cookies, startDate, endDate);

    expect(nfses).toBeDefined();
    expect(Array.isArray(nfses)).toBe(true);
    expect(nfses.length).toBeGreaterThan(0);
  }, TIMEOUT);

  it('deve ter todos os campos preenchidos em cada nota da listagem', () => {
    expect(nfses.length).toBeGreaterThan(0);

    for (const nfse of nfses) {
      expect(nfse.data).toBeTruthy();
      expect(typeof nfse.data).toBe('string');
      expect(nfse.data.trim()).not.toBe('');

      expect(nfse.emitidoPara).toBeDefined();
      expect(nfse.emitidoPara.cnpj).toBeTruthy();
      expect(nfse.emitidoPara.cnpj.trim()).not.toBe('');
      expect(nfse.emitidoPara.nome).toBeTruthy();
      expect(nfse.emitidoPara.nome.trim()).not.toBe('');

      expect(nfse.competencia).toBeTruthy();
      expect(nfse.competencia.trim()).not.toBe('');

      expect(nfse.municipioEmissor).toBeTruthy();
      expect(nfse.municipioEmissor.trim()).not.toBe('');

      expect(nfse.valor).toBeDefined();
      expect(typeof nfse.valor).toBe('number');
      expect(nfse.valor).toBeGreaterThan(0);

      expect(nfse.status).toBeTruthy();
      expect(nfse.status.trim()).not.toBe('');

      expect(nfse.chave).toBeTruthy();
      expect(nfse.chave.trim()).not.toBe('');
    }
  });

  it('deve consultar os detalhes da nota mais recente', async () => {
    expect(nfses.length).toBeGreaterThan(0);

    const notaMaisRecente: NfseListItem = nfses[0];
    const details = await get_nfse(cookies, notaMaisRecente.chave) as NfseDetail;

    expect(details).toBeDefined();

    expect(details.cabecalho).toBeDefined();
    const camposCabecalho: (keyof NfseDetail['cabecalho'])[] = [
      'municipio_emissor',
      'numero_nfse',
      'data_hora_processamento',
    ];
    for (const campo of camposCabecalho) {
      expect(details.cabecalho[campo]).toBeTruthy();
      if (typeof details.cabecalho[campo] === 'string') {
        expect((details.cabecalho[campo] as string).trim()).not.toBe('');
      }
    }

    expect(details.emitente).toBeDefined();
    expect(details.emitente.cnpj).toBeTruthy();
    expect(details.emitente.cnpj!.trim()).not.toBe('');
    expect(details.emitente.razao_social).toBeTruthy();
    expect(details.emitente.razao_social!.trim()).not.toBe('');

    expect(details.valores).toBeDefined();
    expect(details.valores.valor_liquido).toBeTruthy();

    expect(details.dps).toBeDefined();
    if ('data_emissao' in details.dps && details.dps.data_emissao) {
      expect(details.dps.data_emissao.trim()).not.toBe('');
    }
    if ('tomador' in details.dps && details.dps.tomador) {
      const tomador = details.dps.tomador;
      const temDocumento = tomador.cnpj || tomador.cpf;
      expect(temDocumento).toBeTruthy();
    }
    if ('servico' in details.dps && details.dps.servico) {
      expect(details.dps.servico.descricao).toBeTruthy();
      expect(details.dps.servico.descricao!.trim()).not.toBe('');
    }

    expect(details.xml_path).toBeTruthy();
    expect(details.xml_path.trim()).not.toBe('');
    expect(fs.existsSync(details.xml_path)).toBe(true);

    (globalThis as Record<string, unknown>).__notaRecenteChave = notaMaisRecente.chave;
    (globalThis as Record<string, unknown>).__xmlPath = details.xml_path;
  }, TIMEOUT);

  it('deve validar que o arquivo XML realmente existe no disco', () => {
    const xmlPath = (globalThis as Record<string, unknown>).__xmlPath as string;
    expect(xmlPath).toBeTruthy();
    expect(fs.existsSync(xmlPath)).toBe(true);

    const stats: fs.Stats = fs.statSync(xmlPath);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('deve baixar o PDF da nota mais recente e validar que o arquivo existe', async () => {
    const chave = (globalThis as Record<string, unknown>).__notaRecenteChave as string;
    expect(chave).toBeTruthy();

    const pdfPath: string = await get_nfse_pdf(cookies, chave);

    expect(pdfPath).toBeTruthy();
    expect(pdfPath.trim()).not.toBe('');
    expect(fs.existsSync(pdfPath)).toBe(true);

    const stats: fs.Stats = fs.statSync(pdfPath);
    expect(stats.size).toBeGreaterThan(0);

    const buffer: Buffer = Buffer.alloc(4);
    const fd: number = fs.openSync(pdfPath, 'r');
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    expect(buffer.toString()).toBe('%PDF');
  }, TIMEOUT);
});
