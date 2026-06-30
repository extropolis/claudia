/**
 * MarkdownRenderer — react-markdown wrapper used for assistant text,
 * user text, thinking blocks, and any payload that's already markdown.
 *
 * Adds:
 *   - GitHub-flavored markdown via remark-gfm
 *   - Syntax-highlighted code fences via react-syntax-highlighter (Prism)
 *
 * Kept tiny and dependency-light — heavy widgets like diff viewers live
 * in their own files (BashWidget, EditWidget, …).
 */
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface Props {
  text: string;
}

export const MarkdownRenderer: React.FC<Props> = React.memo(({ text }) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ inline, className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || '');
          const codeStr = String(children).replace(/\n$/, '');
          if (!inline && match) {
            return (
              <SyntaxHighlighter
                style={vscDarkPlus as any}
                language={match[1]}
                PreTag="div"
                customStyle={{
                  margin: '8px 0',
                  borderRadius: 6,
                  fontSize: 12.5,
                  background: '#0d1117',
                }}
                {...props}
              >
                {codeStr}
              </SyntaxHighlighter>
            );
          }
          return (
            <code
              className={className}
              style={{
                background: '#1f1f1f',
                padding: '1px 5px',
                borderRadius: 4,
                fontSize: '0.9em',
              }}
              {...props}
            >
              {children}
            </code>
          );
        },
        a({ href, children, ...props }: any) {
          return (
            <a href={href} target="_blank" rel="noreferrer" {...props}>
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';
