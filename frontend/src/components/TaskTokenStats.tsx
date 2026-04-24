import { useState } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { ModelTokenUsage } from '@claudia/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import './TaskTokenStats.css';

interface TaskTokenStatsProps {
    taskId: string;
}

/**
 * Format a token count into a human-readable string.
 * 0 -> "0", 1234 -> "1.2k", 45100 -> "45.1k", 1234567 -> "1.2M"
 */
export function formatTokenCount(n: number): string {
    if (n === 0) return '0';
    if (n < 1000) return n.toString();
    if (n < 1_000_000) {
        const k = n / 1000;
        return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
    }
    const m = n / 1_000_000;
    return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * Format a model identifier into a short display name.
 * "claude-sonnet-4-6" -> "Sonnet 4.6"
 */
export function formatModelName(model: string): string {
    if (!model) return 'Unknown';
    if (model === 'subagent') return 'Subagent';

    const simpleMatch = model.match(/claude-(\w+)-(\d+)-(\d+)/);
    if (simpleMatch) {
        const name = simpleMatch[1].charAt(0).toUpperCase() + simpleMatch[1].slice(1);
        return `${name} ${simpleMatch[2]}.${simpleMatch[3]}`;
    }

    const legacyMatch = model.match(/claude-(\d+)-(\d+)-(\w+)/);
    if (legacyMatch) {
        const name = legacyMatch[3].charAt(0).toUpperCase() + legacyMatch[3].slice(1);
        return `${name} ${legacyMatch[1]}.${legacyMatch[2]}`;
    }

    const shortMatch = model.match(/claude-(\d+)-(\w+)/);
    if (shortMatch) {
        const name = shortMatch[2].charAt(0).toUpperCase() + shortMatch[2].slice(1);
        return `${name} ${shortMatch[1]}`;
    }

    return model;
}

export function formatCost(cost: number): string {
    if (cost === 0) return '$0.00';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}

export function TaskTokenStats({ taskId }: TaskTokenStatsProps) {
    const task = useTaskStore(s => s.tasks.get(taskId));
    const [expanded, setExpanded] = useState(false);

    if (!task?.tokenUsage) {
        return null;
    }

    const { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalCostUsd, modelBreakdown } = task.tokenUsage;

    // Convert modelBreakdown record to array for rendering
    const models = Object.entries(modelBreakdown || {}) as [string, ModelTokenUsage][];

    // Determine primary model (highest total tokens)
    const primaryModelName = models.length > 0
        ? models.reduce((a, b) =>
            (a[1].inputTokens + a[1].outputTokens) > (b[1].inputTokens + b[1].outputTokens) ? a : b
        )[0]
        : null;

    return (
        <div className="task-token-stats">
            <button
                className="task-token-stats-bar"
                onClick={() => setExpanded(!expanded)}
                title="Click to expand token usage details"
            >
                <span className="token-stat">
                    <span className="token-value">{formatTokenCount(inputTokens)} in</span>
                    <span className="token-sep token-sep-section">|</span>
                    <span className="token-value">{formatTokenCount(outputTokens)} out</span>
                    {cacheCreationTokens > 0 && (
                        <>
                            <span className="token-sep token-sep-section">|</span>
                            <span className="token-value token-cache">{formatTokenCount(cacheCreationTokens)} cache write</span>
                        </>
                    )}
                    {cacheReadTokens > 0 && (
                        <>
                            <span className="token-sep token-sep-section">|</span>
                            <span className="token-value token-cache">{formatTokenCount(cacheReadTokens)} cache read</span>
                        </>
                    )}
                </span>
                {totalCostUsd > 0 && (
                    <>
                        <span className="token-sep token-sep-section">|</span>
                        <span className="token-cost">Cost: {formatCost(totalCostUsd)}</span>
                    </>
                )}
                {primaryModelName && (
                    <>
                        <span className="token-sep token-sep-section">|</span>
                        <span className="token-model">{formatModelName(primaryModelName)}</span>
                    </>
                )}
                <span className="token-expand-icon">
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
            </button>
            {expanded && models.length > 0 && (
                <div className="task-token-stats-detail">
                    <table className="token-breakdown-table">
                        <thead>
                            <tr>
                                <th>Model</th>
                                <th>Input</th>
                                <th>Output</th>
                                <th>Cache Write</th>
                                <th>Cache Read</th>
                                <th>Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            {models.map(([name, usage]) => (
                                <tr key={name}>
                                    <td className="model-name">{formatModelName(name)}</td>
                                    <td>{formatTokenCount(usage.inputTokens)}</td>
                                    <td>{formatTokenCount(usage.outputTokens)}</td>
                                    <td>{formatTokenCount(usage.cacheCreationTokens)}</td>
                                    <td>{formatTokenCount(usage.cacheReadTokens)}</td>
                                    <td>{formatCost(usage.costUsd)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
