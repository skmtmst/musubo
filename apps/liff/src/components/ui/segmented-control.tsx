import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import Button from './button/index.js';

type Choice<Value extends string> = { value: Value; label: string };

type SegmentedControlProps<Value extends string> = {
  label: string;
  choices: readonly Choice<Value>[];
  value: Value;
  onChange: (value: Value) => void;
} & ({ children: ReactNode } | { children?: never });

/** 中身を切り替えるタブと、表示形式の選択に使う。 */
export default function SegmentedControl<Value extends string>({
  label, choices, value, onChange, children,
}: SegmentedControlProps<Value>) {
  const id = useId();
  const controls = useRef<Array<HTMLButtonElement | null>>([]);
  const isTabList = children !== undefined;
  const active = choices.findIndex((choice) => choice.value === value);
  const panelId = `${id}-panel`;

  function move(event: KeyboardEvent) {
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = choices.length - 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const offset = event.key === 'ArrowLeft' ? -1 : 1;
      next = isTabList ? (active + offset + choices.length) % choices.length
        : Math.max(0, Math.min(choices.length - 1, active + offset));
    } else if (!isTabList && event.key === 'ArrowUp') next = Math.max(0, active - 1);
    else if (!isTabList && event.key === 'ArrowDown') next = Math.min(choices.length - 1, active + 1);
    else return;
    const choice = choices[next];
    if (!choice) return;
    event.preventDefault();
    onChange(choice.value);
    controls.current[next]?.focus();
  }

  return <>
    <div
      role={isTabList ? 'tablist' : 'radiogroup'}
      aria-label={label}
      onKeyDown={move}
      className={isTabList ? 'flex min-h-[46px] rounded-(--liff-radius) bg-shell-gray p-[3px]' : 'flex gap-1 rounded-(--liff-radius) bg-liff-chip p-[3px]'}
    >
      {choices.map((choice, index) => {
        const selected = value === choice.value;
        const semantics = isTabList
          ? { role: 'tab', 'aria-controls': panelId, 'aria-selected': selected, tabIndex: selected ? 0 : -1 }
          : { role: 'radio', 'aria-checked': selected };
        return <Button key={choice.value} id={`${id}-${choice.value}`} {...semantics}
          ref={(button) => { controls.current[index] = button; }} variant={isTabList ? 'panels-tab' : 'tab'}
          selected={selected} onClick={() => onChange(choice.value)}>{choice.label}</Button>;
      })}
    </div>
    {isTabList && <div id={panelId} role="tabpanel" aria-labelledby={`${id}-${value}`}>{children}</div>}
  </>;
}
