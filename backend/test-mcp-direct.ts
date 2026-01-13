#!/usr/bin/env node
/**
 * Direct MCP Server Test - Tests MCP servers by directly checking OpenCode's /mcp endpoint
 * Bypasses AI calls to just verify MCP server registration and status
 */

import { getOpenCodeClient } from './src/opencode-client.js';
import { ConfigStore } from './src/config-store.js';

async function testMcpServers(): Promise<void> {
    console.log('🧪 Direct MCP Server Test\n');

    const client = getOpenCodeClient();
    const configStore = new ConfigStore();

    try {
        // Start OpenCode client
        console.log('🚀 Starting OpenCode client...');
        await client.start();
        const serverUrl = client.getServerUrl();
        console.log(`✅ OpenCode started at ${serverUrl}\n`);

        // Load and display configured MCP servers
        const mcpServers = configStore.getMCPServers();
        console.log(`📋 Configured MCP Servers (${mcpServers.length}):\n`);

        for (const server of mcpServers) {
            const status = server.enabled ? '✅ Enabled' : '❌ Disabled';
            console.log(`  ${server.name}`);
            console.log(`     Status: ${status}`);
            console.log(`     Command: ${server.command} ${(server.args || []).join(' ')}`);
            if (server.env) {
                console.log(`     Environment: ${Object.keys(server.env).join(', ')}`);
            }
            console.log();
        }

        // Register MCP servers
        console.log('🔧 Registering MCP servers with OpenCode...\n');

        for (const server of mcpServers) {
            if (!server.enabled) {
                console.log(`⏭️  Skipping disabled server: ${server.name}`);
                continue;
            }

            console.log(`   Registering ${server.name}...`);
            const success = await client.addMcpServer(server.name, {
                command: server.command,
                args: server.args,
                env: server.env,
                enabled: server.enabled
            });

            if (success) {
                console.log(`   ✅ ${server.name} registered successfully`);
            } else {
                console.log(`   ❌ ${server.name} registration failed`);
            }
        }

        console.log();

        // Get and display MCP status
        console.log('📊 Querying MCP server status...\n');
        const status = await client.getMcpStatus();

        if (status && Object.keys(status).length > 0) {
            console.log('MCP Server Status:');
            for (const [name, info] of Object.entries(status)) {
                const statusEmoji = info.status === 'connected' ? '✅' : '❌';
                console.log(`  ${statusEmoji} ${name}: ${info.status}`);
            }
        } else {
            console.log('⚠️  No MCP server status returned (might be empty object)');
        }

        // Try to query the OpenCode API directly for more info
        console.log('\n🔍 Querying OpenCode API directly...\n');

        if (serverUrl) {
            try {
                const response = await fetch(`${serverUrl}/mcp`);
                const data = await response.json();
                console.log('Raw MCP API Response:');
                console.log(JSON.stringify(data, null, 2));

                // Try to get tools list if available
                console.log('\n🛠️  Attempting to query available tools...\n');

                // The OpenCode API might expose tools via /tools endpoint
                try {
                    const toolsResponse = await fetch(`${serverUrl}/tools`);
                    if (toolsResponse.ok) {
                        const toolsData = await toolsResponse.json();
                        console.log('Available Tools:');
                        console.log(JSON.stringify(toolsData, null, 2));
                    } else {
                        console.log('No /tools endpoint available');
                    }
                } catch (err) {
                    console.log('Could not query /tools endpoint');
                }
            } catch (error) {
                console.error('Error querying OpenCode API:', error);
            }
        }

        console.log('\n✅ MCP server test complete!');
        console.log('\n📝 Summary:');
        console.log(`   - Total configured servers: ${mcpServers.length}`);
        console.log(`   - Enabled servers: ${mcpServers.filter(s => s.enabled).length}`);
        console.log(`   - OpenCode server: ${serverUrl}`);

    } catch (error) {
        console.error('\n❌ Test failed:', error);
        throw error;
    } finally {
        console.log('\n🛑 Stopping OpenCode client...');
        await client.stop();
        console.log('✅ Cleanup complete');
    }
}

// Main execution
async function main() {
    try {
        await testMcpServers();
        process.exit(0);
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

main();
