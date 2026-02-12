import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { login, buscar_nfse, get_nfse, get_nfse_pdf, NfseListItem, NfseDetail } from './src/nfse';
import { UnauthenticatedSessionException } from './src/exceptions';

dotenv.config();

async function main(): Promise<void> {
  const certPassword = process.env.CERT_PASSWORD;
  const certFile = process.env.CERT_FILE;

  if (!certPassword) {
    console.error('Error: CERT_PASSWORD not found in .env');
    process.exit(1);
  }

  if (!certFile) {
    console.error('Error: CERT_FILE not found in .env');
    process.exit(1);
  }

  const pfxPath = path.resolve(__dirname, certFile);

  if (!fs.existsSync(pfxPath)) {
    console.error(`Error: Certificate file not found at ${pfxPath}`);
    process.exit(1);
  }

  const pfxBuffer: Buffer = fs.readFileSync(pfxPath);

  console.log('Authenticating...');
  try {
    const cookies: string[] = await login(pfxBuffer, certPassword);
    console.log('Logged in. Cookies:', cookies);

    if (cookies.length === 0) {
      console.warn('Warning: No cookies received. Subsequent requests might fail.');
    }

    const startDate = new Date('2026-02-01T00:00:00');
    const endDate = new Date('2026-02-10T23:59:59');

    console.log('Searching NFSe...');
    const nfses: NfseListItem[] = await buscar_nfse(cookies, startDate, endDate);

    console.log('Found NFSe(s):');
    nfses.forEach((n: NfseListItem) =>
      console.log(`- Data: ${n.data}, Para: ${n.emitidoPara.nome} (${n.emitidoPara.cnpj}), Valor: ${n.valor}, Chave: ${n.chave}`)
    );
    console.log(`Total Found: ${nfses.length}`);

    for (const nfse of nfses) {
      const key: string = nfse.chave;
      console.log(`Processing key: ${key}...`);
      try {
        console.log(`Downloading NFSe details for key: ${key}...`);
        const details = await get_nfse(cookies, key) as NfseDetail;
        console.log(`XML saved at: ${details.xml_path}`);

        console.log(`Downloading PDF for key: ${key}...`);
        const pdfPath: string = await get_nfse_pdf(cookies, key);
        console.log(`PDF saved at: ${pdfPath}`);
      } catch (err: unknown) {
        if (err instanceof UnauthenticatedSessionException) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error processing details for ${key}: ${message}`);
      }
    }
  } catch (error: unknown) {
    if (error instanceof UnauthenticatedSessionException) {
      console.error('Session expired or unauthenticated. Please login again.');
    } else if (error instanceof Error) {
      console.error('An error occurred:', error.message);
    } else {
      console.error('An error occurred:', String(error));
    }
  }
}

main();
