import { X, RotateCcw, Settings } from 'lucide-react';
import { getApiBaseUrl, isTunnelAccess } from '../config/api-config';
import './PreviewPanel.css';

interface PreviewPanelProps {
  workspaceName: string;
  port: number;
  onClose: () => void;
  onChangePort: () => void;
}

export function PreviewPanel({ workspaceName, port, onClose, onChangePort }: PreviewPanelProps) {
  const iframeSrc = isTunnelAccess()
    ? `${getApiBaseUrl()}/api/preview/${port}/`
    : `http://localhost:${port}/`;

  const handleRefresh = () => {
    const iframe = document.querySelector('.preview-panel-iframe') as HTMLIFrameElement;
    if (iframe) {
      iframe.src = iframeSrc;
    }
  };

  return (
    <div className="preview-panel-overlay">
      <div className="preview-panel-header">
        <div className="preview-panel-title">
          {workspaceName}
          <span className="preview-panel-port">:{port}</span>
        </div>
        <div className="preview-panel-actions">
          <button className="preview-panel-change-port" onClick={onChangePort} title="Change port">
            <Settings size={14} />
          </button>
          <button className="preview-panel-close" onClick={handleRefresh} title="Refresh">
            <RotateCcw size={18} />
          </button>
          <button className="preview-panel-close" onClick={onClose} title="Close preview">
            <X size={20} />
          </button>
        </div>
      </div>
      <iframe
        className="preview-panel-iframe"
        src={iframeSrc}
        title={`Preview: ${workspaceName}`}
      />
    </div>
  );
}
