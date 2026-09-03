#!/bin/sh

set -eu

if [ "$#" -ne 2 ]; then
  echo '::error::native product-agent task failed; diagnostic arguments were invalid' >&2
  exit 0
fi

task_label="$1"
task_exit_code="$2"

case "$task_label" in
  preflight|dry-run-bootstrap|dry-run-rollback|apply|rollback) ;;
  *) task_label='unregistered' ;;
esac
case "$task_exit_code" in
  ''|*[!0-9]*) task_exit_code='unknown' ;;
esac

result_line=''
IFS= read -r result_line || true

if [ -z "$result_line" ]; then
  echo "::error::$task_label task exited $task_exit_code; result_present=no" >&2
  exit 0
fi

case "$result_line" in
  NATIVE_PRODUCT_AGENTS_RESULT=*)
    result_json=${result_line#NATIVE_PRODUCT_AGENTS_RESULT=}
    ;;
  *)
    echo "::error::$task_label task exited $task_exit_code; structured_result=invalid" >&2
    exit 0
    ;;
esac

safe_result=$(jq -cer '
  def valid_plan_sha:
    type == "string" and test("^[a-f0-9]{64}$");
  def valid_code:
    type == "string" and test("^[a-z][a-z0-9_]{0,63}$");
  def valid_plan:
    (
      (keys | sort) == ["direction","mode","planSha256"] or
      (keys | sort) == ["direction","mode","planSha256","serviceCredentialState"]
    ) and
    (.mode == "dry-run" or .mode == "apply") and
    (.direction == "bootstrap" or .direction == "rollback") and
    (.planSha256 | valid_plan_sha) and
    (
      (has("serviceCredentialState") | not) or
      (
        .serviceCredentialState | type == "object" and
        (keys | sort) == ["clarityBackendExists","homiioSindiExists"] and
        (.clarityBackendExists | type == "boolean") and
        (.homiioSindiExists | type == "boolean")
      )
    );
  if type != "object" then
    empty
  elif
    (keys | sort) == ["code","status"] and
    .status == "failed" and
    (.code | valid_code)
  then
    {code}
  elif
    (keys | sort) == ["code","planSha256","status"] and
    .status == "failed" and
    (.code | valid_code) and
    (.planSha256 | valid_plan_sha)
  then
    {code,planSha256}
  elif valid_plan then
    {code:"task_exited_after_valid_plan",planSha256}
  else
    empty
  end
' <<EOF 2>/dev/null || true
$result_json
EOF
)

if [ -z "$safe_result" ]; then
  echo "::error::$task_label task exited $task_exit_code; structured_result=invalid" >&2
  exit 0
fi

echo "::error::$task_label task exited $task_exit_code; structured_result=$safe_result" >&2
