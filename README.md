# 마인드맵 (학습·암기용)

로컬 Markdown 파일 기반 마인드맵. 기획은 [SPEC.md](SPEC.md), 파일 포맷은 [docs/FORMAT.md](docs/FORMAT.md) 참고.

## 실행

```bash
npm install
npm start          # 빌드 후 http://localhost:4321
```

개발 모드 (코드 수정 시 자동 반영): `npm run dev` → http://localhost:5173

### Vault(데이터 폴더) 위치

기본값은 이 저장소의 `vault/` 폴더입니다. 다른 곳(예: OneDrive)을 쓰려면:

```powershell
$env:MINDMAP_VAULT = "D:\공부\Vault"; npm start
```

처음 실행하면 예시(`예시/` 폴더의 맵 2개와 페이지 1개)와 AI용 설명서(`AGENTS.md`)가 만들어집니다.
서버 포트는 `MINDMAP_PORT` 로 바꿀 수 있습니다 (기본 4321).

## 주요 기능

| 기능 | 사용법 |
|---|---|
| 노드 편집 | Tab(하위), Enter(동급), F2/타이핑(편집), Delete, 드래그 이동, Alt+↑↓(순서). F1로 전체 단축키 |
| 포스트잇(메모) | F4 열기/닫기·만들기, Shift+F4 전체 토글. Markdown·수식·코드·이미지(붙여넣기/드롭) 지원 |
| 팝업 페이지 | Ctrl+E — 노드에 연결된 페이지를 열고, 없으면 새로 만듦. 편집/분할/미리보기, 자동 저장 |
| 링크 | Ctrl+K로 맵·노드·페이지 검색해 삽입. 노드의 ↗ 또는 Ctrl+클릭으로 이동, Alt+←로 복귀 |
| 역링크 | 다른 곳에서 가리키는 노드에 `↩ N` 표시. 클릭하면 목록 |
| 검색 | Ctrl+P — 노드·메모·페이지 본문 전체 검색. `#태그` 로 태그 검색 |
| 폴더 | 사이드바의 폴더 = 실제 폴더. 이름 변경·이동하면 링크도 자동 갱신 |
| 가리기 모드 | F8 — 선택한 노드 아래를 가리고(구조는 유지) 클릭/Space로 하나씩 공개. 메모와 `==빈칸==`도 가림. 파일은 바뀌지 않음 |
| 카드 복습 | 툴바 🃏 — `질문 :: 답`, `==빈칸==`(선택: 노드→하위 항목)을 카드로. Space 뒤집기, 1/← 몰랐음, 2/→ 알았음(스와이프도 가능). 몰랐던 카드는 다시 나옴 |

## 클라우드 동기화 (선택, 모바일용)

PC의 Vault를 Supabase에 미러링합니다. 원본은 항상 PC 폴더이고, 설정하지 않으면 동기화는 꺼져 있습니다.

1. Supabase 대시보드 → Authentication → Add user 로 본인 계정(이메일+비밀번호)을 만들고, Sign In / Providers 에서 **Allow new users to sign up 을 끕니다**.
2. 저장소 루트에 `.env.sync` 파일을 만듭니다 (git에 올라가지 않음).

```
MINDMAP_SUPABASE_URL=https://<프로젝트>.supabase.co
MINDMAP_SUPABASE_KEY=<publishable 키 (sb_publishable_...)>
MINDMAP_SYNC_EMAIL=<위에서 만든 이메일>
MINDMAP_SYNC_PASSWORD=<비밀번호>
```

3. `npm start` 를 다시 실행하면 "클라우드 동기화: 켜짐"이 표시됩니다. 파일이 바뀔 때, 모바일에서 바뀔 때, 30초마다 동기화합니다. 상태는 `GET /api/sync`.

- 맵(`.mm.md`)은 노드 단위로 3-way 병합합니다. 같은 노드를 양쪽에서 고쳤거나 페이지가 충돌하면 PC 내용을 남기고 클라우드 내용을 `이름 (충돌 사본).md` 로 보존합니다.
- 한쪽에서 지우고 다른 쪽에서 고쳤으면 고친 쪽을 살립니다. 지워진 파일은 `.mindmap/trash/` 로 갑니다.
- 이미지는 10MB 이하만 올라가며, 빈 폴더는 동기화되지 않습니다(파일이 생기면 따라 만들어집니다).

## AI로 편집하기

Vault 폴더의 `.mm.md` / `.md` 파일을 Claude Code 등으로 직접 편집하면 열린 화면에 즉시 반영됩니다.
앱에 저장 안 된 편집이 있으면 맵은 노드 ID 기준으로 자동 병합하고, 페이지는 충돌 시 어느 쪽을 쓸지 묻습니다.
편집 후 검사:

```bash
npm run lint:map -- vault/예시/운영체제.mm.md
```

## 구조

| 경로 | 내용 |
|---|---|
| `packages/core` | 데이터 모델, 파서/직렬화기, 3-way 병합, 편집 연산, 링크 해석, 카드 생성 (테스트: `npm test`) |
| `apps/server` | 로컬 서버(+ Supabase 동기화 `sync.ts`): Vault 파일 API, 파일 감시(SSE), 검색·역링크 색인, 이미지 업로드, 복습 기록, 히스토리/휴지통 |
| `apps/web` | 웹 UI (React) |
| `docs/FORMAT.md` | 파일 포맷 명세 = Vault의 `AGENTS.md` 원본 |

## 데이터 안전장치

- 저장은 임시 파일에 쓴 뒤 교체(원자적 쓰기)
- 덮어쓰기 전 내용을 `.mindmap/history/`에 보관 (파일당 5분 간격, 최근 50개)
- 삭제는 `.mindmap/trash/`로 이동
- 해석할 수 없는 줄은 버리지 않고 보존
- 폴더 이동 중 일부만 실패하면 원래대로 되돌림 (맵 파일과 딸린 폴더가 어긋나지 않게)
- 페이지/메모의 Markdown은 화면에 그리기 전에 정화(DOMPurify)해서 파일 내용으로 스크립트가 실행되지 않음
