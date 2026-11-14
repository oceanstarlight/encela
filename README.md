# Encela (엔셀라)

**요청 한 번이면 Claude가 설계도를 쓰고, 필요한 부품을 골라 조립해서 만들어요.**

엔셀라는 Claude Code용 MCP 서버와 플러그인이에요. 부품(MCP 서버, CLI, skill, rule, 지침, subagent)을 레고 블록처럼 갖고 있다가, 요청이 들어오면 Claude가 설계도를 그리고 사용자가 승인한 부품만 조립해요.

> 개발 초기 단계예요. 지금은 1~2단계(부품·허브, 설계도·승인·오케스트레이터)까지 있어요. [로드맵](#로드맵)

## 어떻게 동작하나요

| 레고에 비유하면 | 엔셀라에서는 |
|---|---|
| 만들고 싶은 것 (자동차) | 사용자의 프롬프트 |
| 설계도 | Claude가 쓰는 **blueprint** |
| 부품 | **piece**: 카탈로그 127개, 직접 추가한 것, 밖에서 찾은 것 |
| 조립하는 사람 | Claude(오케스트레이터)와 서브에이전트(작업자) |
| 어떤 부품을 붙일지 | 사용자가 설계도를 승인하거나 고쳐요 |

```
프롬프트
  └ hook이 "설계도부터"라는 안내를 붙임
① 분석      목표, 요구사항, 사용자가 정할 것
② 부품 찾기  find_pieces → get_piece (없으면 밖에서 찾아 piece_add)
③ 설계도    blueprint_save: 부품과 역할, 작업자, 단계, 선택지
④ 승인      blueprint_approve: 승인 / 수정 / 취소
⑤ 조립      blueprint_assemble: MCP 부품 시작, 문서 부품 작업용 사본, 작업자별 지시서
⑥ 만들기    단계별로 진행(blueprint_step), 독립된 단계는 서브에이전트로 동시에
```

- **오케스트레이터는 사용자의 Claude Code 세션**이에요. 엔셀라는 모델을 부르지 않아서 추가 비용이 없어요.
- **승인 전에는 아무것도 실행하지 않아요.** 서버가 막아요. Claude Code가 지원하면 승인 질문을 엔셀라가 사용자에게 직접 띄워요.
- **MCP 부품은 필요할 때만 시작해요.** 도구는 `<부품>__<도구>` 이름으로 나타나고, 설계도에서 쓸 도구를 제한할 수 있어요. 마지막 단계가 끝나면 멈춰요.
- **문서 부품은 사본을 고쳐 써요.** `.encela/build/<설계도>/` 아래 사본을 이번 작업에 맞게 고치고(`encela:assembler` 서브에이전트), 원본 부품은 바꾸지 않아요. 사본에는 출처와 라이선스가 남아요.

## 설치

Node.js 20 이상과 [Claude Code](https://docs.claude.com/en/docs/claude-code)가 필요해요. 아직 npm에 올리지 않아서 소스에서 설치해요.

```bash
pnpm install
pnpm build
node dist/cli.js setup     # 플러그인을 ~/.encela/claude-plugin 에 쓰고 내 claude로 설치
```

그다음 Claude Code를 새로 시작하고 평소처럼 요청을 쓰면 돼요. `/encela:go <요청>`은 작은 요청에도 같은 흐름을 강제해요.

| 명령 | 하는 일 |
|---|---|
| `encela setup [--no-auto] [--no-claude]` | 플러그인 설치. `--no-auto`는 프롬프트마다 붙는 안내를 끔 |
| `encela status` | 부품 수와 저장 위치 |
| `encela pieces [단어…] [--kind <종류>]` | 부품 목록·검색 |
| `encela add <file.json>` / `encela remove <id>` | 내 부품 추가·삭제 |
| `encela import [mcp-hub.json]` | 예전 엔셀라(앱, npm 0.1.x)의 모듈 가져오기 |
| `encela uninstall` | 플러그인 제거(내 부품은 남음) |

환경 변수: `ENCELA_HOME`(기본 `~/.encela`), `ENCELA_AUTO=0`(안내 끄기), `ENCELA_LANG`.

## 부품

모든 부품은 같은 모양이에요: 종류, 이름, 요약, 태그, 할 수 있는 것, 받는 것·내놓는 것, 출처·커밋·라이선스, 경고. 종류에 따라 MCP 서버 설정, 사용 가이드, 문서 본문이 더 붙어요.

| 종류 | 예 | 조립하면 |
|---|---|---|
| `mcp` | repomix, mcp-mermaid, ghidra | 서버를 시작하고 도구를 내놓음 |
| `cli`, `library` | ast-grep, mermaid-cli | 사용 가이드를 줌 (Claude가 Bash·코드로 사용) |
| `skill`, `rule`, `instruction`, `subagent` | writing-plans, rust, security-auditor | 작업용 사본을 씀 |

내 부품은 JSON 파일로 추가해요.

```json
{
  "kind": "mcp",
  "name": "unity",
  "summary": "Controls the Unity editor: scenes, objects, scripts",
  "tags": ["unity", "game"],
  "capabilities": ["scene", "build"],
  "inputs": ["text"],
  "outputs": ["scene"],
  "config": { "command": "npx", "args": ["-y", "some-unity-mcp"] },
  "source": { "repo": "owner/some-unity-mcp", "commit": "<sha>" },
  "license": "MIT"
}
```

**밖에서 가져온 부품**: Claude가 작업 중에 찾아 `piece_add`로 넣은 부품은 제한 없이 받되, 사용자가 그 부품이 든 설계도를 승인하기 전에는 실행되지 않아요. 승인 화면에 출처, 라이선스, 실행되는 명령, 필요한 환경 변수가 경고로 보여요. 모르는 MCP 서버를 실행하는 건 모르는 코드를 내 컴퓨터에서 실행하는 것이니 읽어 보고 승인하세요.

## 개발

```bash
pnpm lint        # Biome
pnpm typecheck
pnpm test        # 빌드 후 node --test
```

| 경로 | 내용 |
|---|---|
| `src/` | 부품·레지스트리·검색, 설계도·조립, MCP 서버와 허브, hook, 설치 |
| `plugin/` | 오케스트레이터 skill, 조립 서브에이전트 |
| `catalog/` | 번들 부품과 라이선스 |

## 로드맵

1. [x] 부품, 레지스트리, 허브
2. [x] 설계도, 승인, 오케스트레이터 skill, hook
3. [ ] 파이프라인 엔진: 부품의 출력을 다른 부품의 입력으로 서버 안에서 직접 넘김(도구·변환·Claude 단계)
4. [ ] GitHub 파인더: 저장소를 찾아 읽고 부품 명세 초안 작성
5. [ ] 레시피: 잘 된 설계도를 저장하고 재사용

## 라이선스

[Apache-2.0](LICENSE). 번들한 서드파티 부품의 라이선스는 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)에 있어요.

이 프로젝트는 Anthropic과 관련이 없으며, 후원이나 보증을 받지 않아요. Claude는 Anthropic, PBC의 상표예요.
