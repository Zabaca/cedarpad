// The canvas's chat-start control: a prompt, not a button. At rest it's a compact
// monospace bar ("> start a chat"); focused, it widens into a command line with the
// placement scope, starter suggestions, and a Run button. Submitting creates the chat
// card AND arms the typed text as its first turn (App's `newChat`), so a chat never
// starts empty.
import { useCallback, useEffect, useRef, useState } from 'react';

const SUGGESTIONS = ['Summarize this canvas', 'Build a component…', 'Read the repo and…'];

export function ChatStarter({ onStart, scope, disabled }: { onStart: (prompt: string) => void; scope?: () => string | undefined; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const submit = useCallback(() => {
    const prompt = value.trim();
    if (!prompt || disabled) return;
    setValue('');
    setOpen(false);
    inputRef.current?.blur();
    onStart(prompt);
  }, [value, disabled, onStart]);

  // Window-level capture, like ChatView's: tldraw's own keydown handler would otherwise
  // eat Enter/Escape before the field sees them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target !== inputRef.current) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setValue('');
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [submit]);

  const focus = () => {
    setOpen(true);
    // The textarea only exists once open, so focus after the state lands.
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  if (!open) {
    return (
      <button type="button" className="chat-starter chat-starter-rest" onClick={focus} disabled={disabled} title="Type a prompt to start a chat">
        <span className="chat-starter-sigil">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m4 17 6-6-6-6" />
            <path d="M12 19h8" />
          </svg>
        </span>
        <span className="chat-starter-caret">&gt;</span>
        <span className="chat-starter-ph">start a chat</span>
      </button>
    );
  }

  // Read fresh on every open/keystroke, so the tag tracks whatever is selected right now.
  const scopeLabel = scope?.();
  return (
    <div className="chat-starter-open">
      <div className="chat-starter-suggest">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className="chat-starter-sug"
            // Keep the field focused: a mousedown default would blur it and close the bar.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setValue(s);
              inputRef.current?.focus();
            }}
          >
            {s}
          </button>
        ))}
      </div>
      <form
        className="chat-starter chat-starter-focused"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="chat-starter-sigil">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m4 17 6-6-6-6" />
            <path d="M12 19h8" />
          </svg>
        </span>
        <span className="chat-starter-caret">&gt;</span>
        <textarea
          ref={inputRef}
          className="chat-starter-input"
          rows={1}
          value={value}
          placeholder="type a prompt to start a chat"
          // onInput, not onChange: for a textarea they fire on the same native event, but
          // React's onChange is synthesized through a value tracker that happy-dom defeats
          // — so onChange is untestable here while onInput behaves identically in both.
          onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
          onBlur={() => {
            if (!value.trim()) setOpen(false);
          }}
        />
        {scopeLabel && <span className="chat-starter-scope">↳ {scopeLabel}</span>}
        <button type="submit" className="chat-starter-run" disabled={!value.trim() || disabled}>
          Run <kbd>⏎</kbd>
        </button>
      </form>
    </div>
  );
}
