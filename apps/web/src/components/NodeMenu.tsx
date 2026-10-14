import { useEffect } from 'react';
import { getLayout, isCollapsed, setAttr, findNode } from '@mindmap/core';
import { useStore } from '../store';
import { useAux } from '../workspace';
import { useStudy } from '../study';
import { useUi } from '../ui';
import { commands } from '../commands';
import { NAMED_COLORS } from '../colors';

const COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;

/** 글자 서식: [이름, 앞, 뒤, 도움말] */
const FORMATS: [string, string, string, string][] = [
  ['빈칸', '==', '==', '가리기 모드·카드에서 빈칸이 됩니다'],
  ['굵게', '**', '**', ''],
  ['기울임', '*', '*', ''],
  ['코드', '`', '`', ''],
  ['수식', '$', '$', 'LaTeX 수식'],
  ['링크', '[[', ']]', '다른 맵·페이지 링크'],
];

/**
 * 맵 위에서 오른쪽 클릭하면 나오는 메뉴.
 * - 노드 글자를 고치는 중(글자를 드래그해 둔 상태 포함): 빈칸·굵게 등 글자 서식
 * - 그 밖: 노드 단위 자주 쓰는 동작
 */
export function NodeContextMenu() {
  const ctx = useUi((s) => s.ctx);
  const close = () => useUi.getState().openCtx(null);

  useEffect(() => {
    if (!ctx) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useUi.getState().openCtx(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctx]);
  if (!ctx) return null;

  const st = useStore.getState();
  const map = st.map;
  const node = map ? findNode(map.doc.root, ctx.nodeId) : null;
  if (!map || !node) return null;

  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const btn = (label: string, fn: () => void, opts: { danger?: boolean; disabled?: boolean; hint?: string; key?: string } = {}) => (
    <button
      key={opts.key ?? label}
      className={opts.danger ? 'danger' : ''}
      disabled={opts.disabled}
      title={opts.hint}
      onClick={run(fn)}
    >
      {label}
    </button>
  );

  let title = '';
  let items: React.ReactNode[];
  let rows = 0;

  if (ctx.text) {
    const t = ctx.text;
    title = t.hasSel ? '선택한 글자' : '커서가 있는 낱말';
    items = [
      ...FORMATS.map(([name, open, close2, hint]) => btn(name, () => t.wrap(open, close2), { hint: hint || undefined })),
      <div key="sep1" className="menu-sep" />,
      btn('복사', t.copy, { disabled: !t.hasSel }),
      btn('잘라내기', t.cut, { disabled: !t.hasSel }),
      btn('붙여넣기', t.paste),
    ];
    rows = FORMATS.length + 3;
  } else {
    const locked = useStudy.getState().hide !== null;
    const multi = st.selected.length > 1;
    const isRoot = node.id === map.doc.root.id;
    const canFold = node.children.length > 0 && !(isRoot && getLayout(map.doc) === 'mindmap');
    const targets = st.selected.includes(node.id) ? st.selected : [node.id];
    const setColor = (c: string | undefined) =>
      st.apply((d) => targets.forEach((id) => setAttr(d, id, 'color', c)));
    title = multi ? `노드 ${st.selected.length}개` : node.text.split('\n')[0] || '(빈 주제)';
    if (locked) {
      items = [
        btn('모든 빈칸 열기', () => useStudy.getState().setAllClozes(false)),
        btn('모든 빈칸 가리기', () => useStudy.getState().setAllClozes(true)),
        btn('가리기 모드 종료', () => useStudy.getState().exitHide()),
      ];
      rows = 3;
    } else {
      items = [
        btn('글자 편집 · 일부를 빈칸으로', () => commands.edit(), { disabled: multi, hint: '더블클릭으로 편집한 뒤 글자를 드래그하고 오른쪽 클릭' }),
        btn('하위 주제 추가', () => commands.addChild(), { disabled: multi }),
        btn('동급 주제 추가', () => commands.addSibling(), { disabled: multi || isRoot }),
        <div key="sep1" className="menu-sep" />,
        btn('메모', () => useAux.getState().toggleNote(node.id), { disabled: multi }),
        btn('상세 페이지', () => void useAux.getState().openOrCreatePage(node.id), { disabled: multi }),
        btn(isCollapsed(node) ? '펼치기' : '접기', () => commands.toggleCollapse(), { disabled: !canFold && !multi }),
        <div key="sep2" className="menu-sep" />,
        <div key="colors" className="menu-colors" role="group" aria-label="색상">
          {COLOR_NAMES.map((c) => (
            <button
              key={c}
              className={`swatch ${node.attrs.color === c ? 'on' : ''}`}
              style={{ background: NAMED_COLORS[c] }}
              title={c}
              aria-label={`색상 ${c}`}
              onClick={run(() => setColor(c))}
            />
          ))}
          <button className="swatch none" title="색 없애기" aria-label="색 없애기" onClick={run(() => setColor(undefined))}>
            ∅
          </button>
        </div>,
        <div key="sep3" className="menu-sep" />,
        btn('여기서 가리기 시작', () => useStudy.getState().enterHide(node.id), { disabled: multi, hint: '이 노드 아래를 가리고 떠올려 보기 (F8)' }),
        btn('복사', () => {
          const t = commands.copyText();
          if (t !== null) void navigator.clipboard?.writeText(t).catch(() => st.toast('복사하지 못했습니다', 'error'));
        }),
        btn('붙여넣기 (하위로)', () => {
          void navigator.clipboard
            ?.readText()
            .then((t) => commands.paste(t))
            .catch(() => st.toast('붙여넣기 권한이 없습니다. Ctrl+V 를 쓰세요', 'error'));
        }, { disabled: multi }),
        btn('삭제', () => commands.remove(), { danger: true, disabled: isRoot && !multi }),
      ];
      rows = 15;
    }
  }

  const left = Math.max(8, Math.min(ctx.x, window.innerWidth - 230));
  const top = Math.max(8, Math.min(ctx.y, window.innerHeight - 24 - rows * 34));
  return (
    // 버튼을 눌러도 편집 중인 입력창이 포커스를 잃지 않도록 mousedown 을 막는다
    <div
      className="menu-backdrop"
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={close}
      onContextMenu={(e) => (e.preventDefault(), close())}
    >
      <div
        className="tree-menu node-menu"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        role="menu"
      >
        <div className="tree-menu-title">{title}</div>
        {items}
      </div>
    </div>
  );
}
