# shellcheck shell=bash
# Shared quota-axi compatibility floor for the bootstrap diagnostic.
# Usage: . bin/fm-quota-axi-lib.sh
#
# FM_QUOTA_AXI_MIN follows the axi-family floor policy owned beside the floor
# constants in bin/fm-bootstrap.sh.
#
# This file is the single owner of that version number. bin/fm-bootstrap.sh
# turns a failing check into the operator-facing MISSING diagnostic, which is
# what keeps an older build from reaching a dispatch intake at all.

FM_QUOTA_AXI_MIN=0.1.29

fm_quota_axi_compatible() {
  local timeout=${1:-} output parts major minor patch extra
  local min_major min_minor min_patch min_extra
  command -v quota-axi >/dev/null 2>&1 || return 1
  if [ -n "$timeout" ]; then
    case "$timeout" in
      ''|*[!0-9]*|0) return 1 ;;
    esac
    [ "$(type -t fm_run_timed)" = function ] || return 1
    output=$(fm_run_timed "$timeout" quota-axi --version 2>/dev/null </dev/null) || return 1
  else
    output=$(quota-axi --version 2>/dev/null </dev/null) || return 1
  fi
  parts=$(printf '%s\n' "$output" |
    sed -n 's/.*\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2 \3/p' |
    head -1)
  IFS=' ' read -r major minor patch extra <<< "$parts"
  # An unparseable version is incompatible, never assumed current, so a
  # development or vendored build cannot pass a floor it was never checked against.
  [ -n "$major" ] && [ -n "$minor" ] && [ -n "$patch" ] && [ -z "$extra" ] || return 1
  # The floor is compared from FM_QUOTA_AXI_MIN so bumping it needs one edit.
  IFS='.' read -r min_major min_minor min_patch min_extra <<< "$FM_QUOTA_AXI_MIN"
  [ -n "$min_major" ] && [ -n "$min_minor" ] && [ -n "$min_patch" ] && [ -z "$min_extra" ] || return 1
  [ "$major" -gt "$min_major" ] && return 0
  [ "$major" -eq "$min_major" ] || return 1
  [ "$minor" -gt "$min_minor" ] && return 0
  [ "$minor" -eq "$min_minor" ] || return 1
  [ "$patch" -ge "$min_patch" ]
}

fm_quota_json_valid() {
  jq -se '
    length == 1 and
    (.[0] | type) == "object" and
    (.[0] |
      .schemaVersion == 5 and
      (.providers | type) == "array" and
      (([.providers[].provider] | length) == ([.providers[].provider] | unique | length)) and
      all(.providers[];
      (.provider | type) == "string" and
      (.provider | test("^[a-z0-9]+(-[a-z0-9]+)*$")) and
      (.quotaSemantics | type) == "object" and
      (.quotaSemantics.status as $semantics_status |
        (["known", "partial", "unknown"] | index($semantics_status)) != null and
        (.quotaSemantics.effectiveAvailability | type) == "array" and
        (if $semantics_status == "known" then
           ((.quotaSemantics.effectiveAvailability | length) > 0 and
            all(.quotaSemantics.effectiveAvailability[];
              .status == "known" or .status == "unknown"
            ))
         elif $semantics_status == "unknown" then
           all(.quotaSemantics.effectiveAvailability[]; .status == "unknown")
         else true
         end) and
        all(.quotaSemantics.effectiveAvailability[];
          type == "object" and
          (.scope | type) == "string" and
          (.scope | length) > 0 and
          ((.scope | test("^\\s|\\s$")) | not) and
          ((.status == "known" and
            (.runway.status as $runway_status |
            ((.effectivePercentRemaining | type) == "number" and
             .effectivePercentRemaining >= 0 and
             .effectivePercentRemaining <= 100 and
             (.runway | type) == "object" and
             ($runway_status | type) == "string" and
             (["through_reset", "projected_exhaustion", "exhausted_now", "unknown"] |
               index($runway_status)) != null))) or
           (.status == "unknown" and
            (has("effectivePercentRemaining") | not) and
            ((has("runway") | not) or
             ((.runway | type) == "object" and
              (.runway.status as $unknown_runway_status |
               (["unknown", "exhausted_now"] | index($unknown_runway_status)) != null)))))
        )
      )
    )
    )
  ' >/dev/null 2>&1
}

fm_quota_single_provider_table() {
  printf '%s\n' \
    'claude claude' \
    'codex codex' \
    'grok grok' \
    'kimi kimi' \
    'cursor cursor' \
    'agy agy' \
    'muse meta'
}

fm_quota_single_provider_for_harness() {
  local harness provider
  while read -r harness provider; do
    if [ "$harness" = "$1" ]; then
      printf '%s\n' "$provider"
      return 0
    fi
  done < <(fm_quota_single_provider_table)
  return 1
}

# fm_quota_provider_for_harness <harness> [<model>]
# Map a firstmate harness name to its primary quota-axi provider family, the
# single owner of that table for bin/fm-quota-choose.sh and
# bin/fm-dispatch-resolve.sh. Multi-provider harnesses (Pi, OpenCode) map to
# their primary family only for callers that permit that policy;
# fm-dispatch-resolve.sh uses fm_quota_single_provider_for_harness and requires
# every other profile to declare `provider` explicitly (docs/configuration.md
# "Crew dispatch profiles"). omp is keyed on the candidate model prefix and
# has no family for any other prefix. Prints nothing and returns 1 when no
# family is known. Authoritative multi-provider routing stays owned by
# AGENTS.md section 4 and the quota-array-dispatch skill; this table never
# infers a family from a model name.
fm_quota_provider_for_harness() {
  fm_quota_single_provider_for_harness "$1" && return 0
  case "$1" in
    omp)
      case "${2:-}" in
        openai-codex/*)  printf 'codex\n' ;;
        claude-bridge/*) printf 'claude\n' ;;
        *)               return 1 ;;
      esac
      ;;
    opencode)     printf 'codex\n' ;;
    pi|pi-signed) printf 'pi\n' ;;
    *)            return 1 ;;
  esac
}
