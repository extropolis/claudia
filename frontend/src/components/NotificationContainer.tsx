import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { Notification, NotificationProps, NotificationType } from './Notification';
import './NotificationContainer.css';

interface NotificationItem extends Omit<NotificationProps, 'onClose'> {
    id: string;
}

interface NotificationContextValue {
    showNotification: (
        type: NotificationType,
        title: string,
        message?: string,
        duration?: number
    ) => void;
    showSuccess: (title: string, message?: string) => void;
    showError: (title: string, message?: string) => void;
    showWarning: (title: string, message?: string) => void;
    showInfo: (title: string, message?: string) => void;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

export function useNotification() {
    const context = useContext(NotificationContext);
    if (!context) {
        throw new Error('useNotification must be used within NotificationProvider');
    }
    return context;
}

interface NotificationProviderProps {
    children: ReactNode;
}

export function NotificationProvider({ children }: NotificationProviderProps) {
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);

    const removeNotification = useCallback((id: string) => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, []);

    const showNotification = useCallback(
        (type: NotificationType, title: string, message?: string, duration = 5000) => {
            const id = `${Date.now()}-${Math.random()}`;
            const notification: NotificationItem = {
                id,
                type,
                title,
                message,
                duration,
            };

            setNotifications((prev) => [...prev, notification]);
        },
        []
    );

    const showSuccess = useCallback(
        (title: string, message?: string) => {
            showNotification('success', title, message);
        },
        [showNotification]
    );

    const showError = useCallback(
        (title: string, message?: string) => {
            showNotification('error', title, message, 7000); // Errors stay longer
        },
        [showNotification]
    );

    const showWarning = useCallback(
        (title: string, message?: string) => {
            showNotification('warning', title, message);
        },
        [showNotification]
    );

    const showInfo = useCallback(
        (title: string, message?: string) => {
            showNotification('info', title, message);
        },
        [showNotification]
    );

    return (
        <NotificationContext.Provider
            value={{
                showNotification,
                showSuccess,
                showError,
                showWarning,
                showInfo,
            }}
        >
            {children}
            <div className="notification-container">
                {notifications.map((notification) => (
                    <Notification
                        key={notification.id}
                        {...notification}
                        onClose={() => removeNotification(notification.id)}
                    />
                ))}
            </div>
        </NotificationContext.Provider>
    );
}
