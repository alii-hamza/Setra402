# Token Conservation Rules
1. Never run commands that produce infinite or verbose output (e.g. raw cargo check or anchor test without filtering).
2. When referencing context, read ONLY:
   - `AGENT.md`
   - `STATE.md`
   - `ORCHESTRATOR.md`
3. Never scan node_modules, target/, or hidden directories.
4. Keep all responses brief. Write code to files directly; do not narrate explanations.