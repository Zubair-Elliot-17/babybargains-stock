## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. Route only to skills in the session's available-skills list; answer directly for quick questions or small scoped edits.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Testing

- Unit/integration (vitest, real in-memory Mongo replica set): `npm test`
- Typecheck and lint: `npm run typecheck`, `npm run lint`
- E2E (Playwright): `npm run build && E2E_PROD=1 npm run test:e2e`. This is what CI runs. Under `next dev`
  (no `E2E_PROD`) the first run after file churn can loop on /login; use the production build for a clean signal.
