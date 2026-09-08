import { useEffect, useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import './ConfirmModal.css';

interface ConfirmModalProps {
    title: string;
    icon?: React.ReactNode;
    children: React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'danger' | 'warning' | 'default';
    /** Block confirmation while the dialog's own selection makes it a no-op. */
    confirmDisabled?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

export function ConfirmModal({
    title,
    icon,
    children,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    variant = 'default',
    confirmDisabled = false,
    onConfirm,
    onCancel
}: ConfirmModalProps) {
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            onCancel();
        }
    }, [onCancel]);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    return (
        <div className="modal-overlay confirm-modal-overlay" onClick={onCancel}>
            <div
                className={`modal-content confirm-modal confirm-modal--${variant}`}
                onClick={e => e.stopPropagation()}
            >
                <div className="confirm-modal-header">
                    <div className={`confirm-modal-icon confirm-modal-icon--${variant}`}>
                        {icon || <AlertTriangle size={22} />}
                    </div>
                    <h2>{title}</h2>
                </div>
                <div className="confirm-modal-body">
                    {children}
                </div>
                <div className="confirm-modal-actions">
                    <button
                        className="btn-secondary"
                        onClick={onCancel}
                    >
                        {cancelLabel}
                    </button>
                    <button
                        className={`confirm-modal-btn confirm-modal-btn--${variant}`}
                        onClick={onConfirm}
                        disabled={confirmDisabled}
                        autoFocus
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
