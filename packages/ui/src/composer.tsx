import { ArrowUp, Mic, Square } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { IconButton } from './button.js';

export interface CommandComposerProps {
  onSubmit: (text: string) => void;
  placeholder?: string;
  /** Offered while something can be stopped. Disabled otherwise. */
  onStop?: () => void;
  canStop?: boolean;
  /** Lets other UI, such as example commands, fill in the input. */
  value?: string;
  onValueChange?: (value: string) => void;
}

export function CommandComposer({
  onSubmit,
  placeholder = 'Type a command, like “new tab”',
  onStop,
  canStop = false,
  value,
  onValueChange,
}: CommandComposerProps) {
  const [internal, setInternal] = useState('');
  const text = value ?? internal;
  const setText = onValueChange ?? setInternal;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!text.trim()) return;
    onSubmit(text);
    setText('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-line bg-surface p-1.5 transition-shadow duration-150 focus-within:border-faint focus-within:shadow-sm"
    >
      <textarea
        aria-label="Command"
        rows={1}
        value={text}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="block max-h-32 w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-faint"
      />
      <div className="flex items-center justify-between">
        <IconButton label="Voice input, coming soon" disabled>
          <Mic aria-hidden="true" className="size-4" />
        </IconButton>
        <div className="flex items-center gap-1">
          {onStop && (
            <IconButton label="Stop" onClick={onStop} disabled={!canStop}>
              <Square aria-hidden="true" className="size-3.5" />
            </IconButton>
          )}
          <IconButton label="Send" type="submit" variant="primary" disabled={!text.trim()}>
            <ArrowUp aria-hidden="true" className="size-4" />
          </IconButton>
        </div>
      </div>
    </form>
  );
}
