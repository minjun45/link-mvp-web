import { useEffect, useRef, useState } from 'react';
import { Button, T, type Theme } from './kit';

type Choice = { text: string; onPress?: () => void };
type Message = { title: string; text: string; choices: Choice[]; onCancel?: () => void };

export function useAppDialog(theme: Theme) {
  const ref = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState<Message | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (message && dialog && !dialog.open) dialog.showModal();
  }, [message]);

  function alert(
    title: string,
    text: string,
    choices: Choice[] = [{ text: '닫기' }],
    onCancel?: () => void,
  ) {
    setMessage({ title, text, choices, onCancel });
  }

  const dialog = (
    <dialog
      ref={ref}
      className="app-dialog"
      aria-labelledby="dialog-title"
      aria-describedby="dialog-text"
      style={{ backgroundColor: theme.card }}
      onCancel={event => {
        event.preventDefault();
        ref.current?.close();
        message?.onCancel?.();
      }}
      onClose={() => setMessage(null)}
    >
      {message && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div id="dialog-title"><T kind="section">{message.title}</T></div>
          <div id="dialog-text"><T>{message.text}</T></div>
          {message.choices.map(choice => (
            <Button
              key={choice.text}
              label={choice.text}
              onPress={() => {
                ref.current?.close();
                choice.onPress?.();
              }}
            />
          ))}
        </div>
      )}
    </dialog>
  );
  return { alert, dialog };
}
