#!/usr/bin/env bash
# Local equivalent of the CI check (kept outside .github/workflows/ so the repo can be
# pushed with an OAuth token that has no `workflow` scope).
#
#   bash scripts/ci-check.sh
#
# Exits non-zero when preset/agent.cordis.yml or the bundled reference copy is not
# reproducible from base/ + prompt/.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

echo "== build =="
node scripts/build.mjs
node scripts/build-reference.mjs

echo "== reproducibility (git diff --exit-code) =="
for artifact in preset/agent.cordis.yml preset/skills/claude-opus-5-5-provenance/reference/Claude-Opus-5.5.md; do
  if ! git diff --quiet -- "$artifact"; then
    echo "$artifact is stale: re-run scripts/build.mjs / scripts/build-reference.mjs and commit the result" >&2
    git --no-pager diff --stat -- "$artifact" >&2
    exit 1
  fi
done

echo "== only registered prompt variables =="
node -e '
import("./lib/persona.mjs").then(async (persona) => {
  const promptDir = "prompt";
  // The whole persona, every segment: a variable nobody registers fails every
  // turn rather than degrading, so scan all of it.
  const text = await persona.readPersona(promptDir);
  const unknown = persona.unregisteredVariables(text);
  if (unknown.length > 0) {
    console.error("unregistered prompt variables: " + unknown.join(", "));
    process.exit(1);
  }
  if (persona.hasMalformedVariables(text)) {
    console.error("unbalanced or malformed double-brace group");
    process.exit(1);
  }
  const used = [...new Set(persona.promptVariables(text))];
  console.log("ok: only registered prompt variables" + (used.length ? " (" + used.join(", ") + ")" : ""));
});
'

echo "== composition structure =="
node scripts/check.mjs

echo "== upstream drift =="
# check.mjs compares base/ against the live `standard` preset when given a
# --dump-config capture. It is advisory, so a missing capture is not a failure —
# but a present one must come back clean, or base/ is stale.
if [ -n "${DSH_DUMP:-}" ]; then
  DSH_DUMP="$DSH_DUMP" node scripts/check.mjs
else
  echo "skipped: no DSH_DUMP. To compare base/ against the live preset, run:"
  echo "  dsh --profile web --dump-config > /tmp/dump.txt"
  echo "  DSH_DUMP=/tmp/dump.txt bash scripts/ci-check.sh"
fi

echo "== bundle plugin =="
node scripts/check-plugin.mjs

echo
echo "all checks passed"
