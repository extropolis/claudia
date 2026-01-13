import { useEffect } from 'react';
import { AlertCircle, CheckCircle, Info, XCircle, X } from 'lucide-react';
import './Notification.css';

export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export interface NotificationProps {
    type: NotificationType;
    title: string;
    message?: string;
    duration?: number;
    onClose: () => void;
}

export function Notification({ type, title, message, duration = 5000, onClose }: NotificationProps) {
    useEffect(() => {
        if (duration > 0) {
            const timer = setTimeout(() => {
                onClose();
            }, duration);

            return () => clearTimeout(timer);
        }
    }, [duration, onClose]);

    const getIcon = () => {
        switch (type) {
            case 'success':
                return <CheckCircle size={20} />;
            case 'error':
                return <XCircle size={20} />;
            case 'warning':
                return <AlertCircle size={20} />;
            case 'info':
                return <Info size={20} />;
        }
    };

    return (
        <div className={`notification notification-${type}`} role="alert">
            <div className="notification-icon">{getIcon()}</div>
            <div className="notification-content">
                <div className="notification-title">{title}</div>
                {message && <div className="notification-message">{message}</div>}
            </div>
            <button className="notification-close" onClick={onClose} aria-label="Close notification">
                <X size={16} />
            </button>
        </div>
    );
}
