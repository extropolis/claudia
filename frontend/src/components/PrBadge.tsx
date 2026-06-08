import { Check, X, Loader2 } from 'lucide-react';
import type { WorkspacePrInfo } from '@claudia/shared';

interface PrBadgeProps {
    prInfo: WorkspacePrInfo;
}

/**
 * Minimal PR badge: "#1234" tinted by PR state, with a subtle CI status mark
 * in the top-right corner. Clicking opens the PR in a new tab.
 */
export function PrBadge({ prInfo }: PrBadgeProps) {
    const { number, title, state, url, ci } = prInfo;

    const ciTitle = ci && ci !== 'none' ? ` · CI ${ci}` : '';
    const tooltip = `#${number}${title ? ` ${title}` : ''} — ${state}${ciTitle}`;

    return (
        <a
            className={`pr-badge ${state}`}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={tooltip}
            draggable={false}
            onClick={(e) => e.stopPropagation()}
        >
            #{number}
            {ci && ci !== 'none' && (
                <span className={`pr-badge-ci ${ci}`}>
                    {ci === 'passed' && <Check size={8} strokeWidth={3} />}
                    {ci === 'failed' && <X size={8} strokeWidth={3} />}
                    {ci === 'running' && <Loader2 size={8} strokeWidth={3} className="pr-badge-ci-spin" />}
                </span>
            )}
        </a>
    );
}
