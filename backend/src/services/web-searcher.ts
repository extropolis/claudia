import { v4 as uuid } from 'uuid';
import { ChatMessage } from '@claudia/shared';
import { EventEmitter } from 'events';

export class WebSearcher extends EventEmitter {
    /**
     * Perform a web search and return results
     */
    async search(query: string): Promise<void> {
        console.log(`[WebSearcher] Searching for: ${query}`);

        // Notify user that search is starting
        const startMessage: ChatMessage = {
            id: uuid(),
            role: 'assistant',
            content: `🔍 Searching for: "${query}"...`,
            timestamp: new Date()
        };
        this.emit('chat', startMessage);

        try {
            // Use DuckDuckGo instant answer API (simple, no API key needed)
            const encodedQuery = encodeURIComponent(query);
            const response = await fetch(`https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`);
            const data = await response.json() as {
                AbstractText?: string;
                AbstractSource?: string;
                AbstractURL?: string;
                Heading?: string;
                RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
            };

            let resultContent = '';

            if (data.AbstractText) {
                resultContent = `📖 **${data.Heading || query}**\n\n${data.AbstractText}`;
                if (data.AbstractSource) {
                    resultContent += `\n\n*Source: ${data.AbstractSource}*`;
                }
                if (data.AbstractURL) {
                    resultContent += `\n[Read more](${data.AbstractURL})`;
                }
            } else if (data.RelatedTopics && data.RelatedTopics.length > 0) {
                resultContent = `📚 **Related topics for "${query}":**\n\n`;
                const topics = data.RelatedTopics.slice(0, 5);
                for (const topic of topics) {
                    if (topic.Text) {
                        resultContent += `• ${topic.Text}\n`;
                        if (topic.FirstURL) {
                            resultContent += `  [Link](${topic.FirstURL})\n`;
                        }
                    }
                }
            } else {
                resultContent = `🔍 No instant results found for "${query}". Try spawning a research task for more detailed information.`;
            }

            const resultMessage: ChatMessage = {
                id: uuid(),
                role: 'assistant',
                content: resultContent,
                timestamp: new Date()
            };
            this.emit('chat', resultMessage);
        } catch (error) {
            console.error('[WebSearcher] Search error:', error);
            const errorMessage: ChatMessage = {
                id: uuid(),
                role: 'assistant',
                content: `❌ Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                timestamp: new Date()
            };
            this.emit('chat', errorMessage);
        }
    }
}
