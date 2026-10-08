SETRA402 FRONTEND GUIDED REVAMP

Scope: frontend/src/App.tsx and frontend/styles.css. Backend, Rust Seller,
Redis, Anchor program, and API contracts are unchanged.

Workflow:
1. Tasks -> Start guided demo.
2. Choose Successful demo / Failure demo (lead-scraper-demo fixture), or Custom.
3. Prepare payment quote. Modal closes and displays quote authorization on Tasks.
4. Review base-unit amount and click Authorize funding & execute.
5. Frontend funds once, checks status, executes once, and displays result.
6. Failed verification retains escrow until refund becomes available.

Safety:
- No automatic retries on ambiguous write outcomes.
- Manual fund/run controls retained behind Advanced toggle.
- No new backend API required.
- This patch is not runtime-tested against your live WSL services.
- State remains session-scoped; persistence across reload is not solved.
- Demo presets require lead-scraper-demo.

Apply from repo root (after backup):
  tar -xzf /path/to/setra402-frontend-revamp.tar.gz
  cd frontend && npm run build
  mkdir -p /tmp/frontend/dist
  cp -a dist/. /tmp/frontend/dist/

The archive includes only frontend/src and frontend/styles.css.
