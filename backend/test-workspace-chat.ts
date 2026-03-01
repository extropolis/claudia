/**
 * Test script for workspace-scoped chat functionality
 * Tests: workspace selector init, workspace-scoped history, workspace-scoped messaging
 */
import WebSocket from 'ws';

const WS_URL = 'ws://localhost:4001';
const AUTH_CODE = 'asdf123';

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function test() {
    console.log('=== Workspace Chat Test ===\n');

    // Connect WebSocket
    const wsUrl = `${WS_URL}?auth=${AUTH_CODE}`;
    console.log(`[1] Connecting to ${wsUrl}...`);
    const ws = new WebSocket(wsUrl);

    const messages: any[] = [];

    ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        console.log(`  <- Received: ${msg.type}`, msg.payload ? `(keys: ${Object.keys(msg.payload).join(', ')})` : '');
    });

    await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
            console.log('  Connected!\n');
            resolve();
        });
        ws.on('error', reject);
    });

    // Wait for init message
    await sleep(500);

    // Find the init message
    const initMsg = messages.find(m => m.type === 'init');
    if (!initMsg) {
        console.error('ERROR: No init message received');
        ws.close();
        process.exit(1);
    }

    console.log('[2] Init message received');
    console.log(`  Tasks: ${initMsg.payload.tasks?.length || 0}`);
    console.log(`  Workspaces: ${initMsg.payload.workspaces?.length || 0}`);

    const workspaces = initMsg.payload.workspaces || [];
    if (workspaces.length === 0) {
        console.error('ERROR: No workspaces available');
        ws.close();
        process.exit(1);
    }

    // Print workspaces
    workspaces.forEach((w: any) => {
        console.log(`    - ${w.name} (${w.id})`);
    });

    const workspace1 = workspaces[0];
    const workspace2 = workspaces.length > 1 ? workspaces[1] : null;

    console.log(`\n[3] Testing workspace-scoped history for workspace: ${workspace1.name}`);
    messages.length = 0; // clear
    ws.send(JSON.stringify({
        type: 'supervisor:chat:history',
        payload: { workspaceId: workspace1.id }
    }));

    await sleep(500);

    const histMsg = messages.find(m => m.type === 'supervisor:chat:history');
    if (histMsg) {
        console.log(`  History messages for ${workspace1.name}: ${histMsg.payload.messages?.length || 0}`);
        console.log(`  Response workspaceId: ${histMsg.payload.workspaceId || 'none'}`);
        if (histMsg.payload.workspaceId === workspace1.id) {
            console.log('  ✓ workspaceId correctly echoed back');
        } else {
            console.log('  ✗ workspaceId mismatch!');
        }
    } else {
        console.log('  ✗ No history response received');
    }

    // Test global history (no workspace filter)
    console.log(`\n[4] Testing global history (no workspace filter)`);
    messages.length = 0;
    ws.send(JSON.stringify({
        type: 'supervisor:chat:history',
        payload: {}
    }));

    await sleep(500);

    const globalHistMsg = messages.find(m => m.type === 'supervisor:chat:history');
    if (globalHistMsg) {
        console.log(`  Global history messages: ${globalHistMsg.payload.messages?.length || 0}`);
        console.log(`  Response workspaceId: ${globalHistMsg.payload.workspaceId || 'none (global)'}`);
        if (!globalHistMsg.payload.workspaceId) {
            console.log('  ✓ No workspaceId in global history (correct)');
        }
    }

    if (workspace2) {
        console.log(`\n[5] Testing history for second workspace: ${workspace2.name}`);
        messages.length = 0;
        ws.send(JSON.stringify({
            type: 'supervisor:chat:history',
            payload: { workspaceId: workspace2.id }
        }));

        await sleep(500);

        const hist2Msg = messages.find(m => m.type === 'supervisor:chat:history');
        if (hist2Msg) {
            console.log(`  History messages for ${workspace2.name}: ${hist2Msg.payload.messages?.length || 0}`);
            if (hist2Msg.payload.workspaceId === workspace2.id) {
                console.log('  ✓ workspaceId correctly echoed back');
            }
        }
    } else {
        console.log('\n[5] Only one workspace available, skipping second workspace test');
    }

    console.log('\n[6] Testing mobile page has workspace selector HTML');
    // Fetch mobile page and check for workspace-select element
    try {
        const mobileToken = 'test-token'; // We'll check the HTML structure differently
        const response = await fetch(`http://localhost:4001/mobile?token=asdf123`);
        const html = await response.text();

        if (html.includes('workspaceSelect')) {
            console.log('  ✓ Mobile page contains workspace selector (workspaceSelect)');
        } else {
            console.log('  ✗ Mobile page does NOT contain workspace selector');
        }

        if (html.includes('workspace-bar')) {
            console.log('  ✓ Mobile page contains workspace-bar div');
        } else {
            console.log('  ✗ Mobile page does NOT contain workspace-bar');
        }

        if (html.includes('initWorkspaceSelector')) {
            console.log('  ✓ Mobile page contains initWorkspaceSelector function');
        } else {
            console.log('  ✗ Mobile page does NOT contain initWorkspaceSelector function');
        }

        if (html.includes('claudia-mobile-workspace')) {
            console.log('  ✓ Mobile page contains localStorage key for workspace persistence');
        } else {
            console.log('  ✗ Mobile page does NOT contain localStorage persistence');
        }
    } catch (e: any) {
        console.log(`  Could not fetch mobile page: ${e.message}`);
    }

    console.log('\n=== All tests complete ===');
    ws.close();
    process.exit(0);
}

test().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
