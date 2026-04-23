import { useState, useEffect, useCallback } from 'react';
import { X, RefreshCw, DollarSign, Hash, BarChart3, Settings, ChevronDown, ChevronRight, Save } from 'lucide-react';
import { UsageDashboardData, ModelPricing, ModelTokenUsage } from '@claudia/shared';
import { getApiBaseUrl } from '../config/api-config';
import { formatTokenCount, formatModelName, formatCost } from './TaskTokenStats';
import './UsageDashboard.css';

interface PricingConfig {
    pricing: Record<string, ModelPricing>;
    enabled: boolean;
}

interface UsageDashboardProps {
    isOpen: boolean;
    onClose: () => void;
}

export function UsageDashboard({ isOpen, onClose }: UsageDashboardProps) {
    const [data, setData] = useState<UsageDashboardData | null>(null);
    const [pricingConfig, setPricingConfig] = useState<PricingConfig | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showPricing, setShowPricing] = useState(false);
    const [editedPricing, setEditedPricing] = useState<Record<string, ModelPricing>>({});
    const [savingPricing, setSavingPricing] = useState(false);

    const apiBase = getApiBaseUrl();

    const fetchDashboard = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`${apiBase}/api/usage/dashboard`);
            if (response.ok) {
                const result = await response.json();
                setData(result);
            } else {
                setError('Failed to fetch usage data');
            }
        } catch {
            setError('Failed to connect to server');
        } finally {
            setLoading(false);
        }
    }, [apiBase]);

    const fetchPricing = useCallback(async () => {
        try {
            const response = await fetch(`${apiBase}/api/usage/config`);
            if (response.ok) {
                const result: PricingConfig = await response.json();
                setPricingConfig(result);
                setEditedPricing(result.pricing);
            }
        } catch {
            console.error('[UsageDashboard] Failed to fetch pricing config');
        }
    }, [apiBase]);

    useEffect(() => {
        if (isOpen) {
            fetchDashboard();
            fetchPricing();
        }
    }, [isOpen, fetchDashboard, fetchPricing]);

    const handleSavePricing = async () => {
        setSavingPricing(true);
        try {
            const response = await fetch(`${apiBase}/api/usage/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pricing: editedPricing }),
            });
            if (response.ok) {
                fetchPricing();
                fetchDashboard();
            }
        } catch {
            console.error('[UsageDashboard] Failed to save pricing config');
        } finally {
            setSavingPricing(false);
        }
    };

    const updatePricingField = (model: string, field: keyof ModelPricing, value: string) => {
        setEditedPricing(prev => ({
            ...prev,
            [model]: { ...prev[model], [field]: parseFloat(value) || 0 },
        }));
    };

    if (!isOpen) return null;

    const workspaceEntries = data ? Object.entries(data.byWorkspace) as [string, { name: string; costUsd: number; inputTokens: number; outputTokens: number; taskCount: number }][] : [];
    const modelEntries = data ? Object.entries(data.byModel) as [string, ModelTokenUsage][] : [];
    const pricingEntries = Object.entries(editedPricing) as [string, ModelPricing][];

    return (
        <div className="usage-dashboard-overlay" onClick={onClose}>
            <div className="usage-dashboard" onClick={(e) => e.stopPropagation()}>
                <div className="usage-dashboard-header">
                    <h2>Token Usage Dashboard</h2>
                    <div className="usage-dashboard-actions">
                        <button
                            className="usage-refresh-btn"
                            onClick={fetchDashboard}
                            disabled={loading}
                            title="Refresh data"
                        >
                            <RefreshCw size={16} className={loading ? 'spinning' : ''} />
                        </button>
                        <button className="usage-close-btn" onClick={onClose} title="Close">
                            <X size={18} />
                        </button>
                    </div>
                </div>

                <div className="usage-dashboard-body">
                {error && (
                    <div className="usage-error">{error}</div>
                )}

                {loading && !data && (
                    <div className="usage-loading">
                        <RefreshCw size={24} className="spinning" />
                        <span>Loading usage data...</span>
                    </div>
                )}
                {data && (
                    <>
                        <div className="usage-summary-cards">
                            <div className="usage-card">
                                <div className="usage-card-icon">
                                    <DollarSign size={20} />
                                </div>
                                <div className="usage-card-content">
                                    <span className="usage-card-value">{formatCost(data.totalCostUsd)}</span>
                                    <span className="usage-card-label">Total Cost</span>
                                </div>
                            </div>
                            <div className="usage-card">
                                <div className="usage-card-icon input-icon">
                                    <BarChart3 size={20} />
                                </div>
                                <div className="usage-card-content">
                                    <span className="usage-card-value">{formatTokenCount(data.totalInputTokens)}</span>
                                    <span className="usage-card-label">Input Tokens</span>
                                </div>
                            </div>
                            <div className="usage-card">
                                <div className="usage-card-icon output-icon">
                                    <BarChart3 size={20} />
                                </div>
                                <div className="usage-card-content">
                                    <span className="usage-card-value">{formatTokenCount(data.totalOutputTokens)}</span>
                                    <span className="usage-card-label">Output Tokens</span>
                                </div>
                            </div>
                            <div className="usage-card">
                                <div className="usage-card-icon task-icon">
                                    <Hash size={20} />
                                </div>
                                <div className="usage-card-content">
                                    <span className="usage-card-value">{data.taskCount}</span>
                                    <span className="usage-card-label">Tasks</span>
                                </div>
                            </div>
                        </div>

                        {workspaceEntries.length > 0 && (
                            <div className="usage-section">
                                <h3 className="usage-section-title">By Workspace</h3>
                                <div className="usage-table-wrapper">
                                    <table className="usage-table">
                                        <thead>
                                            <tr>
                                                <th>Workspace</th>
                                                <th>Tasks</th>
                                                <th>Input</th>
                                                <th>Output</th>
                                                <th>Cost</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {workspaceEntries.map(([id, ws]) => (
                                                <tr key={id}>
                                                    <td className="workspace-name-cell" title={id}>
                                                        {ws.name}
                                                    </td>
                                                    <td>{ws.taskCount}</td>
                                                    <td>{formatTokenCount(ws.inputTokens)}</td>
                                                    <td>{formatTokenCount(ws.outputTokens)}</td>
                                                    <td className="cost-cell">{formatCost(ws.costUsd)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {modelEntries.length > 0 && (
                            <div className="usage-section">
                                <h3 className="usage-section-title">By Model</h3>
                                <div className="usage-table-wrapper">
                                    <table className="usage-table">
                                        <thead>
                                            <tr>
                                                <th>Model</th>
                                                <th>Tasks</th>
                                                <th>Input</th>
                                                <th>Output</th>
                                                <th>Cost</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {modelEntries.map(([model, usage]) => (
                                                <tr key={model}>
                                                    <td className="model-name-cell">{formatModelName(model)}</td>
                                                    <td>-</td>
                                                    <td>{formatTokenCount(usage.inputTokens)}</td>
                                                    <td>{formatTokenCount(usage.outputTokens)}</td>
                                                    <td className="cost-cell">{formatCost(usage.costUsd)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        <div className="usage-section">
                            <button
                                className="usage-pricing-toggle"
                                onClick={() => setShowPricing(!showPricing)}
                            >
                                <Settings size={16} />
                                <span>Pricing Configuration</span>
                                {showPricing ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            </button>

                            {showPricing && pricingConfig && (
                                <div className="usage-pricing-content">
                                    <div className="usage-pricing-table-wrapper">
                                        <table className="usage-table usage-pricing-table">
                                            <thead>
                                                <tr>
                                                    <th>Model</th>
                                                    <th>Input $/1M</th>
                                                    <th>Output $/1M</th>
                                                    <th>Cache Create $/1M</th>
                                                    <th>Cache Read $/1M</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {pricingEntries.map(([model, p]) => (
                                                    <tr key={model}>
                                                        <td className="model-name-cell">{formatModelName(model)}</td>
                                                        <td>
                                                            <input
                                                                type="number"
                                                                step="0.01"
                                                                value={p.inputPer1MTokens}
                                                                onChange={(e) => updatePricingField(model, 'inputPer1MTokens', e.target.value)}
                                                                className="pricing-input"
                                                            />
                                                        </td>
                                                        <td>
                                                            <input
                                                                type="number"
                                                                step="0.01"
                                                                value={p.outputPer1MTokens}
                                                                onChange={(e) => updatePricingField(model, 'outputPer1MTokens', e.target.value)}
                                                                className="pricing-input"
                                                            />
                                                        </td>
                                                        <td>
                                                            <input
                                                                type="number"
                                                                step="0.01"
                                                                value={p.cacheCreatePer1MTokens}
                                                                onChange={(e) => updatePricingField(model, 'cacheCreatePer1MTokens', e.target.value)}
                                                                className="pricing-input"
                                                            />
                                                        </td>
                                                        <td>
                                                            <input
                                                                type="number"
                                                                step="0.01"
                                                                value={p.cacheReadPer1MTokens}
                                                                onChange={(e) => updatePricingField(model, 'cacheReadPer1MTokens', e.target.value)}
                                                                className="pricing-input"
                                                            />
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>

                                    <div className="usage-pricing-actions">
                                        <button
                                            className="usage-save-btn"
                                            onClick={handleSavePricing}
                                            disabled={savingPricing}
                                        >
                                            <Save size={14} />
                                            {savingPricing ? 'Saving...' : 'Save Pricing'}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}

                {!loading && !error && !data && (
                    <div className="usage-empty">
                        <BarChart3 size={32} strokeWidth={1} />
                        <p>No usage data available yet.</p>
                        <p className="usage-empty-hint">Token usage will appear here once tasks start running.</p>
                    </div>
                )}
                </div>
            </div>
        </div>
    );
}
