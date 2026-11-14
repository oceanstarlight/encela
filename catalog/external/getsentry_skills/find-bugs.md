---
kind: skill
title: 브랜치 버그 사냥
title_en: Branch Bug Hunt
summary: 브랜치 전체 diff를 읽고 공격 표면과 보안 체크리스트를 따라 검증된 문제만 보고하게 해요
summary_en: Makes Claude read the whole branch diff, map the attack surface, run a security checklist and report only verified issues.
detail: 현재 브랜치의 버그와 취약점을 검토하거나 감사할 때 쓰는 스킬이에요. diff 전체 수집, 파일별 공격 표면 정리, 결론 전 점검, 심각도별 보고 형식을 다뤄요.
detail_en: Applies when asked to review or audit the current branch for bugs and vulnerabilities. Covers full input gathering, per-file attack surface listing, a pre-conclusion audit and a severity-ranked findings format.
category: 리뷰
category_en: Review
name: find-bugs
description: "Find bugs, security vulnerabilities, and code quality issues in local branch changes. Use when asked to review changes, find bugs, security review, or audit code on the current branch."
license: Apache-2.0
copyright: "Copyright 2025 Functional Software, Inc. dba Sentry"
source_repo: getsentry/skills
source_commit: e94f22214528d69899d09c627b3315ddc3544816
source_path: skills/find-bugs/SKILL.md
license_path: LICENSE
---
# Find Bugs

Review changes on this branch for bugs, security vulnerabilities, and code quality issues.

## Phase 1: Complete Input Gathering

1. Get the FULL diff: `git diff $(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')...HEAD`
2. If output is truncated, read each changed file individually until you have seen every changed line
3. List all files modified in this branch before proceeding

## Phase 2: Attack Surface Mapping

For each changed file, identify and list:

* All user inputs (request params, headers, body, URL components)
* All database queries
* All authentication/authorization checks
* All session/state operations
* All external calls
* All cryptographic operations

## Phase 3: Security Checklist (check EVERY item for EVERY file)

* [ ] **Injection**: SQL, command, template, header injection
* [ ] **XSS**: All outputs in templates properly escaped?
* [ ] **Authentication**: Auth checks on all protected operations?
* [ ] **Authorization/IDOR**: Access control verified, not just auth?
* [ ] **CSRF**: State-changing operations protected?
* [ ] **Race conditions**: TOCTOU in any read-then-write patterns?
* [ ] **Session**: Fixation, expiration, secure flags?
* [ ] **Cryptography**: Secure random, proper algorithms, no secrets in logs?
* [ ] **Information disclosure**: Error messages, logs, timing attacks?
* [ ] **DoS**: Unbounded operations, missing rate limits, resource exhaustion?
* [ ] **Business logic**: Edge cases, state machine violations, numeric overflow?

## Phase 4: Verification

For each potential issue:

* Check if it's already handled elsewhere in the changed code
* Search for existing tests covering the scenario
* Read surrounding context to verify the issue is real

## Phase 5: Pre-Conclusion Audit

Before finalizing, you MUST:

1. List every file you reviewed and confirm you read it completely
2. List every checklist item and note whether you found issues or confirmed it's clean
3. List any areas you could NOT fully verify and why
4. Only then provide your final findings

## Output Format

**Prioritize**: security vulnerabilities > bugs > code quality

**Skip**: stylistic/formatting issues

For each issue:

* **File:Line** - Brief description
* **Severity**: Critical/High/Medium/Low
* **Problem**: What's wrong
* **Evidence**: Why this is real (not already fixed, no existing test, etc.)
* **Fix**: Concrete suggestion
* **References**: OWASP, RFCs, or other standards if applicable

If you find nothing significant, say so - don't invent issues.

Do not make changes - just report findings. I'll decide what to address.
