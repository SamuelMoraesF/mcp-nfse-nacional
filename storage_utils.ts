import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import * as dotenv from 'dotenv';
import { ApplicationException } from './exceptions';

dotenv.config();

const STORAGE_PATH = process.env.STORAGE_PATH || path.resolve(__dirname, 'storage');

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_PATH)) {
    fs.mkdirSync(STORAGE_PATH, { recursive: true });
}

export function store_file(body: string | Buffer, ext: string): string {
    if (!ext.startsWith('.')) {
        ext = '.' + ext;
    }

    const fileName = `${uuidv4()}${ext}`;
    const filePath = path.join(STORAGE_PATH, fileName);

    try {
        fs.writeFileSync(filePath, body);
        return filePath;
    } catch (error: any) {
        throw new ApplicationException(`Falha ao salvar arquivo: ${error.message}`);
    }
}
