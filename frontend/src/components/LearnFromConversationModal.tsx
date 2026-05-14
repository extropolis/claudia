import { useState, useEffect } from 'react';
import {
  BookOpen,
  Loader2,
  Check,
  X,
  RefreshCw,
  AlertCircle,
  Square,
  CheckSquare,
  Brain,
} from 'lucide-react';
import { getApiBaseUrl } from '../config/api-config';
import './LearnFromConversationModal.css';

interface LearnFromConversationModalProps {
  taskId: string;
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
  onSaved?: (count: number) => void;
}

interface Suggestion {
  id: string;
  description: string;
  promptAddition: string;
}

interface LearningAnalysis {
  suggestions: Suggestion[];
  reasoning: string;
}

export function LearnFromConversationModal({
  taskId,
  workspaceId,
  workspaceName,
  onClose,
  onSaved,
}: LearnFromConversationModalProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<LearningAnalysis | null>(null);
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set());

  useEffect(() => {
    analyzeConversation();
  }, [taskId]);

  const analyzeConversation = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`${getApiBaseUrl()}/api/tasks/${taskId}/learn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to analyze conversation');
      }

      const data: LearningAnalysis = await response.json();
      setAnalysis(data);
      // Select all suggestions by default
      setSelectedSuggestions(new Set(data.suggestions.map((s) => s.id)));
    } catch (err) {
      console.error('Failed to analyze conversation:', err);
      setError(err instanceof Error ? err.message : 'Failed to analyze conversation');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleSuggestion = (id: string) => {
    setSelectedSuggestions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (analysis) {
      setSelectedSuggestions(new Set(analysis.suggestions.map((s) => s.id)));
    }
  };

  const selectNone = () => {
    setSelectedSuggestions(new Set());
  };

  const handleSave = async () => {
    if (!analysis || selectedSuggestions.size === 0) return;

    setIsSaving(true);
    setError(null);

    try {
      // Convert suggestions to learnings format
      const learnings = analysis.suggestions
        .filter((s) => selectedSuggestions.has(s.id))
        .map((s) => ({
          title: s.description,
          content: s.promptAddition,
        }));

      const response = await fetch(`${getApiBaseUrl()}/api/tasks/${taskId}/learn/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          learnings,
          workspaceId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to save learnings');
      }

      const result = await response.json();
      console.log('Saved learnings:', result.saved?.length || 0);

      if (onSaved) {
        onSaved(result.saved?.length || learnings.length);
      }
      onClose();
    } catch (err) {
      console.error('Failed to save learnings:', err);
      setError(err instanceof Error ? err.message : 'Failed to save learnings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  const hasChanges = selectedSuggestions.size > 0;

  return (
    <div className="learn-modal-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="learn-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <Brain size={20} />
          <h2>Learn from Conversation</h2>
          <button className="modal-close-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <p className="modal-description">
          Extract learnings from this conversation for <strong>{workspaceName}</strong>. These will
          be used to improve future task assistance via semantic search.
        </p>

        {isLoading && (
          <div className="learn-loading">
            <Loader2 className="spinning" size={24} />
            <span>Analyzing conversation...</span>
          </div>
        )}

        {error && (
          <div className="learn-error">
            <AlertCircle size={20} />
            <span>{error}</span>
            <button onClick={analyzeConversation} className="retry-btn">
              <RefreshCw size={14} />
              Retry
            </button>
          </div>
        )}

        {analysis && !isLoading && (
          <>
            {/* Reasoning section */}
            <div className="learn-section">
              <h3>Analysis</h3>
              <p className="learn-reasoning">{analysis.reasoning}</p>
            </div>

            {/* Suggestions with checkboxes */}
            {analysis.suggestions.length > 0 && (
              <div className="learn-section">
                <div className="learn-section-header">
                  <h3>Learnings to Save</h3>
                  <div className="select-actions">
                    <button
                      className="select-action-btn"
                      onClick={selectAll}
                      disabled={selectedSuggestions.size === analysis.suggestions.length}
                    >
                      Select All
                    </button>
                    <button
                      className="select-action-btn"
                      onClick={selectNone}
                      disabled={selectedSuggestions.size === 0}
                    >
                      Select None
                    </button>
                  </div>
                </div>
                <div className="suggestion-list">
                  {analysis.suggestions.map((suggestion) => (
                    <div
                      key={suggestion.id}
                      className={`suggestion-item ${selectedSuggestions.has(suggestion.id) ? 'selected' : ''}`}
                      onClick={() => toggleSuggestion(suggestion.id)}
                    >
                      <div className="suggestion-checkbox">
                        {selectedSuggestions.has(suggestion.id) ? (
                          <CheckSquare size={18} className="checkbox-checked" />
                        ) : (
                          <Square size={18} className="checkbox-unchecked" />
                        )}
                      </div>
                      <div className="suggestion-content">
                        <div className="suggestion-description">{suggestion.description}</div>
                        <div className="suggestion-addition">{suggestion.promptAddition}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="learn-info">
              <BookOpen size={14} />
              <span>
                Selected learnings will be stored with embeddings for semantic retrieval. When "Use
                Learnings" is enabled in settings, relevant learnings will be automatically injected
                into new task contexts.
              </span>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSave}
                disabled={!hasChanges || isSaving}
              >
                {isSaving ? (
                  <>
                    <Loader2 size={14} className="spinning" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Check size={14} />
                    Save {selectedSuggestions.size} Learning
                    {selectedSuggestions.size !== 1 ? 's' : ''}
                  </>
                )}
              </button>
            </div>
          </>
        )}

        {analysis && analysis.suggestions.length === 0 && !isLoading && (
          <div className="learn-empty">
            <p>
              No learnings found. The conversation didn't reveal any clear patterns worth
              remembering.
            </p>
          </div>
        )}

        {!analysis && !isLoading && !error && (
          <div className="learn-empty">
            <p>No conversation data available for analysis.</p>
          </div>
        )}
      </div>
    </div>
  );
}
