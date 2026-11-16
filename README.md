# Encela (엔셀라)

**요청 한 번이면 Claude가 설계도를 쓰고, 필요한 부품을 골라 조립해서 만들어요.**

엔셀라는 Claude Code용 MCP 서버와 플러그인이에요. 부품(MCP 서버, CLI, 라이브러리, skill, rule, 지침, subagent)을 레고 블록처럼 갖고 있다가, 요청이 들어오면 Claude가 설계도를 그리고 사용자가 승인한 부품만 조립해요. 부품끼리는 파이프라인으로 실제로 이어서, 데이터가 Claude를 거치지 않고 부품에서 부품으로 넘어가요.

> 개발 초기 단계예요. 로드맵 1~5단계(부품·허브, 설계도·승인, 파이프라인, GitHub 파인더, 레시피)는 동작해요. [로드맵](#로드맵)

## 어떻게 동작하나요

| 레고에 비유하면 | 엔셀라에서는 |
|---|---|
| 만들고 싶은 것 (자동차) | 사용자의 프롬프트 |
| 설계도 | Claude가 쓰는 **blueprint** |
| 부품 | **piece**: 카탈로그 256개, 직접 추가한 것, 밖에서 찾은 것 |
| 부품을 서로 끼우는 것 | **pipeline**: 한 부품의 결과를 다른 부품의 입력으로 |
| 조립하는 사람 | Claude(오케스트레이터)와 서브에이전트(작업자) |
| 어떤 부품을 붙일지 | 사용자가 설계도를 승인하거나 고쳐요 |

요청은 크기에 따라 세 갈래로 가요. Claude가 정해서 한 줄로 알려 주고, 직접 정하려면 명령을 쓰면 돼요.

| 수준 | 어떤 요청 | 엔셀라가 하는 일 | 직접 정하기 |
|---|---|---|---|
| Simple | 질문, 작은 수정, Claude Code가 혼자 하는 일(커밋, PR, 배포) | 아무것도 안 해요 | `/encela:simple` |
| Medium | 작은 페이지나 스크립트, 만든 것의 후속 수정 | 부품을 한 번 찾고, `quick_build` 한 번으로 저장·승인·조립 | `/encela:medium` |
| Difficult | 새 앱이나 워크플로우, 여러 부분, 작업자, 파이프라인 | 아래의 전체 흐름 | `/encela:difficult` |

Medium도 승인 창은 그대로 떠요. 승인 전에는 아무것도 조립되거나 실행되지 않아요.

```
프롬프트
  └ hook이 세 수준을 적은 짧은 안내를 붙임 (Difficult일 때 아래로). 맞는 부품·레시피 추천은 `encela hints on`으로 켰을 때만 붙음
① 분석      목표, 요구사항, 사용자가 정할 것
② 부품 찾기  find_pieces → get_piece (없으면 github_search → github_read → piece_add)
③ 설계도    blueprint_save: 부품과 역할, 작업자, 단계, 파이프라인, 선택지
④ 승인      blueprint_approve: 승인 / 수정 / 취소
⑤ 조립      blueprint_assemble: MCP 부품 시작, 문서 부품 작업용 사본, 작업자별 지시서
⑥ 만들기    단계별로 진행(blueprint_step), 독립된 단계는 서브에이전트로 동시에,
            도구를 잇는 부분은 pipeline_run으로 엔셀라가 직접 실행
```

- **오케스트레이터는 사용자의 Claude Code 세션**이에요. 엔셀라는 모델을 부르지 않아서 추가 비용이 없어요.
- **승인 전에는 아무것도 실행하지 않아요.** 서버가 막아요. Claude Code가 지원하면 승인 질문을 엔셀라가 사용자에게 직접 띄워요.
- **MCP 부품은 필요할 때만 시작해요.** 도구는 `<부품>__<도구>` 이름으로 나타나고, 설계도에서 쓸 도구를 제한할 수 있어요.
- **문서 부품은 사본을 고쳐 써요.** `.encela/build/<설계도>/` 아래 사본을 이번 작업에 맞게 고치고(`encela:assembler` 서브에이전트), 원본 부품은 바꾸지 않아요. 사본에는 출처와 라이선스가 남아요.

## 작업 화면

엔셀라가 일하는 동안 Claude Code 안에 패널이 하나 뜨고, 프롬프트 위에 한 줄 요약이 보여요. 따로 창을 띄우지 않아요.

```
할 일 앱 만들기
✓ 부품 › ✓ 설계도 › ✓ 승인 › ✓ 조립 › ● 만들기

단계 ███████▓░░░░░░░░░░░░░░░░░░░░ 1/4
 ✓ 데이터 모델                          backend
 ⠹ API 구현                             backend
   └ Edit routes.ts
 ⠹ 화면 구현                           frontend
   └ playwright · browser_click
 ○ 테스트

부품
 ● playwright              browser_click · 12회
 ○ context7
 + 문서 1 · 도구 안내 1

파이프라인 exports                 2/5 · 실행 중
 ✓pack › -grep › ⠹names(3/8) › ◆pick › ○save

최근
 API 구현: 시작
 조립 완료 (부품 4개)
```

```
Encela ▸ ⠹ 만들기 1/4 · 작업자 2 · exports 2/5
```

- **흐름**: 부품 찾기 → 설계도 → 승인 → 조립 → 만들기 중 어디인지.
- **단계**: 끝남 ✓, 하는 중 ●(일하는 동안은 스피너), 실패 ✗, 아직 ○. 오른쪽은 맡은 작업자, 아래 줄은 그 작업자(서브에이전트)가 지금 하는 일. 작업자마다 색이 달라요.
- **부품**: 켜져 있는 MCP 부품, 마지막으로 부른 도구와 횟수.
- **파이프라인**: 단계별 상태. ◆는 Claude 차례, `(3/8)`은 여러 개 중 몇 개 끝났는지.
- **움직임**: 하는 중인 단계·파이프라인 단계·호출 중인 부품은 스피너가 돌고, 지금 서 있는 흐름 단계와 "승인을 기다리는 중"은 밝아졌다 어두워지고, 진행 막대에는 빛이 지나가고, 방금 상태가 바뀐 줄은 잠깐 반짝여요. Claude의 차례가 끝나 아무 일도 없으면 멈춰요. 터미널과 데스크톱 앱에서 움직이고, VS Code와 모바일에서는 같은 색으로 멈춘 화면이에요.
- **탭**: 패널 위의 `[ 작업 그래프 ] [ 워크플로우 캔버스 ]` 버튼으로 두 화면을 오가요(클릭, 또는 패널에 포커스를 두고 `1`/`2`·Tab). 무엇을 만드는지와 흐름 줄은 어느 탭에서나 그대로 있어요.
- **워크플로우 캔버스**: 누가 누구를 부리는지 그림으로 보여 줘요. 맨 위에 오케스트레이터, 그 아래 서브에이전트와 실행 중인 파이프라인, 맨 아래에 부품(MCP 서버·문서)과 잠깐 쓰는 도구(웹 검색, 다른 MCP 서버, skill). 서로 관련 있는 둘은 점선으로 이어지고, 한쪽이 다른 쪽을 부르는 동안에는 선에 색이 들어오고 ■가 부르는 쪽에서 불리는 쪽으로 흘러요. 조립 전인 부품은 점선 테두리, 조립 중에는 오케스트레이터에서 모든 부품으로 흐름이 가요. 창이 작아지면 노드의 둘째 줄, 그다음 상자가 사라지고, 한 줄에 다 못 들어가는 노드는 `… +3`으로 묶여요.
- 패널은 엔셀라 도구가 처음 불릴 때 자리가 있으면 저절로 열리고, `/encela-view`로 언제든 열 수 있어요. 터미널이 좁으면 프롬프트 위에 작게 떠요.
- 화면은 **보기만** 해요. 도구 호출을 막거나 바꾸지 않고, 엔셀라를 쓰지 않는 세션에서는 아무것도 하지 않아요. 필요 없으면 `encela setup --no-view`.

## 파이프라인

보통은 Claude가 도구를 부르고, 결과를 읽고, 그 일부를 다음 도구의 인자로 다시 써요. 결과가 크거나 같은 호출이 수십 번 반복되면 그게 전부 Claude의 컨텍스트를 지나가요. 파이프라인은 그 연결을 설계도에 한 번 적어 두는 거예요. 엔셀라가 도구를 직접 부르고 데이터를 넘기고, Claude는 짧은 보고서와 파일 경로만 받아요.

```json
{
  "name": "exports",
  "inputs": { "dir": { "description": "묶을 폴더", "type": "string" } },
  "steps": [
    { "id": "pack", "piece": "mcp:repomix", "tool": "pack_codebase",
      "args": { "directory": "{{ $inputs.dir }}" } },
    { "id": "grep", "piece": "mcp:repomix", "tool": "grep_repomix_output",
      "args": { "outputId": "{{ $steps.pack.json.outputId }}", "pattern": "export function \\w+" } },
    { "id": "names", "transform": "$steps.grep.json.matches | map(.matchedText) | unique" },
    { "id": "pick", "claude": "`names`에서 테스트가 가장 필요한 함수 셋을 골라 줘.",
      "input": { "names": "{{ $steps.names.json }}" }, "expect": "json" }
  ],
  "output": "{{ $steps.pick.json }}"
}
```

단계는 세 종류예요.

| 단계 | 하는 일 |
|---|---|
| **도구** (`piece` + `tool` + `args`) | MCP 부품의 도구를 불러요. `each`를 주면 목록의 항목마다 한 번씩 |
| **변환** (`transform`) | jq 식으로 데이터를 골라내고 모양을 바꿔요 |
| **Claude** (`claude`) | 판단이 필요한 부분만 Claude에게 넘기고, 답을 받으면 이어서 실행해요 |

- `{{ }}` 안은 jq 식이에요. `$steps.<id>`로 앞 단계의 결과(`text`, `json`, `file`, …)를, `$inputs.<이름>`으로 입력을 읽어요.
- 단계는 적힌 순서대로 실행돼요. `"parallel": true`를 주면 읽는 단계만 끝나면 바로 시작해요.
- 각 단계의 결과는 `.encela/runs/<실행>/` 아래 파일로 남아요. 필요한 부분만 `pipeline_get`으로 꺼내 봐요.
- 실패하면 파이프라인을 고쳐서 `pipeline_resume`로 다시 실행해요. 앞에서 끝난 단계는 다시 하지 않아요.

**안전 규칙**

- 파이프라인은 설계도와 함께 승인받아요. 무언가를 **바꿀 수 있는** 도구와 **밖으로 나갈 수 있는** 도구는 승인 화면에 인자와 함께 표시돼요. 그 호출에 값을 넘겨주는 앞 단계(변환식, 다른 호출, 입력 기본값)도 함께 보여줘요. 도구의 서버가 "읽기만 한다", "이 컴퓨터 안에서만 동작한다"고 밝히지 않으면 표시 대상이에요.
- 승인 뒤에 표시된 호출이나 그 호출에 값을 넘겨주는 단계를 바꾸거나 새로 넣으면 다시 승인받아야 하고, 돌고 있던 실행은 멈춰요. 표시된 호출과 상관없는 단계는 그대로 고칠 수 있어요.
- **승인은 이 컴퓨터에서 한 것만 인정돼요.** 승인 기록은 `~/.encela`에 있는 키로 봉인돼요. 저장소에 "승인됨"이라고 적힌 설계도나 실행 폴더가 딸려 와도 초안으로 취급하고, `.encela` 안의 링크는 따라가지 않아요.
- 부품을 시작할 때 넘기는 환경 변수는 승인 화면에 보이고, 다른 코드를 불러오게 만드는 변수(`NODE_OPTIONS`, `LD_PRELOAD`, `PATH` 등)는 설계도에 넣을 수 없어요.
- 사용자가 엔셀라의 질문에 직접 답해서 승인한 설계도만, 표시된 호출이 든 파이프라인을 실행해요. Claude가 답을 전달한 경우에는 Claude가 그 도구를 하나씩 직접 불러서 Claude Code의 허용 창을 거쳐요. 터미널 없이 실행한 Claude Code(`claude -p`)처럼 질문을 띄울 수 없는 곳에서는 항상 이 경우예요. 나중에 엔셀라의 질문에 직접 답하면 그때부터 실행돼요.
- 결과가 어떻게 됐는지 모르는 호출(시간 초과, 연결 끊김)은 읽기 전용 도구가 아니면 자동으로 다시 하지 않아요. 이미 끝난 호출도 결과가 너무 크다는 이유로 다시 하지 않아요.
- jq 식은 별도 스레드에서 10초 제한으로 실행돼요. 환경 변수는 읽을 수 없어요.

자세한 규칙과 그 이유는 [`docs/pipeline-design.md`](docs/pipeline-design.md)에 있어요.

## 설치

Node.js 20 이상과 [Claude Code](https://docs.claude.com/en/docs/claude-code)가 필요해요.

```bash
npx encela setup           # 플러그인을 ~/.encela/claude-plugin 에 쓰고 내 claude로 설치
```

계속 쓸 거면 `npm install -g encela` 뒤에 `encela setup`을 해 두면 시작이 더 빨라요. 소스에서 설치하려면:

```bash
pnpm install
pnpm build
node dist/cli.js setup
```

그다음 Claude Code를 새로 시작하고 평소처럼 요청을 쓰면 돼요. `/encela:go <요청>`과 `/encela:difficult <요청>`은 작은 요청에도 전체 흐름을 강제하고, `/encela:medium`은 가벼운 흐름을, `/encela:simple`은 엔셀라 없이 하도록 해요. 요청 없이 명령만 쓰면 그 뒤 요청들에 그 수준이 적용돼요.

MCP 서버가 승인받은 뒤에 도구 설명을 바꾸거나 도구를 추가하면, 엔셀라가 그 도구를 막아 두고 설계도를 다시 승인받게 해요. 크레딧이나 요금이 드는 호출에는 "비용이 들 수 있음" 표시가 붙어요.

계정 로그인, 키, 켜 둬야 하는 프로그램(Unity, Godot, Blender 등)이 필요한 부품은 설계도와 조립 결과에 "준비물"로 나와요. 엔셀라는 브라우저 로그인을 대신 하지 않고 키를 보관하지 않아요.

| 명령 | 하는 일 |
|---|---|
| `encela setup [--no-auto] [--no-view] [--no-claude]` | 플러그인 설치. `--no-auto`는 프롬프트마다 붙는 안내를, `--no-view`는 작업 화면을 끔 |
| `encela status` | 부품 수와 저장 위치 |
| `encela check [부품] [--yes]` | 이 컴퓨터가 준비됐는지 확인. 부품을 주면 여기서 실제로 띄워 보고 도구 목록과 빠진 것(환경변수, 실행 프로그램)을 알려 줌 |
| `encela hints [on\|off]` | 프롬프트마다 키워드가 맞는 부품·레시피를 추천할지. 기본은 꺼짐. 인자 없이 쓰면 지금 상태를 보여 줌 |
| `encela pieces [단어…] [--kind <종류>]` | 부품 목록·검색 |
| `encela add <file.json>` / `encela remove <id>` | 내 부품 추가·삭제 |
| `encela import [mcp-hub.json]` | 예전 엔셀라(앱, npm 0.1.x)의 모듈 가져오기 |
| `encela uninstall` | 플러그인 제거(내 부품은 남음) |

환경 변수: `ENCELA_HOME`(기본 `~/.encela`), `ENCELA_AUTO=0`(안내 끄기), `ENCELA_HINTS=1`/`0`(추천 켜기/끄기, 설정보다 먼저), `ENCELA_LANG`.

## 부품

모든 부품은 같은 모양이에요: 종류, 이름, 요약, 태그, 할 수 있는 것, 받는 것·내놓는 것, 출처·커밋·라이선스, 경고. 종류에 따라 MCP 서버 설정, 사용 가이드, 문서 본문이 더 붙어요.

| 종류 | 수 | 예 | 조립하면 |
|---|---|---|---|
| `mcp` | 63 | unity, godot, unreal, blender, rea, pyghidra, repomix, duckdb, excel | 서버를 시작하고 도구를 내놓음 |
| `cli` | 23 | ast-grep, ripgrep, fd, ruff, gitleaks, osv-scanner, jadx, capa | 사용 가이드를 줌 (Claude가 셸로 사용) |
| `library` | 26 | phaser, threejs, konva, hono, zod, vitest, fastmcp, capstone | 무엇에 쓰고 어떻게 쓰는지 알려줌 |
| `skill` | 74 | writing-plans, level-design, unity-navmesh, security-and-hardening | 작업용 사본을 씀 |
| `rule` | 30 | rust, unity, godot-4-gdscript, cpp, vue, terraform | 작업용 사본을 씀 |
| `instruction` | 9 | ask-when-unclear, security-basics | 작업용 사본을 씀 |
| `subagent` | 31 | reverse-engineer, firmware-analyst, security-auditor | 작업용 사본을 씀 |

카탈로그에는 무료 오픈소스만 넣어요(MIT, Apache-2.0, BSD, ISC, CC0). 항목마다 출처 저장소에서 라이선스 파일과 고정 커밋을 확인했고, 사용 통계를 보내는 서버는 끄는 설정을 넣었어요. 새로 넣은 MCP 서버는 출처에서 실행 명령을 확인했지만 실제로 띄워 보지는 못해서, 항목마다 그 경고가 붙어 있어요.

내 부품은 JSON 파일로 추가해요.

```json
{
  "kind": "mcp",
  "name": "my-server",
  "summary": "What it is for, in one sentence",
  "tags": ["game"],
  "capabilities": ["scene", "build"],
  "config": { "command": "npx", "args": ["-y", "some-mcp-server"] },
  "source": { "repo": "owner/some-mcp-server", "commit": "<sha>" },
  "license": "MIT"
}
```

**레시피**: 잘 끝난 설계도를 다음에 비슷한 걸 만들 때 출발점으로 다시 써요.

- 설계도의 모든 단계가 끝나면 Claude가 "레시피로 저장할까요?" 하고 물어요. 좋다고 하면 `recipe_save`로 내 Encela 폴더(`~/.encela/recipes/`)에 저장돼요. 프로젝트 폴더에는 두지 않아요(받은 저장소가 "예전에 잘 됐던 것"인 척할 수 없게).
- 저장되는 것: 목표, 요구사항, 부품과 역할, 작업자, 단계, 파이프라인(단계 인자 포함), 선택지와 그때 고른 답, 그리고 "다음엔 이렇게" 메모. 저장되지 않는 것: 요청 원문, 승인 기록, 단계 진행 상태, 파이프라인 입력 기본값, 그 빌드에만 쓴 환경 변수 값. 저장할 때 무엇이 남는지 알려 주니, 키·비밀번호·개인 경로가 들어 있으면 빼고 다시 저장하세요.
- 이 컴퓨터에서 끝까지 만든 설계도만, 끝났을 때 그대로일 때만 레시피가 돼요.
- 다음에 비슷한 요청을 하면 `find_pieces` 결과와 프롬프트 안내에 맞는 레시피가 같이 나오고, Claude가 `recipe_get`으로 읽어 새 요청에 맞게 고친 설계도를 만들어요.
- 레시피에서 나온 설계도도 평소처럼 승인을 받아야 해요. 지난번에 고른 선택지는 "지난번: …"으로 보여 주고 다시 물어요.
- `encela recipes`로 목록을, `encela recipes remove <이름>`으로 삭제를 해요.

**GitHub 파인더**: 카탈로그에 없는 건 Claude가 GitHub에서 찾아요.

- `github_search`: 저장소 검색. 별, 라이선스, 마지막 푸시, 주의할 점(보관됨, 라이선스 없음, 오래 방치됨, 포크)을 같이 보여 줘요.
- `github_read`: 저장소(또는 그 안의 폴더·파일)를 특정 커밋에서 읽고 부품 초안을 만들어요. README의 `mcpServers` 예시, `package.json`·`pyproject.toml`, `SKILL.md`·`agents/`·규칙 파일을 보고 종류와 시작 명령을 추정하고, 무엇을 추정했는지 적어요. 문서 부품은 가장 가까운 LICENSE 파일로 라이선스를 판단하고, 스킬에 딸린 스크립트는 가져오지 않아요.
- 시작 명령이 가리키는 패키지는 npm·PyPI에서 확인해요: 실제로 게시됐는지, 그 패키지가 이 저장소를 출처로 적었는지(이름 사칭 방지), 설치 스크립트가 있는지. README가 "항상 최신"으로 받게 돼 있으면 읽은 시점의 버전으로 고정해요.
- 읽기만 해요. 요청은 GitHub API, GitHub의 raw 파일, npm·PyPI 레지스트리로 가는 GET뿐이고, 아무것도 복제·실행·저장하지 않아요. 저장소의 글은 Claude에게 "지시가 아닌 자료"로 표시해서 넘겨요.
- `piece_add`에 `github_read`가 준 `from`을 같이 넘기면, 출처·라이선스·경고·문서 본문은 Claude가 적은 것이 아니라 엔셀라가 그 커밋에서 다시 읽은 것으로 채워져요.
- 환경 변수 `GITHUB_TOKEN`(또는 `GH_TOKEN`)이 있으면 GitHub API 요청에만 붙여요(한도: 익명 시간당 60회 → 5,000회). 다른 곳으로 보내거나 저장하지 않아요.

**밖에서 가져온 부품**: Claude가 작업 중에 찾아 `piece_add`로 넣은 부품은 제한 없이 받되, 사용자가 그 부품이 든 설계도를 승인하기 전에는 실행되지 않아요. 승인 화면에 출처, 라이선스, 실행되는 명령, 필요한 환경 변수가 경고로 보여요. 모르는 MCP 서버를 실행하는 건 모르는 코드를 내 컴퓨터에서 실행하는 것이니 읽어 보고 승인하세요.

## 개발

```bash
pnpm lint        # Biome
pnpm typecheck
pnpm test        # 빌드 후 node --test
pnpm check:view  # 작업 화면을 Claude Code로 검사 (claude 명령이 있을 때만)
```

| 경로 | 내용 |
|---|---|
| `src/` | 부품·레지스트리·검색, GitHub 파인더, 레시피, 설계도·조립, 파이프라인(정의·엔진·jq·워커), MCP 서버와 허브, hook, 설치 |
| `plugin/` | 오케스트레이터 skill, 조립·파이프라인 서브에이전트, 작업 화면(`hooks/view.tsx`, `hooks/motion.tsx`, `hooks/model.ts`) |
| `catalog/` | 번들 부품과 라이선스 |
| `docs/` | 파이프라인 설계 문서 |

## 로드맵

1. [x] 부품, 레지스트리, 허브
2. [x] 설계도, 승인, 오케스트레이터 skill, hook
3. [x] 파이프라인 엔진: 부품의 출력을 다른 부품의 입력으로 서버 안에서 직접 넘김(도구·변환·Claude 단계)
4. [x] GitHub 파인더: 저장소를 찾아 읽고 부품 명세 초안 작성
5. [x] 레시피: 잘 된 설계도와 파이프라인을 저장하고 재사용

## 라이선스

[Apache-2.0](LICENSE). 번들한 서드파티 부품의 라이선스는 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)에 있어요.

이 프로젝트는 Anthropic과 관련이 없으며, 후원이나 보증을 받지 않아요. Claude는 Anthropic, PBC의 상표예요.
