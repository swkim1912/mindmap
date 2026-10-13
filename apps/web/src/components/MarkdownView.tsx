import { memo, useEffect, useMemo, useRef } from 'react';
import { useAux } from '../workspace';
import { renderMarkdown } from '../markdown';

interface Props {
  md: string;
  /** 이 문서가 있는 폴더 (상대 이미지 경로 해석용) */
  baseDir: string;
  /** 이 문서의 경로 (링크 해석의 기준) */
  fromPath: string;
  className?: string;
}

export const MarkdownView = memo(function MarkdownView({ md, baseDir, fromPath, className }: Props) {
  const html = useMemo(() => renderMarkdown(md, baseDir), [md, baseDir]);
  const lookup = useAux((s) => s.lookup);
  const ref = useRef<HTMLDivElement>(null);

  // 대상 파일이 없는 링크는 깨진 링크로 표시
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLAnchorElement>('a.wikilink').forEach((a) => {
      const link = { target: a.dataset.target ?? '', anchor: a.dataset.anchor || null };
      a.classList.toggle('broken', !lookup.resolve(link, fromPath));
    });
  }, [html, lookup, fromPath]);

  return (
    <div
      ref={ref}
      className={`md ${className ?? ''}`}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.wikilink');
        if (!a) return;
        e.preventDefault();
        void useAux.getState().followLink({ target: a.dataset.target ?? '', anchor: a.dataset.anchor || null }, fromPath);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
