#!/usr/bin/env node
/**
 * MCP Server Test CLI
 * Tests MCP server registration and functionality via OpenCode
 */

import { getOpenCodeClient } from './src/opencode-client.js';
import { ConfigStore } from './src/config-store.js';

interface TestOptions {
    serverName?: string;
    testAll: boolean;
    verbose: boolean;
    listOnly: boolean;
}

class MCPTester {
    private client = getOpenCodeClient();
    private configStore = new ConfigStore();

    async run(options: TestOptions): Promise<void> {
        console.log('🧪 MCP Server Test CLI\n');

        try {
            // Start OpenCode client
            console.log('🚀 Starting OpenCode client...');
            await this.client.start();
            console.log(`✅ OpenCode client started at ${this.client.getServerUrl()}\n`);

            // Load MCP servers from config
            const mcpServers = this.configStore.getMCPServers();
            console.log(`📋 Found ${mcpServers.length} MCP server(s) in config:\n`);

            for (const server of mcpServers) {
                const status = server.enabled ? '✅' : '❌';
                console.log(`  ${status} ${server.name}`);
                console.log(`     Command: ${server.command} ${(server.args || []).join(' ')}`);
                if (server.env) {
                    console.log(`     Env: ${Object.keys(server.env).join(', ')}`);
                }
                console.log();
            }

            if (options.listOnly) {
                console.log('📋 List only mode - exiting\n');
                await this.client.stop();
                return;
            }

            // Register MCP servers
            console.log('🔧 Registering MCP servers...\n');
            await this.client.registerMcpServers(mcpServers);

            // Get status
            console.log('\n📊 MCP Server Status:');
            const status = await this.client.getMcpStatus();
            if (status) {
                console.log(JSON.stringify(status, null, 2));
            } else {
                console.log('⚠️  Could not retrieve MCP status');
            }

            // Run tests if requested
            if (options.testAll) {
                await this.testAllServers(mcpServers);
            } else if (options.serverName) {
                const server = mcpServers.find(s => s.name === options.serverName);
                if (server) {
                    await this.testServer(server);
                } else {
                    console.error(`❌ Server "${options.serverName}" not found in config`);
                }
            }

        } catch (error) {
            console.error('❌ Error:', error);
            throw error;
        } finally {
            console.log('\n🛑 Stopping OpenCode client...');
            await this.client.stop();
            console.log('✅ Cleanup complete');
        }
    }

    private async testAllServers(servers: Array<{ name: string; enabled: boolean }>): Promise<void> {
        console.log('\n🧪 Testing all enabled MCP servers...\n');

        for (const server of servers) {
            if (!server.enabled) {
                console.log(`⏭️  Skipping disabled server: ${server.name}\n`);
                continue;
            }
            await this.testServer(server);
        }
    }

    private async testServer(server: { name: string }): Promise<void> {
        console.log(`\n🧪 Testing MCP server: ${server.name}`);
        console.log('='.repeat(60));

        try {
            // Create a test session
            const sessionInfo = await this.client.createSession(
                `test-${server.name}-${Date.now()}`,
                `Test ${server.name} MCP Server`
            );

            console.log(`✅ Session created: ${sessionInfo.id}`);

            // Send a test prompt based on server type
            const testPrompt = this.getTestPrompt(server.name);
            console.log(`📤 Sending test prompt: "${testPrompt}"\n`);

            // Listen for output
            const outputHandler = (data: { sessionId: string; text: string }) => {
                if (data.sessionId === sessionInfo.id) {
                    process.stdout.write(data.text);
                }
            };

            this.client.on('output', outputHandler);

            // Send prompt and wait for response
            const result = await this.client.sendPrompt(sessionInfo.id, testPrompt);

            // Clean up listener
            this.client.off('output', outputHandler);

            // Try to fetch messages directly to see what happened
            console.log('\n\n📬 Fetching session messages...');
            try {
                const client = (this.client as any).client;
                if (client && client.session && client.session.messages) {
                    const messages = await client.session.messages({ path: { id: sessionInfo.id } });
                    const messageList = Array.isArray(messages) ? messages : (messages?.data || []);
                    console.log(`📨 Found ${messageList.length} message(s) in session`);

                    for (const msg of messageList) {
                        const msgInfo = msg.info || msg;
                        console.log(`\n  ${msgInfo.role?.toUpperCase() || 'UNKNOWN'}:`);

                        if (msg.parts) {
                            for (const part of msg.parts) {
                                if (part.type === 'text' && part.text) {
                                    const preview = part.text.substring(0, 200);
                                    console.log(`    ${preview}${part.text.length > 200 ? '...' : ''}`);
                                }
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('❌ Error fetching messages:', error);
            }

            if (result.success) {
                console.log(`\n\n✅ Test completed for ${server.name}`);
                if (result.content) {
                    console.log(`📝 Response length: ${result.content.length} characters`);
                    console.log(`📄 Response content:\n${result.content.substring(0, 500)}${result.content.length > 500 ? '...' : ''}`);
                } else {
                    console.log(`⚠️  No content returned`);
                }
            } else {
                console.log(`\n\n❌ Test failed for ${server.name}: ${result.error}`);
            }

        } catch (error) {
            console.error(`❌ Error testing ${server.name}:`, error);
        }
    }

    private getTestPrompt(serverName: string): string {
        // Server-specific test prompts - simpler prompts to ensure they work
        const prompts: Record<string, string> = {
            'playwright': 'List all the playwright tools available to you and what they do',
            'framework-learner': 'List all the learner tools available to you and what they do',
            'ddg_search': 'List all the ddg_search tools available to you',
            'default': 'What MCP tools are available to you? List all of them with their names and descriptions.'
        };

        return prompts[serverName] || prompts['default'];
    }
}

// Parse command line arguments
function parseArgs(): TestOptions {
    const args = process.argv.slice(2);

    const options: TestOptions = {
        testAll: false,
        verbose: false,
        listOnly: false
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--server':
            case '-s':
                options.serverName = args[++i];
                break;
            case '--all':
            case '-a':
                options.testAll = true;
                break;
            case '--verbose':
            case '-v':
                options.verbose = true;
                break;
            case '--list':
            case '-l':
                options.listOnly = true;
                break;
            case '--help':
            case '-h':
                console.log(`
MCP Server Test CLI

Usage: npx tsx test-mcp.ts [options]

Options:
  --list, -l              List configured MCP servers and exit
  --server, -s <name>     Test a specific MCP server by name
  --all, -a               Test all enabled MCP servers
  --verbose, -v           Verbose output
  --help, -h              Show this help message

Examples:
  # List all configured MCP servers
  npx tsx test-mcp.ts --list

  # Test a specific server
  npx tsx test-mcp.ts --server playwright

  # Test all enabled servers
  npx tsx test-mcp.ts --all

  # Verbose output while testing
  npx tsx test-mcp.ts -s framework-learner -v
                `);
                process.exit(0);
        }
    }

    return options;
}

// Main execution
async function main() {
    const options = parseArgs();
    const tester = new MCPTester();

    try {
        await tester.run(options);
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Test failed:', error);
        process.exit(1);
    }
}

main();
