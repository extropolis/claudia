import { useTaskStore } from '../stores/taskStore';
import { Check, X, ClipboardList, FlaskConical } from 'lucide-react';

interface PlanViewerProps {
    onApprove: () => void;
    onReject: () => void;
}

export function PlanViewer({ onApprove, onReject }: PlanViewerProps) {
    const { currentPlan } = useTaskStore();

    if (!currentPlan || currentPlan.status !== 'pending') {
        return null;
    }

    return (
        <div className="plan-viewer">
            <div className="plan-header">
                <ClipboardList size={20} />
                <h3>Plan Review</h3>
                <span className="plan-count">{currentPlan.items.length} task(s)</span>
            </div>

            <div className="plan-items">
                {currentPlan.items.map((item, index) => (
                    <div key={item.id} className="plan-item">
                        <div className="plan-item-number">{index + 1}</div>
                        <div className="plan-item-content">
                            <h4 className="plan-item-name">{item.name}</h4>
                            <p className="plan-item-description">{item.description}</p>
                            <div className="plan-item-testing">
                                <FlaskConical size={14} />
                                <span>{item.testingStrategy}</span>
                            </div>
                        </div>
                    </div>
                ))}
            </div>

            <div className="plan-actions">
                <button className="approve-btn" onClick={onApprove}>
                    <Check size={18} />
                    Approve & Execute
                </button>
                <button className="reject-btn" onClick={onReject}>
                    <X size={18} />
                    Reject
                </button>
            </div>
        </div>
    );
}
