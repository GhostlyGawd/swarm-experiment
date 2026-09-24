import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/tier4/native-fallback-driver-v1.c', import.meta.url));
const target = fileURLToPath(new URL('../dist/tier4/native-fallback-driver-v1.c', import.meta.url));
mkdirSync(fileURLToPath(new URL('../dist/tier4/', import.meta.url)), { recursive: true });
copyFileSync(source, target);
