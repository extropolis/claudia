/**
 * AskUserQuestionWidget — renders Claude Code's `AskUserQuestion` tool call
 * as an interactive selector that mirrors the terminal TUI:
 *
 *     Which wrapper approach do you want?
 *
 *     ❯ 1. Full WebView wrapper (Recommended)
 *          Single full-screen WebView pointing at the tunnel URL. …
 *       2. Hybrid: WebView + native settings
 *          WebView for main app + native settings/notifications screen. …
 *       3. WebView as one tab
 *          Keep the current native screens but add the web app as one tab. …
 *
 *       4. Type something.
 *       5. Chat about this
 *
 * The shape of the input is documented at
 *   https://code.claude.com/docs/en/agent-sdk/typescript#askuserquestion
 *
 *   type AskUserQuestionInput = {
 *     questions: Array<{
 *       question: string;
 *       header: string;
 *       options: Array<{ label: string; description: string; preview?: string }>;
 *       multiSelect: boolean;
 *     }>;
 *   };
 *
 * If a tool_result has already arrived (the user already answered), we render
 * the answers in a "selected" state instead of clickable buttons. While the
 * call is still pending, clicking an option types the option's number into
 * the PTY (matching what the TUI accepts) and presses Enter — the same path
 * `WaitingInputBanner` uses for quick answers.
 */
import React, { useMemo, useState } from 'react';
import type {
  ConversationToolCall,
  ConversationToolResult,
} from '@claudia/shared';

interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

interface Props {
  call: ConversationToolCall;
  result?: ConversationToolResult;
  /** WebSocket ref for sending PTY input. If absent, the widget renders
   *  read-only (e.g. when reviewing past conversations on a fresh load). */
  wsRef?: React.RefObject<WebSocket | null>;
  taskId?: string;
}

/** Best-effort coercion of `call.input.questions` to our `AskQuestion[]`. */
function readQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const o = q as Record<string, unknown>;
    if (typeof o.question !== 'string' || !o.question) continue;
    const optsRaw = Array.isArray(o.options) ? o.options : [];
    const options: AskOption[] = [];
    for (const op of optsRaw) {
      if (!op || typeof op !== 'object') continue;
      const oo = op as Record<string, unknown>;
      if (typeof oo.label !== 'string' || !oo.label) continue;
      options.push({
        label: oo.label,
        description:
          typeof oo.description === 'string' ? oo.description : undefined,
        preview: typeof oo.preview === 'string' ? oo.preview : undefined,
      });
    }
    out.push({
      question: o.question,
      header: typeof o.header === 'string' ? o.header : undefined,
      multiSelect: Boolean(o.multiSelect),
      options,
    });
  }
  return out;
}

/** The tool_result for AskUserQuestion is a free-text summary like
 *    `User has answered your questions: "Q1"="Option A", "Q2"="Option B" …`
 *  We pull a flat map of question→answer so we can highlight the chosen
 *  option per question. The match is fuzzy on purpose — Claude Code may
 *  add notes, multi-selects come comma-joined, etc. */
function parseAnswers(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!output) return out;
  // Match `"<question>"="<answer>"` pairs, tolerant of quoting.
  const re = /"([^"]+)"\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Chosen option label appears anywhere inside the answer string (handles
 *  multi-select where multiple labels are comma-joined). */
function isChosen(answer: string | undefined, optionLabel: string): boolean {
  if (!answer) return false;
  return answer.toLowerCase().includes(optionLabel.toLowerCase());
}

export const AskUserQuestionWidget: React.FC<Props> = React.memo(
  ({ call, result, wsRef, taskId }) => {
    const questions = useMemo(() => readQuestions(call.input), [call.input]);
    const answers = useMemo(
      () => (result?.output ? parseAnswers(result.output) : {}),
      [result?.output],
    );
    const isAnswered = !!result;
    // Local optimistic selection — until the WS round-trips back as a
    // tool_result, show a chosen button as "pending" so the click doesn't
    // feel inert.
    const [pendingPick, setPendingPick] = useState<string | null>(null);

    if (questions.length === 0) {
      // Malformed input — fall back to JSON dump so we don't swallow info.
      return (
        <div className="conv-tool conv-tool-ask">
          <div className="conv-tool-head">
            <span className="conv-tool-icon">❓</span>
            <span className="conv-tool-name">AskUserQuestion</span>
          </div>
          <pre className="conv-tool-input">
            {JSON.stringify(call.input, null, 2)}
          </pre>
        </div>
      );
    }

    const sendPick = (q: AskQuestion, optionIdx: number) => {
      if (isAnswered) return;
      const ws = wsRef?.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !taskId) return;
      // Claude Code's TUI accepts the option number followed by Enter for
      // single-select questions. For multi-select we'd need to toggle and
      // confirm — fall back to typing the number for v1; the TaskInputBar
      // is still available for nuanced replies.
      const num = String(optionIdx + 1);
      ws.send(
        JSON.stringify({
          type: 'task:input',
          payload: { taskId, data: num + '\r' },
        }),
      );
      setPendingPick(`${q.question}::${num}`);
    };

    return (
      <div className="conv-tool conv-tool-ask">
        <div className="conv-tool-head">
          <span className="conv-tool-icon">❓</span>
          <span className="conv-tool-name">
            {isAnswered ? 'Question (answered)' : 'Question'}
          </span>
        </div>

        {questions.map((q, qIdx) => {
          const answer = answers[q.question];
          return (
            <div key={qIdx} className="conv-ask-question">
              {q.header && (
                <span className="conv-ask-header-chip">{q.header}</span>
              )}
              <div className="conv-ask-prompt">{q.question}</div>

              <div className="conv-ask-options">
                {q.options.map((opt, oIdx) => {
                  const chosen =
                    isAnswered && isChosen(answer, opt.label);
                  const pending =
                    !isAnswered &&
                    pendingPick === `${q.question}::${oIdx + 1}`;
                  const cls = [
                    'conv-ask-option',
                    chosen && 'is-chosen',
                    pending && 'is-pending',
                    isAnswered && !chosen && 'is-dim',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <button
                      key={oIdx}
                      className={cls}
                      type="button"
                      disabled={isAnswered || pending}
                      onClick={() => sendPick(q, oIdx)}
                      title={
                        isAnswered
                          ? chosen
                            ? 'You picked this option'
                            : 'Already answered'
                          : 'Send this answer to Claude Code'
                      }
                    >
                      <span className="conv-ask-caret">
                        {chosen || pending ? '❯' : ' '}
                      </span>
                      <span className="conv-ask-num">{oIdx + 1}.</span>
                      <span className="conv-ask-body">
                        <span className="conv-ask-label">{opt.label}</span>
                        {opt.description && (
                          <span className="conv-ask-desc">
                            {opt.description}
                          </span>
                        )}
                        {opt.preview && (
                          <pre className="conv-ask-preview">{opt.preview}</pre>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>

              {q.multiSelect && !isAnswered && (
                <div className="conv-ask-hint">
                  Multi-select — pick a primary choice here, or use the input
                  bar below for a custom combination.
                </div>
              )}
              {isAnswered && answer && (
                <div className="conv-ask-answer">
                  <span className="conv-ask-answer-label">Answer:</span>{' '}
                  {answer}
                </div>
              )}
            </div>
          );
        })}

        {!isAnswered && (
          <div className="conv-ask-hint conv-ask-hint-foot">
            Click an option to send it, or type a free-text reply in the input
            bar below.
          </div>
        )}
      </div>
    );
  },
);

AskUserQuestionWidget.displayName = 'AskUserQuestionWidget';
