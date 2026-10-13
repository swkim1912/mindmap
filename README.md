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

처음 실행하면 예시 맵(`예시/운영체제.mm.md`)과 AI용 설명서(`AGENTS.md`)가 만들어집니다.
서버 포트는 `MINDMAP_PORT` 로 바꿀 수 있습니다 (기본 4321).

## AI로 편집하기

Vault 폴더의 `.mm.md` 파일을 Claude Code 등으로 직접 편집하면 열린 화면에 즉시 반영됩니다.
앱에 저장 안 된 편집이 있으면 노드 ID 기준으로 자동 병합합니다. 편집 후 검사:

```bash
npm run lint:map -- vault/예시/운영체제.mm.md
```

## 구조

| 경로 | 내용 |
|---|---|
| `packages/core` | 데이터 모델, 파서/직렬화기, 3-way 병합, 편집 연산 (테스트: `npm test`) |
| `apps/server` | 로컬 서버: Vault 파일 API, 파일 감시(SSE), 히스토리/휴지통 |
| `apps/web` | 웹 UI (React) |
| `docs/FORMAT.md` | 파일 포맷 명세 = Vault의 `AGENTS.md` 원본 |

## 데이터 안전장치

- 저장은 임시 파일에 쓴 뒤 교체(원자적 쓰기)
- 덮어쓰기 전 내용을 `.mindmap/history/`에 보관 (파일당 5분 간격, 최근 50개)
- 삭제는 `.mindmap/trash/`로 이동
- 해석할 수 없는 줄은 버리지 않고 보존
