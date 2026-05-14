import { useState, useCallback, useRef, useEffect } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  Terminal as TerminalIcon,
  Search,
  Globe,
  Pencil,
  FileText,
  Brain,
  CheckCircle,
  Copy,
  Check,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ParsedSegment, ToolCall } from '../utils/parseToolCalls';
import './ToolWidgets.css';

// --- Individual Widget Components ---

function BashWidget({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (tool.command) {
        await navigator.clipboard.writeText(tool.command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    },
    [tool.command],
  );

  const outputLines = tool.output?.split('\n') || [];
  const isTruncated = outputLines.length > 40;
  const [showAll, setShowAll] = useState(false);
  const displayedOutput = showAll ? tool.output : outputLines.slice(0, 40).join('\n');

  return (
    <div className="tw-widget tw-bash">
      <div className="tw-header" onClick={() => setExpanded(!expanded)}>
        <span className="tw-chevron">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <TerminalIcon size={14} className="tw-tool-icon" />
        <span className="tw-label">Terminal</span>
        <code className="tw-command">{tool.command}</code>
        <button className="tw-copy-btn" onClick={handleCopy} title="Copy command">
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      {expanded && tool.output && (
        <div className="tw-body tw-code-body">
          <pre>
            <code>{displayedOutput}</code>
          </pre>
          {isTruncated && !showAll && (
            <button className="tw-show-more" onClick={() => setShowAll(true)}>
              Show all {outputLines.length} lines
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ReadWidget({ tool }: { tool: ToolCall }) {
  return (
    <div className="tw-widget tw-read">
      <div className="tw-header tw-no-expand">
        <File size={14} className="tw-tool-icon" />
        <span className="tw-label">Read</span>
        <code className="tw-filepath">{tool.filePath}</code>
      </div>
    </div>
  );
}

function WriteWidget({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const contentLines = tool.content?.split('\n') || [];
  const lineCount = contentLines.length;
  const isTruncated = lineCount > 25;
  const [showAll, setShowAll] = useState(false);
  const displayedContent = showAll ? tool.content : contentLines.slice(0, 25).join('\n');

  return (
    <div className="tw-widget tw-write">
      <div className="tw-header" onClick={() => setExpanded(!expanded)}>
        <span className="tw-chevron">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <FileText size={14} className="tw-tool-icon" />
        <span className="tw-label">Write</span>
        <code className="tw-filepath">{tool.filePath}</code>
        {lineCount > 0 && <span className="tw-meta">{lineCount} lines</span>}
      </div>
      {expanded && tool.content && (
        <div className="tw-body tw-code-body">
          <pre>
            <code>{displayedContent}</code>
          </pre>
          {isTruncated && !showAll && (
            <button className="tw-show-more" onClick={() => setShowAll(true)}>
              Show all {lineCount} lines
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EditWidget({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(true);

  const renderDiff = () => {
    if (tool.oldString || tool.newString) {
      return (
        <div className="tw-diff">
          {tool.oldString && (
            <div className="tw-diff-section">
              {tool.oldString.split('\n').map((line, i) => (
                <div key={`old-${i}`} className="tw-diff-line tw-diff-removed">
                  <span className="tw-diff-marker">-</span>
                  <span className="tw-diff-text">{line}</span>
                </div>
              ))}
            </div>
          )}
          {tool.newString && (
            <div className="tw-diff-section">
              {tool.newString.split('\n').map((line, i) => (
                <div key={`new-${i}`} className="tw-diff-line tw-diff-added">
                  <span className="tw-diff-marker">+</span>
                  <span className="tw-diff-text">{line}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
    if (tool.content) {
      return (
        <div className="tw-diff">
          {tool.content.split('\n').map((line, i) => {
            let cls = 'tw-diff-line';
            let marker = ' ';
            if (line.startsWith('+')) {
              cls += ' tw-diff-added';
              marker = '+';
            } else if (line.startsWith('-')) {
              cls += ' tw-diff-removed';
              marker = '-';
            }
            return (
              <div key={i} className={cls}>
                <span className="tw-diff-marker">{marker}</span>
                <span className="tw-diff-text">
                  {line.startsWith('+') || line.startsWith('-') ? line.slice(1) : line}
                </span>
              </div>
            );
          })}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="tw-widget tw-edit">
      <div className="tw-header" onClick={() => setExpanded(!expanded)}>
        <span className="tw-chevron">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <Pencil size={14} className="tw-tool-icon" />
        <span className="tw-label">Edit</span>
        <code className="tw-filepath">{tool.filePath}</code>
      </div>
      {expanded && <div className="tw-body tw-code-body">{renderDiff()}</div>}
    </div>
  );
}

function SearchWidget({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const isUrl = tool.type === 'fetch';

  return (
    <div className="tw-widget tw-search">
      <div className="tw-header" onClick={() => setExpanded(!expanded)}>
        <span className="tw-chevron">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        {isUrl ? (
          <Globe size={14} className="tw-tool-icon" />
        ) : (
          <Search size={14} className="tw-tool-icon" />
        )}
        <span className="tw-label">{isUrl ? 'Fetch' : 'Search'}</span>
        <span className="tw-search-query">{tool.query || tool.url}</span>
      </div>
      {expanded && tool.output && (
        <div className="tw-body tw-code-body">
          <pre>
            <code>{tool.output}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

function ThinkingWidget({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="tw-widget tw-thinking">
      <div className="tw-header" onClick={() => setExpanded(!expanded)}>
        <span className="tw-chevron">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <Brain size={14} className="tw-tool-icon" />
        <span className="tw-label">Thinking</span>
        {tool.text && (
          <span className="tw-preview">
            {tool.text.slice(0, 80)}
            {tool.text.length > 80 ? '...' : ''}
          </span>
        )}
      </div>
      {expanded && tool.text && (
        <div className="tw-body tw-thinking-body">
          <p>{tool.text}</p>
        </div>
      )}
    </div>
  );
}

function ResultWidget({ tool }: { tool: ToolCall }) {
  return (
    <div className="tw-widget tw-result">
      <div className="tw-header tw-no-expand">
        <CheckCircle size={14} className="tw-tool-icon" />
        <span className="tw-label">Done</span>
        <span className="tw-result-text">
          {tool.text?.slice(0, 120)}
          {(tool.text?.length || 0) > 120 ? '...' : ''}
        </span>
      </div>
    </div>
  );
}

function TextSegment({ text }: { text: string }) {
  if (!text.trim()) return null;

  return (
    <div className="tw-text-segment">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

// --- Main Widgets Container ---

interface ToolWidgetsProps {
  segments: ParsedSegment[];
}

export function ToolWidgets({ segments }: ToolWidgetsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevSegmentCount = useRef(segments.length);

  useEffect(() => {
    if (autoScroll && segments.length > prevSegmentCount.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    prevSegmentCount.current = segments.length;
  }, [segments.length, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(atBottom);
  }, []);

  if (segments.length === 0) {
    return (
      <div className="tw-container tw-empty" ref={containerRef}>
        <div className="tw-empty-state">
          <TerminalIcon size={28} strokeWidth={1.2} />
          <p>Waiting for output...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tw-container" ref={containerRef} onScroll={handleScroll}>
      {segments.map((segment, i) => {
        if (segment.type === 'text') {
          return <TextSegment key={`text-${i}`} text={segment.text || ''} />;
        }
        if (segment.type === 'tool' && segment.tool) {
          const tool = segment.tool;
          switch (tool.type) {
            case 'bash':
              return <BashWidget key={tool.id} tool={tool} />;
            case 'read':
              return <ReadWidget key={tool.id} tool={tool} />;
            case 'write':
              return <WriteWidget key={tool.id} tool={tool} />;
            case 'edit':
              return <EditWidget key={tool.id} tool={tool} />;
            case 'search':
            case 'fetch':
              return <SearchWidget key={tool.id} tool={tool} />;
            case 'thinking':
              return <ThinkingWidget key={tool.id} tool={tool} />;
            case 'result':
              return <ResultWidget key={tool.id} tool={tool} />;
            default:
              return null;
          }
        }
        return null;
      })}
    </div>
  );
}
