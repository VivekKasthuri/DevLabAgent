# Project Evaluation Rubric

_Generated: 2026-07-08T17:15:38.119Z_

**Scoring:** 1-4 per criterion, weighted — passing ≥ 2.8/4

| # | Criterion | Weight | Description |
|---|-----------|--------|-------------|
| 1 | Code Quality | 20% | Readability, naming, structure, idiomatic use of the language/framework |
| 2 | Architecture & Design | 20% | Separation of concerns, dependency direction, framework conventions followed |
| 3 | Testing | 20% | Coverage, quality, and reliability of automated tests |
| 4 | Security | 15% | No secrets in code, input validation, safe dependency usage |
| 5 | Documentation | 10% | README, API docs, inline comments where needed |
| 6 | CI/CD & Tooling | 10% | Automated builds, tests, and release processes |
| 7 | Performance | 5% | Efficient algorithms, no obvious bottlenecks, resource usage |

## Criteria Detail

### Code Quality (20%)

Readability, naming, structure, idiomatic use of the language/framework

**Checks:**
- [ ] Consistent naming and formatting
- [ ] No dead/duplicated code
- [ ] Functions small and single-purpose
- [ ] Linting passes clean

| Level | Points | Meaning |
|-------|--------|---------|
| excellent | 4 | Exceeds expectations; exemplary, no issues found |
| good | 3 | Meets expectations; minor improvements possible |
| fair | 2 | Partially meets expectations; notable gaps |
| poor | 1 | Does not meet expectations; must be addressed |

### Architecture & Design (20%)

Separation of concerns, dependency direction, framework conventions followed

**Checks:**
- [ ] Clear module boundaries
- [ ] Dependency injection where appropriate
- [ ] No circular dependencies
- [ ] Follows framework conventions

| Level | Points | Meaning |
|-------|--------|---------|
| excellent | 4 | Exceeds expectations; exemplary, no issues found |
| good | 3 | Meets expectations; minor improvements possible |
| fair | 2 | Partially meets expectations; notable gaps |
| poor | 1 | Does not meet expectations; must be addressed |

### Testing (20%)

Coverage, quality, and reliability of automated tests

**Checks:**
- [ ] Unit tests for core logic
- [ ] Integration tests for critical flows
- [ ] Tests run in CI
- [ ] Edge cases covered

| Level | Points | Meaning |
|-------|--------|---------|
| excellent | 4 | Exceeds expectations; exemplary, no issues found |
| good | 3 | Meets expectations; minor improvements possible |
| fair | 2 | Partially meets expectations; notable gaps |
| poor | 1 | Does not meet expectations; must be addressed |

### Security (15%)

No secrets in code, input validation, safe dependency usage

**Checks:**
- [ ] No hardcoded credentials
- [ ] Inputs validated/sanitized
- [ ] Dependencies free of known CVEs
- [ ] Sensitive data handled correctly

| Level | Points | Meaning |
|-------|--------|---------|
| excellent | 4 | Exceeds expectations; exemplary, no issues found |
| good | 3 | Meets expectations; minor improvements possible |
| fair | 2 | Partially meets expectations; notable gaps |
| poor | 1 | Does not meet expectations; must be addressed |

### Documentation (10%)

README, API docs, inline comments where needed

**Checks:**
- [ ] README with setup instructions
- [ ] Public APIs documented
- [ ] Architecture decisions recorded

| Level | Points | Meaning |
|-------|--------|---------|
| excellent | 4 | Exceeds expectations; exemplary, no issues found |
| good | 3 | Meets expectations; minor improvements possible |
| fair | 2 | Partially meets expectations; notable gaps |
| poor | 1 | Does not meet expectations; must be addressed |

### CI/CD & Tooling (10%)

Automated builds, tests, and release processes

**Checks:**
- [ ] CI pipeline builds and tests every change
- [ ] Reproducible builds
- [ ] Automated release/versioning

| Level | Points | Meaning |
|-------|--------|---------|
| excellent | 4 | Exceeds expectations; exemplary, no issues found |
| good | 3 | Meets expectations; minor improvements possible |
| fair | 2 | Partially meets expectations; notable gaps |
| poor | 1 | Does not meet expectations; must be addressed |

### Performance (5%)

Efficient algorithms, no obvious bottlenecks, resource usage

**Checks:**
- [ ] No N+1 or unbounded loops on hot paths
- [ ] Async/non-blocking where appropriate
- [ ] Reasonable bundle/binary size

| Level | Points | Meaning |
|-------|--------|---------|
| excellent | 4 | Exceeds expectations; exemplary, no issues found |
| good | 3 | Meets expectations; minor improvements possible |
| fair | 2 | Partially meets expectations; notable gaps |
| poor | 1 | Does not meet expectations; must be addressed |
