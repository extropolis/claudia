
import { createOpencodeServer } from '@opencode-ai/sdk/server'; // Try subpath import or named import
import { createOpencode } from '@opencode-ai/sdk';

console.log('Testing OpenCode SDK exports...');

async function test() {
    try {
        console.log('Imported createOpencodeServer:', typeof createOpencodeServer);
        if (typeof createOpencodeServer === 'function') {
            const server = createOpencodeServer();
            console.log('Server created:', Object.keys(server));
            if (server.listen) {
                console.log('Server has listen method');
                // await server.listen({ port: 4098 });
                // console.log('Server listening');
                // server.close();
            }
        }
    } catch (e) {
        console.error('Error with server import:', e.message);
    }
}

test();
