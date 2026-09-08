import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { BulkDeleteModal, type BulkDeleteRequest } from '../components/BulkDeleteModal';

/**
 * Minimal render helper built on react-dom directly, matching the approach in
 * `hooks/__tests__/useTheme.test.ts` — `@testing-library/react` needs
 * `@testing-library/dom`, which this project deliberately does not install.
 */
const activeRoots = new Set<{ root: Root; container: HTMLElement }>();

function renderModal(request: BulkDeleteRequest, onResolve: (a: string[], r: string[]) => void) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root;

    act(() => {
        root = createRoot(container);
        root.render(React.createElement(BulkDeleteModal, { request, onResolve }));
    });

    const entry = { root: root!, container };
    activeRoots.add(entry);

    return {
        container,
        rerender: (next: BulkDeleteRequest) => act(() => {
            entry.root.render(React.createElement(BulkDeleteModal, { request: next, onResolve }));
        }),
    };
}

afterEach(() => {
    for (const entry of Array.from(activeRoots)) {
        act(() => { entry.root.unmount(); });
        entry.container.remove();
        activeRoots.delete(entry);
    }
});

const checkboxes = (c: HTMLElement) =>
    Array.from(c.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));

const buttonByText = (c: HTMLElement, text: string) =>
    Array.from(c.querySelectorAll('button')).find(b => b.textContent?.includes(text))!;

const click = (el: Element) => act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

const TASKS = [
    { taskId: 't1', taskName: 'PR 2930 CI failure triage' },
    { taskId: 't2', taskName: 'Audit: agent-collapse milestones' },
    { taskId: 't3', taskName: 'Plan: lemond as hub component' },
];
const request: BulkDeleteRequest = { requestId: 'del-1', tasks: TASKS };

describe('BulkDeleteModal', () => {
    it('starts with every task checked', () => {
        const { container } = renderModal(request, vi.fn());
        const boxes = checkboxes(container);
        expect(boxes).toHaveLength(3);
        expect(boxes.every(b => b.checked)).toBe(true);
        expect(container.textContent).toContain('3 of 3 selected');
    });

    it('approves everything when confirmed untouched', () => {
        const onResolve = vi.fn();
        const { container } = renderModal(request, onResolve);
        click(buttonByText(container, 'Delete 3'));
        expect(onResolve).toHaveBeenCalledWith(['t1', 't2', 't3'], []);
    });

    it('moves an unchecked task into the kept list', () => {
        const onResolve = vi.fn();
        const { container } = renderModal(request, onResolve);
        click(checkboxes(container)[1]);
        expect(container.textContent).toContain('2 of 3 selected');
        click(buttonByText(container, 'Delete 2'));
        expect(onResolve).toHaveBeenCalledWith(['t1', 't3'], ['t2']);
    });

    it('keeps every task when cancelled — never a partial delete', () => {
        const onResolve = vi.fn();
        const { container } = renderModal(request, onResolve);
        click(checkboxes(container)[0]);
        click(buttonByText(container, 'Cancel'));
        expect(onResolve).toHaveBeenCalledWith([], ['t1', 't2', 't3']);
    });

    it('disables confirm when nothing is selected', () => {
        const { container } = renderModal(request, vi.fn());
        click(buttonByText(container, 'Select none'));
        const confirm = buttonByText(container, 'Delete none') as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);
        expect(container.textContent).toContain('no task will be deleted');
    });

    it('re-checks all after Select none then Select all', () => {
        const { container } = renderModal(request, vi.fn());
        click(buttonByText(container, 'Select none'));
        click(buttonByText(container, 'Select all'));
        expect(container.textContent).toContain('3 of 3 selected');
    });

    it('does not inherit the previous request selection', () => {
        const { container, rerender } = renderModal(request, vi.fn());
        click(checkboxes(container)[0]);
        expect(container.textContent).toContain('2 of 3 selected');

        rerender({ requestId: 'del-2', tasks: TASKS });
        expect(container.textContent).toContain('3 of 3 selected');
    });

    it('uses singular wording and no bulk controls for one task', () => {
        const { container } = renderModal({ requestId: 'del-3', tasks: [TASKS[0]] }, vi.fn());
        expect(container.textContent).toContain('Delete Task');
        expect(container.textContent).toContain('this task');
        expect(buttonByText(container, 'Select all')).toBeUndefined();
    });
});
