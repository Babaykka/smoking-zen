import type { ReactNode } from 'react';

import { isSafePersistedHttpsUrl } from '@/domain/schemas';

function inlineMarkdown(value: string): ReactNode[] {
  return value.split(/(\[[^\]]+\]\([^)]*\)|\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => {
    const link = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(part);
    if (link) return isSafePersistedHttpsUrl(link[2] ?? '')
      ? <a href={link[2]} key={index} rel="noopener noreferrer" target="_blank">{link[1]}</a>
      : <span key={index}>{link[1]}</span>;
    return part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : <span key={index}>{part}</span>;
  });
}

export function SafeMarkdown({ value }: { value: string }) {
  return <div className="task-markdown">{value.split('\n').filter((line) => !/^!\[[^\]]*\]\([^)]*\)$/.test(line)).map((line, index) => {
    const checklist = /^\s*- \[([ xX])\]\s+(.*)$/.exec(line);
    if (checklist) return <label className="task-markdown__check" key={index}><input checked={checklist[1]?.toLowerCase() === 'x'} disabled readOnly type="checkbox" /><span>{inlineMarkdown(checklist[2] ?? '')}</span></label>;
    return <p key={index}>{inlineMarkdown(line)}</p>;
  })}</div>;
}
