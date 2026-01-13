import { PlanItem } from '@claudia/shared';

/**
 * Generates a Mermaid diagram from plan items with dependencies
 */
export function generateMermaidDiagram(planItems: PlanItem[]): string {
    if (planItems.length === 0) {
        return '';
    }

    // Build node ID map for safe mermaid references
    const nodeIds = new Map<string, string>();
    planItems.forEach((item, index) => {
        nodeIds.set(item.id, `task${index + 1}`);
    });

    let diagram = 'graph TD\n';

    // Add nodes with descriptions
    planItems.forEach((item) => {
        const nodeId = nodeIds.get(item.id)!;
        // Escape special characters and limit length for readability
        const safeName = (item.name || item.description || 'Task')
            .replace(/"/g, '#quot;')
            .replace(/\[/g, '#91;')
            .replace(/\]/g, '#93;')
            .substring(0, 60);

        diagram += `    ${nodeId}["${safeName}"]\n`;
    });

    // Add edges for dependencies
    planItems.forEach((item) => {
        if (item.dependsOn && item.dependsOn.length > 0) {
            const toNodeId = nodeIds.get(item.id)!;
            item.dependsOn.forEach(depId => {
                const fromNodeId = nodeIds.get(depId);
                if (fromNodeId) {
                    diagram += `    ${fromNodeId} --> ${toNodeId}\n`;
                }
            });
        }
    });

    // If no dependencies were found, create a linear flow
    if (!planItems.some(item => item.dependsOn && item.dependsOn.length > 0)) {
        for (let i = 0; i < planItems.length - 1; i++) {
            diagram += `    task${i + 1} --> task${i + 2}\n`;
        }
    }

    return diagram;
}

/**
 * Orders plan items topologically based on dependencies
 * Returns items in execution order (dependencies first)
 */
export function orderPlanItems(planItems: PlanItem[]): PlanItem[] {
    const result: PlanItem[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const itemMap = new Map(planItems.map(item => [item.id, item]));

    function visit(itemId: string): void {
        if (visited.has(itemId)) return;

        if (visiting.has(itemId)) {
            // Circular dependency detected - skip to avoid infinite loop
            console.warn(`[PlanVisualizer] Circular dependency detected for item ${itemId}`);
            return;
        }

        const item = itemMap.get(itemId);
        if (!item) return;

        visiting.add(itemId);

        // Visit dependencies first
        if (item.dependsOn) {
            for (const depId of item.dependsOn) {
                visit(depId);
            }
        }

        visiting.delete(itemId);
        visited.add(itemId);
        result.push(item);
    }

    // Visit all items
    for (const item of planItems) {
        visit(item.id);
    }

    return result;
}

/**
 * Validates plan dependencies for circular references
 */
export function validatePlanDependencies(planItems: PlanItem[]): { valid: boolean; error?: string } {
    const itemMap = new Map(planItems.map(item => [item.id, item]));
    const visiting = new Set<string>();
    const visited = new Set<string>();

    function hasCycle(itemId: string, path: string[]): boolean {
        if (visiting.has(itemId)) {
            return true; // Cycle detected
        }
        if (visited.has(itemId)) {
            return false;
        }

        const item = itemMap.get(itemId);
        if (!item) return false;

        visiting.add(itemId);
        path.push(item.name);

        if (item.dependsOn) {
            for (const depId of item.dependsOn) {
                if (hasCycle(depId, path)) {
                    return true;
                }
            }
        }

        visiting.delete(itemId);
        visited.add(itemId);
        path.pop();
        return false;
    }

    for (const item of planItems) {
        const path: string[] = [];
        if (hasCycle(item.id, path)) {
            return {
                valid: false,
                error: `Circular dependency detected: ${path.join(' → ')}`
            };
        }
    }

    // Check for invalid dependencies (references to non-existent items)
    for (const item of planItems) {
        if (item.dependsOn) {
            for (const depId of item.dependsOn) {
                if (!itemMap.has(depId)) {
                    return {
                        valid: false,
                        error: `Task "${item.name}" depends on non-existent task ID: ${depId}`
                    };
                }
            }
        }
    }

    return { valid: true };
}
