import { ConversationSummary } from '@claudia/shared';
import { useTaskStore } from '../stores/taskStore';
import './ConversationPicker.css';

interface ConversationPickerProps {
    onSelect: (conversationId: string | null) => void;
}

export function ConversationPicker({ onSelect }: ConversationPickerProps) {
    const { conversationCandidates, showConversationPicker, hideConversationSelection } = useTaskStore();

    if (!showConversationPicker) return null;

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHours / 24);

        if (diffHours < 1) return 'Just now';
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        return date.toLocaleDateString();
    };

    const handleSelect = (id: string | null) => {
        hideConversationSelection();
        onSelect(id);
    };

    return (
        <div className="conversation-picker-overlay">
            <div className="conversation-picker">
                <div className="conversation-picker-header">
                    <h3>📂 Resume a Conversation</h3>
                    <p>Select a previous conversation to continue, or start fresh.</p>
                </div>

                <div className="conversation-list">
                    {conversationCandidates.map((conv: ConversationSummary) => (
                        <button
                            key={conv.id}
                            className="conversation-item"
                            onClick={() => handleSelect(conv.id)}
                        >
                            <div className="conversation-title">{conv.title}</div>
                            <div className="conversation-meta">
                                <span className="conversation-time">{formatDate(conv.updatedAt)}</span>
                                {conv.taskNames.length > 0 && (
                                    <span className="conversation-tasks">
                                        {conv.taskNames.slice(0, 2).join(', ')}
                                        {conv.taskNames.length > 2 && ` +${conv.taskNames.length - 2} more`}
                                    </span>
                                )}
                            </div>
                            {conv.lastMessage && (
                                <div className="conversation-preview">{conv.lastMessage}</div>
                            )}
                        </button>
                    ))}
                </div>

                <div className="conversation-picker-footer">
                    <button
                        className="start-new-button"
                        onClick={() => handleSelect(null)}
                    >
                        ✨ Start New Conversation
                    </button>
                </div>
            </div>
        </div>
    );
}
