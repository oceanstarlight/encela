---
kind: skill
title: 프롬프트 최적화
title_en: Prompt Optimizer
summary: 목표를 정리하고 계층을 나눠 평가셋으로 비교하며 에이전트 프롬프트를 다듬게 해요
summary_en: Makes Claude write and refine agent prompts with a captured contract, layered structure, an eval set and logged candidate rounds.
detail: 시스템·에이전트 프롬프트를 새로 쓰거나 개선하고 모델 계열 간에 옮길 때 쓰는 스킬이에요. 외부 파일 목록, 도구 정책 위치, 홀드아웃 최적화 루프, 모델 계열별 메모를 다뤄요.
detail_en: Applies when writing or improving system prompts, agent prompts or templates, or porting them between model families. Covers context inventories, tool-policy placement, an optimization loop with holdouts, and model-family notes.
category: AI
category_en: AI
name: prompt-optimizer
description: "Creates, optimizes, and iteratively refines agent prompts, system prompts, developer prompts, and reusable prompt templates. Use when asked to improve a prompt, optimize a system prompt, rewrite an agent prompt, tune prompt wording, make a prompt more reliable, port prompts between OpenAI, Claude, or Gemini, or build prompt evals."
license: Apache-2.0
copyright: "Copyright 2025 Functional Software, Inc. dba Sentry"
source_repo: getsentry/skills
source_commit: e94f22214528d69899d09c627b3315ddc3544816
source_path: skills/prompt-optimizer/SKILL.md
license_path: LICENSE
---
# Prompt Optimizer

Optimize prompts with evals. Keep every instruction, example, and external context reference causal.

## Load Only What You Need

| Need | Read |
|------|------|
| New prompt | `references/core-patterns.md`, `references/model-family-notes.md`, `references/transformed-examples.md` |
| Existing prompt | `references/meta-optimization-loop.md`, `references/core-patterns.md`, `references/model-family-notes.md` |
| Model-family port | `references/model-family-notes.md`, `references/core-patterns.md` |
| Repeated failures | `references/meta-optimization-loop.md`, `references/core-patterns.md` |
| Weak or ambiguous draft | `references/transformed-examples.md` |
| Provenance | `SOURCES.md` |

## Step 1: Capture Contract

Record before editing:

- task type: new, refine, port, or debug
- target model family and snapshot, if known
- prompt surface: `system`, `developer`, `user`, tool descriptions, examples, schemas
- layer owners: platform, deployer/persona, retrieved context, user payload
- objective and non-goals
- inputs, tools, and external files available
- required output shape
- success criteria and failure cases
- hard constraints: latency, verbosity, safety, budget, tool use, style

If success criteria or examples are missing, create a small eval set first.
If the bottleneck is model choice, retrieval, tool schema, or missing evals, say so before rewriting.

## Step 2: Inventory External Context

For repo or agent prompts, list stable context by exact path:

| Context type | Examples |
|--------------|----------|
| Agent rules | `AGENTS.md`, `CLAUDE.md` |
| Specs | `specs/*.md`, `docs/api.md` |
| Policies | `SECURITY.md`, `docs/releasing.md` |
| Examples | `examples/`, `tests/fixtures/` |

Rules:

- Reference stable files by repo-relative path instead of copying them.
- Paste only excerpts needed for the prompt or eval case.
- Mark whether a file is `loaded`, `referenced`, or `out of scope`.
- Avoid vague context pointers such as "read the docs".

## Step 3: Choose Model Strategy

Read `references/model-family-notes.md`.

- Known family: optimize for that family.
- Unknown family: write a portable base plus short adapter notes.
- Snapshot changes: rerun evals.
- Cross-family divergence: specialize only the failing layer.

## Step 4: Shape Prompt

Read `references/core-patterns.md`.

- Put stable policy in `system` or `developer`.
- Put task-local facts, retrieved context, and variables in user-facing sections.
- Keep one owner per behavior rule.
- Use headings or tags only to separate content types.
- Put tool policy in prompt text; keep schemas in provider-native tools.
- Keep persona light unless it changes behavior.
- Use the shortest wording that preserves the constraint.
- Cut filler, repeated reminders, dead examples, and rationale that does not affect evals.

## Step 5: Optimize

Read `references/meta-optimization-loop.md` for refinements.

1. Baseline the current prompt on the same eval slice.
2. Cluster failures by root cause.
3. Write concrete edit criticisms.
4. Generate two to four candidates:
   - minimal-diff repair
   - structure-first rewrite
   - examples-first or tool-rule variant
   - provider adapter when needed
5. Compare candidates on the same cases.
6. Keep a short optimization log.
7. Validate the winner on holdout cases.
8. Stop on plateau, oscillation, overfit, excessive cost, or non-prompt bottleneck.

## Step 6: Return Package

Return:

1. `Target`
2. `Success Criteria`
3. `External Context`
4. `Optimized Prompt`
5. `Adapter Notes`
6. `Eval Set`
7. `Optimization Log`
8. `Residual Risks`

For existing prompts, include a concise diff-style note of the main behavioral changes.

## Failure Modes

- editing before defining the eval target
- mixing policy, examples, and raw context without boundaries
- duplicating rules across layers
- putting durable policy in user payloads
- asking for chain-of-thought
- keeping contradictory legacy instructions
- overfitting to one or two examples
- retaining examples that no longer improve evals
- fixing tool-use failures only in prompt text when tool descriptions or schemas are weak
- adding markup that does not reduce ambiguity
- using persona as a substitute for behavior rules
