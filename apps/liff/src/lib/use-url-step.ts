import { useCallback, useEffect, useRef, useState } from 'react';

/** 手順をURLに残す。戻るで前の手順へ戻し、再読込では未復元の入力で確定へ進ませない。 */
export function useUrlStep<T extends string>(initial: T, options?: {
  search: string;
  write: (search: URLSearchParams, replace: boolean) => void;
}) {
  const [step, setValue] = useState(initial);
  const current = useRef(step);
  current.current = step;
  const visited = useRef(new Set<string>([initial]));
  const writer = useRef(options);
  writer.current = options;
  const read = () => new URLSearchParams(writer.current?.search ?? window.location.search).get('step');
  const setStep = useCallback((next: T) => {
    if (current.current === next) return;
    current.current = next;
    visited.current.add(next);
    setValue(next);
    const query = new URLSearchParams(writer.current?.search ?? window.location.search);
    query.set('step', next);
    if (writer.current) writer.current.write(query, false);
    else window.history.pushState(window.history.state, '', `${window.location.pathname}?${query}${window.location.hash}`);
  }, []);
  useEffect(() => {
    const next = read();
    if (next && visited.current.has(next)) setValue(next as T);
    else {
      setValue(initial);
      if (!next) return;
      const query = new URLSearchParams(writer.current?.search ?? window.location.search);
      query.set('step', initial);
      if (writer.current) writer.current.write(query, true);
      else window.history.replaceState(window.history.state, '', `${window.location.pathname}?${query}${window.location.hash}`);
    }
  }, [options?.search, initial]);
  useEffect(() => {
    const back = () => {
      const next = new URLSearchParams(window.location.search).get('step');
      setValue(next && visited.current.has(next) ? next as T : initial);
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [initial]);
  return [step, setStep] as const;
}
