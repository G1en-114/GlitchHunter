import { serveDirectory } from '../src/server.mjs';
const server = await serveDirectory(new URL('../third_party/2048', import.meta.url).pathname, 4173);
console.log(`2048: ${server.url}`);
process.on('SIGINT', async () => { await server.close(); process.exit(); });
